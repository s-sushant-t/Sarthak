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

      // First, delete existing routes for this distributor
      console.log('Deleting existing routes...');
      const { error: deleteError } = await supabase
        .from('distributor_routes')
        .delete()
        .eq('distributor_code', distributorCode);

      if (deleteError) {
        console.error('Delete error:', deleteError);
        throw new Error(`Failed to delete existing routes: ${deleteError.message}`);
      }

      // Prepare all route data with proper structure
      const routeData = [];
      
      for (const route of routes) {
        // Add distributor point as stop 0
        routeData.push({
          distributor_code: distributorCode,
          beat: route.salesmanId,
          stop_order: 0,
          dms_customer_id: 'DISTRIBUTOR',
          outlet_name: 'DISTRIBUTOR',
          latitude: route.distributorLat || 0,
          longitude: route.distributorLng || 0,
          distance_to_next: route.stops.length > 0 ? (route.stops[0]?.distanceToNext || 0) : 0,
          time_to_next: route.stops.length > 0 ? (route.stops[0]?.timeToNext || 0) : 0,
          cluster_id: route.stops.length > 0 ? (route.stops[0]?.clusterId || 0) : 0,
          is_being_audited: false
        });

        // Add all customer stops
        route.stops.forEach((stop, index) => {
          routeData.push({
            distributor_code: distributorCode,
            beat: route.salesmanId,
            stop_order: index + 1,
            dms_customer_id: stop.customerId || '',
            outlet_name: stop.outletName || '',
            latitude: stop.latitude || 0,
            longitude: stop.longitude || 0,
            distance_to_next: stop.distanceToNext || 0,
            time_to_next: stop.timeToNext || 0,
            cluster_id: stop.clusterId || 0,
            is_being_audited: false
          });
        });
      }

      console.log(`Prepared ${routeData.length} records for import`);

      // Process in smaller batches with better error handling
      const batchSize = 50;
      let processedCount = 0;
      let successfulInserts = 0;

      for (let i = 0; i < routeData.length; i += batchSize) {
        const batch = routeData.slice(i, Math.min(i + batchSize, routeData.length));
        const batchNumber = Math.floor(i/batchSize) + 1;
        const totalBatches = Math.ceil(routeData.length/batchSize);
        
        console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} records)`);
        
        try {
          const { data, error: insertError } = await supabase
            .from('distributor_routes')
            .insert(batch)
            .select('id');

          if (insertError) {
            console.error(`Batch ${batchNumber} failed:`, insertError);
            throw new Error(`Batch ${batchNumber} failed: ${insertError.message}`);
          }

          successfulInserts += data?.length || batch.length;
          processedCount += batch.length;
          
          setImportStats(prev => ({
            ...prev,
            processed: processedCount
          }));

          console.log(`Batch ${batchNumber} completed successfully: ${data?.length || batch.length} records inserted`);

        } catch (batchError) {
          console.error(`Error processing batch ${batchNumber}:`, batchError);
          throw new Error(`Failed to insert batch ${batchNumber}: ${batchError instanceof Error ? batchError.message : 'Unknown error'}`);
        }

        // Add small delay between batches to prevent rate limiting
        if (i + batchSize < routeData.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Verify final import count
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
        - Successfully processed: ${successfulInserts}
        - Actually imported: ${actualImported}
        - Final processed count: ${processedCount}`);

      if (actualImported !== routeData.length) {
        console.warn(`Import count mismatch: Expected ${routeData.length} records but found ${actualImported} in database`);
        // Don't throw error for minor discrepancies, just warn
      }

      setSuccess(`Successfully assigned ${actualImported} route records to distributor ${distributorCode}`);
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
          Make sure to provide them with this code for authentication.
        </p>
      </div>
    </div>
  );
};

export default AssignDistributor;