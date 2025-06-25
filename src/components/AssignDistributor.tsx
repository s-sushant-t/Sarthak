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

  const createDistributorTable = async (code: string) => {
    const tableName = `distributor_routes_${code.toLowerCase()}`;
    
    console.log(`Creating table: ${tableName}`);
    
    // Create the table with the same structure as distributor_routes
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        distributor_code text NOT NULL,
        beat integer NOT NULL,
        stop_order integer NOT NULL,
        dms_customer_id text NOT NULL,
        outlet_name text,
        latitude double precision NOT NULL,
        longitude double precision NOT NULL,
        distance_to_next double precision,
        time_to_next integer,
        cluster_id integer,
        market_work_remark text,
        updated_ol_name text,
        owner_name text,
        owner_contact text,
        ol_closure_time text,
        visit_time timestamptz,
        created_at timestamptz DEFAULT now(),
        auditor_name text,
        auditor_designation text,
        is_being_audited boolean DEFAULT false,
        
        CONSTRAINT unique_${code.toLowerCase()}_beat_stop UNIQUE (distributor_code, beat, stop_order)
      );
    `;

    const { error: createError } = await supabase.rpc('execute_sql', { 
      sql_query: createTableSQL 
    });

    if (createError) {
      console.error('Error creating table:', createError);
      throw new Error(`Failed to create table for distributor ${code}: ${createError.message}`);
    }

    console.log(`✅ Table ${tableName} created successfully`);
    return tableName;
  };

  const insertDataIntoDistributorTable = async (tableName: string, routeData: any[]) => {
    console.log(`Inserting ${routeData.length} records into ${tableName}`);
    
    // Process in smaller batches
    const batchSize = 50;
    let processedCount = 0;
    let successfulInserts = 0;

    for (let i = 0; i < routeData.length; i += batchSize) {
      const batch = routeData.slice(i, Math.min(i + batchSize, routeData.length));
      const batchNumber = Math.floor(i/batchSize) + 1;
      const totalBatches = Math.ceil(routeData.length/batchSize);
      
      console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} records) for ${tableName}`);
      
      try {
        // Use raw SQL insert for the custom table
        const values = batch.map(record => {
          // Ensure proper data type conversion
          const timeToNext = Math.round(Number(record.time_to_next) || 0); // Convert to integer
          const distanceToNext = Number(record.distance_to_next) || 0; // Ensure it's a number
          const clusterId = Math.round(Number(record.cluster_id) || 0); // Convert to integer
          const beat = Math.round(Number(record.beat) || 1); // Convert to integer
          const stopOrder = Math.round(Number(record.stop_order) || 0); // Convert to integer
          
          const escapedValues = [
            `'${record.distributor_code}'`,
            beat,
            stopOrder,
            `'${record.dms_customer_id.replace(/'/g, "''")}'`,
            record.outlet_name ? `'${record.outlet_name.replace(/'/g, "''")}'` : 'NULL',
            Number(record.latitude) || 0,
            Number(record.longitude) || 0,
            distanceToNext,
            timeToNext,
            clusterId,
            'NULL', // market_work_remark
            'NULL', // updated_ol_name
            'NULL', // owner_name
            'NULL', // owner_contact
            'NULL', // ol_closure_time
            'NULL', // visit_time
            'now()', // created_at
            'NULL', // auditor_name
            'NULL', // auditor_designation
            'false' // is_being_audited
          ];
          return `(${escapedValues.join(', ')})`;
        }).join(', ');

        const insertSQL = `
          INSERT INTO ${tableName} (
            distributor_code, beat, stop_order, dms_customer_id, outlet_name,
            latitude, longitude, distance_to_next, time_to_next, cluster_id,
            market_work_remark, updated_ol_name, owner_name, owner_contact,
            ol_closure_time, visit_time, created_at, auditor_name,
            auditor_designation, is_being_audited
          ) VALUES ${values}
        `;

        const { error: insertError } = await supabase.rpc('execute_sql', { 
          sql_query: insertSQL 
        });

        if (insertError) {
          console.error(`Batch ${batchNumber} failed:`, insertError);
          throw new Error(`Batch ${batchNumber} failed: ${insertError.message}`);
        }

        successfulInserts += batch.length;
        processedCount += batch.length;
        
        setImportStats(prev => ({
          ...prev,
          processed: processedCount
        }));

        console.log(`Batch ${batchNumber} completed successfully: ${batch.length} records inserted into ${tableName}`);

      } catch (batchError) {
        console.error(`Error processing batch ${batchNumber}:`, batchError);
        throw new Error(`Failed to insert batch ${batchNumber}: ${batchError instanceof Error ? batchError.message : 'Unknown error'}`);
      }

      // Add small delay between batches
      if (i + batchSize < routeData.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return successfulInserts;
  };

  const handleAssign = async () => {
    if (!distributorCode.trim()) {
      setError('Please enter a distributor code');
      return;
    }

    // Validate distributor code format (alphanumeric, no special characters except underscore)
    const validCodePattern = /^[a-zA-Z0-9_]+$/;
    if (!validCodePattern.test(distributorCode.trim())) {
      setError('Distributor code can only contain letters, numbers, and underscores');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const cleanCode = distributorCode.trim();
      
      // Calculate total records to process
      const totalRecords = routes.reduce((acc, route) => acc + route.stops.length + 1, 0);
      setImportStats({ total: totalRecords, processed: 0 });
      console.log(`Starting import of ${totalRecords} records for distributor: ${cleanCode}`);

      // Step 1: Create distributor-specific table
      const tableName = await createDistributorTable(cleanCode);

      // Step 2: Prepare route data with proper data type conversion
      const routeData = [];
      
      for (const route of routes) {
        // Calculate distance and time to first stop
        let distanceToFirst = 0;
        let timeToFirst = 0;
        
        if (route.stops.length > 0) {
          const firstStop = route.stops[0];
          distanceToFirst = calculateHaversineDistance(
            route.distributorLat || 0,
            route.distributorLng || 0,
            firstStop.latitude,
            firstStop.longitude
          );
          timeToFirst = Math.round(calculateTravelTime(distanceToFirst));
        }

        // Add distributor point as stop 0
        routeData.push({
          distributor_code: cleanCode,
          beat: route.salesmanId,
          stop_order: 0,
          dms_customer_id: 'DISTRIBUTOR',
          outlet_name: 'DISTRIBUTOR',
          latitude: route.distributorLat || 0,
          longitude: route.distributorLng || 0,
          distance_to_next: distanceToFirst,
          time_to_next: timeToFirst,
          cluster_id: route.stops.length > 0 ? (route.stops[0]?.clusterId || 0) : 0
        });

        // Add all customer stops
        route.stops.forEach((stop, index) => {
          // Calculate distance and time to next stop
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
            timeToNext = Math.round(calculateTravelTime(distanceToNext));
          }

          routeData.push({
            distributor_code: cleanCode,
            beat: route.salesmanId,
            stop_order: index + 1,
            dms_customer_id: stop.customerId || '',
            outlet_name: stop.outletName || '',
            latitude: stop.latitude || 0,
            longitude: stop.longitude || 0,
            distance_to_next: distanceToNext,
            time_to_next: timeToNext,
            cluster_id: stop.clusterId || 0
          });
        });
      }

      console.log(`Prepared ${routeData.length} records for import into ${tableName}`);

      // Step 3: Insert data into the new table
      const successfulInserts = await insertDataIntoDistributorTable(tableName, routeData);

      console.log(`Import completed successfully:
        - Table created: ${tableName}
        - Records inserted: ${successfulInserts}
        - Expected records: ${routeData.length}`);

      setSuccess(`Successfully created table "${tableName}" and assigned ${successfulInserts} route records to distributor ${cleanCode}`);
      onAssign(cleanCode);

    } catch (err) {
      console.error('Assignment error:', err);
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(`Failed to assign routes: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Helper function to calculate Haversine distance
  const calculateHaversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Helper function to calculate travel time
  const calculateTravelTime = (distance: number, speedKmPerHour: number = 30): number => {
    return (distance / speedKmPerHour) * 60; // Convert to minutes
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
          <p className="text-xs text-gray-500 mt-1">
            Only letters, numbers, and underscores allowed
          </p>
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
          {isLoading ? 'Creating Distributor Table...' : 'Create Distributor Table & Assign Routes'}
        </button>

        {isLoading && importStats.total > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-600">
              <span>Creating table and importing routes...</span>
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
          <strong>Note:</strong> This will create a dedicated table for the distributor. 
          The distributor will use their code to log in and access their assigned routes from their own table.
        </p>
      </div>
    </div>
  );
};

export default AssignDistributor;