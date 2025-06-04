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
  const [importStats, setImportStats] = useState<{total: number, processed: number}>({ total: 0, processed: 0 });

  const handleAssign = async () => {
    if (!distributorCode.trim()) {
      setError('Please enter a distributor code');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Calculate total records to process
      const totalRecords = routes.reduce((acc, route) => acc + route.stops.length + 1, 0); // +1 for distributor point
      setImportStats({ total: totalRecords, processed: 0 });
      console.log(`Starting import of ${totalRecords} records...`);

      // Delete existing routes for this distributor
      const { error: deleteError } = await supabase
        .from('distributor_routes')
        .delete()
        .eq('distributor_code', distributorCode);

      if (deleteError) throw deleteError;

      // Prepare all route data
      const routeData = routes.flatMap(route => {
        // Add distributor point as stop 0
        const stops = [
          {
            beat: route.salesmanId,
            stop_order: 0,
            dms_customer_id: 'DISTRIBUTOR',
            outlet_name: 'DISTRIBUTOR',
            latitude: route.distributorLat,
            longitude: route.distributorLng,
            distance_to_next: route.stops[0]?.distanceToNext || 0,
            time_to_next: route.stops[0]?.timeToNext || 0,
            cluster_id: route.stops[0]?.clusterId || 0,
            distributor_code: distributorCode,
            is_being_audited: false
          },
          // Add all customer stops
          ...route.stops.map((stop, index) => ({
            beat: route.salesmanId,
            stop_order: index + 1,
            dms_customer_id: stop.customerId,
            outlet_name: stop.outletName || '',
            latitude: stop.latitude,
            longitude: stop.longitude,
            distance_to_next: stop.distanceToNext,
            time_to_next: stop.timeToNext,
            cluster_id: stop.clusterId,
            distributor_code: distributorCode,
            is_being_audited: false
          }))
        ];

        return stops;
      });

      console.log(`Prepared ${routeData.length} records for import`);

      // Process in smaller batches with retries
      const batchSize = 25; // Reduced batch size
      const maxRetries = 3;
      let processedCount = 0;
      let failedRecords = [];

      for (let i = 0; i < routeData.length; i += batchSize) {
        const batch = routeData.slice(i, Math.min(i + batchSize, routeData.length));
        const batchNumber = Math.floor(i/batchSize) + 1;
        const totalBatches = Math.ceil(routeData.length/batchSize);
        
        console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} records)`);
        
        let retryCount = 0;
        let success = false;

        while (retryCount < maxRetries && !success) {
          try {
            const { error: insertError } = await supabase
              .from('distributor_routes')
              .insert(batch);

            if (insertError) {
              console.error(`Batch ${batchNumber} attempt ${retryCount + 1} failed:`, insertError);
              retryCount++;
              // Add exponential backoff
              await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
              continue;
            }

            success = true;
            processedCount += batch.length;
            setImportStats(prev => ({
              ...prev,
              processed: processedCount
            }));

          } catch (error) {
            console.error(`Error processing batch ${batchNumber} attempt ${retryCount + 1}:`, error);
            retryCount++;
            if (retryCount === maxRetries) {
              failedRecords.push(...batch);
            }
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
          }
        }

        // Add delay between batches to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Handle any remaining failed records individually
      if (failedRecords.length > 0) {
        console.log(`Retrying ${failedRecords.length} failed records individually...`);
        
        for (const record of failedRecords) {
          try {
            const { error: retryError } = await supabase
              .from('distributor_routes')
              .insert([record]);

            if (!retryError) {
              processedCount++;
              setImportStats(prev => ({
                ...prev,
                processed: processedCount
              }));
            }
            // Add small delay between individual retries
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (error) {
            console.error(`Failed to insert record:`, error);
          }
        }
      }

      // Verify final import count
      const { count: actualImported, error: countError } = await supabase
        .from('distributor_routes')
        .select('*', { count: 'exact', head: true })
        .eq('distributor_code', distributorCode);

      if (countError) throw countError;

      console.log(`Import verification:
        - Expected records: ${routeData.length}
        - Actually imported: ${actualImported}
        - Processed count: ${processedCount}`);

      if (actualImported !== routeData.length) {
        throw new Error(`Import mismatch: Expected ${routeData.length} records but imported ${actualImported}`);
      }

      onAssign(distributorCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mt-8 bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-medium text-gray-800 mb-3">Assign Routes to Distributor</h3>
      
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <input
          type="text"
          value={distributorCode}
          onChange={(e) => setDistributorCode(e.target.value)}
          placeholder="Enter distributor code"
          className="flex-grow px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleAssign}
          disabled={isLoading}
          className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
        >
          {isLoading ? 'Assigning...' : 'Assign to Distributor'}
        </button>
      </div>

      {isLoading && importStats.total > 0 && (
        <div className="mt-4">
          <div className="flex justify-between text-sm text-gray-600 mb-1">
            <span>Importing routes...</span>
            <span>{Math.round((importStats.processed / importStats.total) * 100)}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div 
              className="bg-green-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${(importStats.processed / importStats.total) * 100}%` }}
            ></div>
          </div>
        </div>
      )}
      
      <p className="mt-2 text-sm text-gray-500">
        The distributor will use this code to log in and access their assigned routes.
      </p>
    </div>
  );
};

export default AssignDistributor;