import React, { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { RouteData } from '../types';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

interface AssignDistributorProps {
  routes: RouteData;
  onAssign: (code: string) => void;
}

const AssignDistributor: React.FC<AssignDistributorProps> = ({ routes, onAssign }) => {
  const [distributorCode, setDistributorCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [importStats, setImportStats] = useState<{total: number, processed: number}>({ total: 0, processed: 0 });

  const calculateHaversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const calculateTravelTime = (distance: number, speedKmPerHour: number = 30): number => {
    return (distance / speedKmPerHour) * 60; // Convert to minutes
  };

  const createDistributorTable = async (distributorCode: string): Promise<boolean> => {
    try {
      console.log(`Creating distributor table for: ${distributorCode}`);
      
      // Call the function to create the distributor-specific table
      const { data, error } = await supabase.rpc('create_distributor_table', {
        dist_code: distributorCode
      });

      if (error) {
        console.error('Error creating distributor table:', error);
        throw new Error(`Failed to create distributor table: ${error.message}`);
      }

      console.log('Distributor table creation result:', data);
      return data === true;
    } catch (error) {
      console.error('Error in createDistributorTable:', error);
      throw error;
    }
  };

  const insertIntoDistributorTable = async (distributorCode: string, routeData: any[]): Promise<void> => {
    // Sanitize distributor code for table name
    const tableName = `distributor_routes_${distributorCode.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
    
    console.log(`Inserting data into table: ${tableName}`);
    
    // Process in smaller batches
    const batchSize = 50;
    let processedCount = 0;
    let successfulInserts = 0;

    for (let i = 0; i < routeData.length; i += batchSize) {
      const batch = routeData.slice(i, Math.min(i + batchSize, routeData.length));
      const batchNumber = Math.floor(i/batchSize) + 1;
      const totalBatches = Math.ceil(routeData.length/batchSize);
      
      console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} records) for table ${tableName}`);
      
      try {
        // Use direct table insert since we can't use dynamic SQL
        const { data, error: insertError } = await supabase
          .from(tableName)
          .insert(batch)
          .select('id');

        if (insertError) {
          console.error(`Batch ${batchNumber} failed for ${tableName}:`, insertError);
          
          // If table doesn't exist, try to insert into main table as fallback
          if (insertError.code === '42P01') { // Table doesn't exist
            console.log('Table does not exist, falling back to main distributor_routes table');
            const { data: fallbackData, error: fallbackError } = await supabase
              .from('distributor_routes')
              .insert(batch)
              .select('id');
              
            if (fallbackError) {
              throw new Error(`Fallback insert failed: ${fallbackError.message}`);
            }
            
            successfulInserts += fallbackData?.length || batch.length;
          } else {
            throw new Error(`Batch ${batchNumber} failed: ${insertError.message}`);
          }
        } else {
          successfulInserts += data?.length || batch.length;
        }

        processedCount += batch.length;
        
        setImportStats(prev => ({
          ...prev,
          processed: processedCount
        }));

        console.log(`Batch ${batchNumber} completed successfully: ${data?.length || batch.length} records inserted into ${tableName}`);

      } catch (batchError) {
        console.error(`Error processing batch ${batchNumber} for ${tableName}:`, batchError);
        throw new Error(`Failed to insert batch ${batchNumber}: ${batchError instanceof Error ? batchError.message : 'Unknown error'}`);
      }

      // Add small delay between batches to prevent rate limiting
      if (i + batchSize < routeData.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`Successfully inserted ${successfulInserts} records into ${tableName}`);
  };

  const handleAssign = async () => {
    if (!distributorCode.trim()) {
      setError('Please enter a distributor code');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Calculate total records to process
      const totalRecords = routes.reduce((acc, route) => acc + route.stops.length + 1, 0); // +1 for distributor point
      setImportStats({ total: totalRecords, processed: 0 });
      console.log(`Starting import of ${totalRecords} records for distributor: ${distributorCode}`);

      // Step 1: Create distributor-specific table
      console.log('Creating distributor-specific table...');
      const tableCreated = await createDistributorTable(distributorCode);
      
      if (!tableCreated) {
        console.warn('Failed to create distributor table, will use main table as fallback');
      }

      // Step 2: Delete existing routes for this distributor from main table
      console.log('Deleting existing routes from main table...');
      const { error: deleteError } = await supabase
        .from('distributor_routes')
        .delete()
        .eq('distributor_code', distributorCode);

      if (deleteError) {
        console.error('Delete error:', deleteError);
        throw new Error(`Failed to delete existing routes: ${deleteError.message}`);
      }

      // Step 3: Prepare all route data with proper structure and data types
      const routeData = [];
      
      for (const route of routes) {
        // Add distributor point as stop 0
        const firstStopDistance = route.stops.length > 0 ? 
          calculateHaversineDistance(
            route.distributorLat || 0,
            route.distributorLng || 0,
            route.stops[0].latitude,
            route.stops[0].longitude
          ) : 0;
        
        const firstStopTime = calculateTravelTime(firstStopDistance);

        routeData.push({
          distributor_code: distributorCode,
          beat: Math.round(Number(route.salesmanId) || 1),
          stop_order: 0,
          dms_customer_id: 'DISTRIBUTOR',
          outlet_name: 'DISTRIBUTOR',
          latitude: Number(route.distributorLat) || 0,
          longitude: Number(route.distributorLng) || 0,
          distance_to_next: Number(firstStopDistance.toFixed(2)) || 0,
          time_to_next: Math.round(Number(firstStopTime) || 0),
          cluster_id: route.stops.length > 0 ? Math.round(Number(route.stops[0]?.clusterId) || 0) : 0,
          is_being_audited: false
        });

        // Add all customer stops
        route.stops.forEach((stop, index) => {
          let distanceToNext = 0;
          let timeToNext = 0;
          
          if (index < route.stops.length - 1) {
            const nextStop = route.stops[index + 1];
            distanceToNext = calculateHaversineDistance(
              stop.latitude,
              stop.longitude,
              nextStop.latitude,
              nextStop.longitude
            );
            timeToNext = calculateTravelTime(distanceToNext);
          }

          routeData.push({
            distributor_code: distributorCode,
            beat: Math.round(Number(route.salesmanId) || 1),
            stop_order: index + 1,
            dms_customer_id: String(stop.customerId || ''),
            outlet_name: String(stop.outletName || ''),
            latitude: Number(stop.latitude) || 0,
            longitude: Number(stop.longitude) || 0,
            distance_to_next: Number(distanceToNext.toFixed(2)) || 0,
            time_to_next: Math.round(Number(timeToNext) || 0),
            cluster_id: Math.round(Number(stop.clusterId) || 0),
            is_being_audited: false
          });
        });
      }

      console.log(`Prepared ${routeData.length} records for import`);

      // Step 4: Insert into distributor-specific table (or fallback to main table)
      await insertIntoDistributorTable(distributorCode, routeData);

      // Step 5: Verify final import count
      console.log('Verifying import...');
      const { count: actualImported, error: countError } = await supabase
        .from('distributor_routes')
        .select('*', { count: 'exact', head: true })
        .eq('distributor_code', distributorCode);

      if (countError) {
        console.error('Count verification error:', countError);
        throw new Error(`Failed to verify import: ${countError.message}`);
      }

      console.log(`Import verification:
        - Expected records: ${routeData.length}
        - Actually imported: ${actualImported}
        - Final processed count: ${importStats.processed}`);

      setSuccess(`Successfully assigned ${actualImported || routeData.length} route records to distributor ${distributorCode}`);
      onAssign(distributorCode);

    } catch (err) {
      console.error('Assignment error:', err);
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(`Failed to assign routes: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mt-8 bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-800 mb-4">Assign Routes to Distributor</h3>
      
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg text-green-700">
          <strong>Success:</strong> {success}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor="distributorCode" className="block text-sm font-medium text-gray-700 mb-2">
            Distributor Code
          </label>
          <input
            id="distributorCode"
            type="text"
            value={distributorCode}
            onChange={(e) => setDistributorCode(e.target.value.trim())}
            placeholder="Enter distributor code (e.g., DIST001)"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={isLoading}
          />
        </div>

        <div className="bg-gray-50 p-4 rounded-lg">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Route Summary</h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-600">Total Beats:</span>
              <span className="ml-2 font-medium">{routes.length}</span>
            </div>
            <div>
              <span className="text-gray-600">Total Outlets:</span>
              <span className="ml-2 font-medium">{routes.reduce((sum, route) => sum + route.stops.length, 0)}</span>
            </div>
            <div>
              <span className="text-gray-600">Total Records:</span>
              <span className="ml-2 font-medium">{routes.reduce((sum, route) => sum + route.stops.length + 1, 0)}</span>
            </div>
            <div>
              <span className="text-gray-600">Clusters:</span>
              <span className="ml-2 font-medium">{new Set(routes.flatMap(r => r.clusterIds)).size}</span>
            </div>
          </div>
        </div>

        <button
          onClick={handleAssign}
          disabled={isLoading || !distributorCode.trim()}
          className="w-full px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {isLoading ? 'Assigning Routes...' : 'Assign Routes to Distributor'}
        </button>

        {isLoading && importStats.total > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-600">
              <span>Importing routes...</span>
              <span>{Math.round((importStats.processed / importStats.total) * 100)}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div 
                className="bg-blue-500 h-3 rounded-full transition-all duration-300"
                style={{ width: `${(importStats.processed / importStats.total) * 100}%` }}
              ></div>
            </div>
            <div className="text-xs text-gray-500 text-center">
              {importStats.processed} of {importStats.total} records processed
            </div>
          </div>
        )}
      </div>
      
      <div className="mt-4 p-4 bg-blue-50 rounded-lg">
        <p className="text-sm text-blue-800">
          <strong>Note:</strong> The distributor will use this code to log in and access their assigned routes. 
          A dedicated table will be created for this distributor to ensure data isolation.
        </p>
      </div>
    </div>
  );
};

export default AssignDistributor;