import React, { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { RouteData } from '../types';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

interface AssignDistributorProps {
  routes: RouteData;
  onAssign: () => void;
}

const AssignDistributor: React.FC<AssignDistributorProps> = ({ routes, onAssign }) => {
  const [distributorCode, setDistributorCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAssign = async () => {
    if (!distributorCode.trim()) {
      setError('Please enter a distributor code');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
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
            distributor_code: distributorCode
          },
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
            distributor_code: distributorCode
          }))
        ];

        return stops;
      });

      const { error: insertError } = await supabase
        .from('distributor_routes')
        .insert(routeData);

      if (insertError) throw insertError;

      onAssign();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mt-4">
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
    </div>
  );
};