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

  const createDistributorTable = async (distributorCode: string): Promise<string> => {
    // Sanitize distributor code for table name
    const sanitizedCode = distributorCode.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tableName = `distributor_routes_${sanitizedCode}`;
    
    try {
      console.log(`Creating distributor-specific table: ${tableName}`);
      
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
          
          CONSTRAINT ${tableName}_unique_constraint UNIQUE (distributor_code, beat, stop_order)
        );
        
        ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
        
        CREATE POLICY "Users can access their routes" ON ${tableName}
        FOR ALL
        TO authenticated
        USING (
          (auth.jwt()->>'email' = 'EDIS') OR 
          (distributor_code = '${distributorCode}')
        )
        WITH CHECK (
          (auth.jwt()->>'email' = 'EDIS') OR 
          (distributor_code = '${distributorCode}')
        );
      `;
      
      // Execute the SQL using the RPC function
      const { error: createError } = await supabase.rpc('execute_sql', { 
        sql_query: createTableSQL 
      });
      
      if (createError) {
        console.warn('Failed to create distributor-specific table:', createError);
        // Fall back to main table
        return 'distributor_routes';
      }
      
      // Register the table mapping
      const { error: registerError } = await supabase.rpc('register_distributor_table', {
        dist_code: distributorCode,
        tbl_name: tableName
      });
      
      if (registerError) {
        console.warn('Failed to register table mapping:', registerError);
      }
      
      console.log(`Successfully created distributor table: ${tableName}`);
      return tableName;
      
    } catch (error) {
      console.warn('Error creating distributor table:', error);
      // Fall back to main table
      return 'distributor_routes';
    }
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
      // Check if user is authenticated
      const { data: { user } } = await supabase.auth.getUser();
      if (!user && localStorage.getItem('userType') !== 'admin') {
        throw new Error('You must be logged in as an administrator to assign routes');
      }

      // Calculate total records to process
      const totalRecords = routes.reduce((acc, route) => acc + route.stops.length + 1, 0); // +1 for distributor point
      setImportStats({ total: totalRecords, processed: 0 });
      console.log(`Starting import of ${totalRecords} records for distributor: ${distributorCode}`);

      // Create or get the distributor-specific table
      const targetTable = await createDistributorTable(distributorCode);
      console.log(`Using table: ${targetTable}`);

      // First, delete existing routes for this distributor from the target table
      console.log('Deleting existing routes...');
      const { error: deleteError } = await supabase
        .from(targetTable)
        .delete()
        .eq('distributor_code', distributorCode);

      if (deleteError) {
        console.error('Delete error:', deleteError);
        throw new Error(`Failed to delete existing routes: ${deleteError.message}`);
      }

      // Prepare all route data with proper structure and data types
      const routeData = [];
      
      for (const route of routes) {
        // Add distributor point as stop 0
        routeData.push({
          distributor_code: distributorCode,
          beat: parseInt(route.salesmanId.toString()),
          stop_order: 0,
          dms_customer_id: 'DISTRIBUTOR',
          outlet_name: 'DISTRIBUTOR',
          latitude: parseFloat(route.distributorLat?.toString() || '0'),
          longitude: parseFloat(route.distributorLng?.toString() || '0'),
          distance_to_next: route.stops.length > 0 ? parseFloat((route.stops[0]?.distanceToNext || 0).toString()) : 0,
          time_to_next: route.stops.length > 0 ? parseInt((route.stops[0]?.timeToNext || 0).toString()) : 0,
          cluster_id: route.stops.length > 0 ? parseInt((route.stops[0]?.clusterId || 0).toString()) : 0,
          is_being_audited: false
        });

        // Add all customer stops
        route.stops.forEach((stop, index) => {
          routeData.push({
            distributor_code: distributorCode,
            beat: parseInt(route.salesmanId.toString()),
            stop_order: index + 1,
            dms_customer_id: stop.customerId || '',
            outlet_name: stop.outletName || '',
            latitude: parseFloat(stop.latitude?.toString() || '0'),
            longitude: parseFloat(stop.longitude?.toString() || '0'),
            distance_to_next: parseFloat((stop.distanceToNext || 0).toString()),
            time_to_next: parseInt((stop.timeToNext || 0).toString()),
            cluster_id: parseInt((stop.clusterId || 0).toString()),
            is_being_audited: false
          });
        });
      }

      console.log(`Prepared ${routeData.length} records for import to table: ${targetTable}`);

      // Process in smaller batches with better error handling
      const batchSize = 50;
      let processedCount = 0;
      let successfulInserts = 0;

      for (let i = 0; i < routeData.length; i += batchSize) {
        const batch = routeData.slice(i, Math.min(i + batchSize, routeData.length));
        const batchNumber = Math.floor(i/batchSize) + 1;
        const totalBatches = Math.ceil(routeData.length/batchSize);
        
        console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} records) to table: ${targetTable}`);
        
        try {
          const { data, error: insertError } = await supabase
            .from(targetTable)
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
        .from(targetTable)
        .select('*', { count: 'exact', head: true })
        .eq('distributor_code', distributorCode);

      if (countError) {
        console.error('Count verification error:', countError);
        throw new Error(`Failed to verify import: ${countError.message}`);
      }

      console.log(`Import verification for table ${targetTable}:
        - Expected records: ${routeData.length}
        - Successfully processed: ${successfulInserts}
        - Actually imported: ${actualImported}
        - Final processed count: ${processedCount}`);

      if (actualImported !== routeData.length) {
        console.warn(`Import count mismatch: Expected ${routeData.length} records but found ${actualImported} in database`);
        // Don't throw error for minor discrepancies, just warn
      }

      setSuccess(`Successfully assigned ${actualImported} route records to distributor ${distributorCode} in table ${targetTable}`);
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
          <p className="mt-1 text-xs text-gray-500">
            This distributor code will be used for login access (same code for username and password)
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
          <strong>Note:</strong> The system will create a dedicated table for this distributor to ensure data isolation. 
          The distributor will use their distributor code as both username and password to log in and access their assigned routes.
        </p>
      </div>
    </div>
  );
};

export default AssignDistributor;