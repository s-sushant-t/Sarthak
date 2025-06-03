import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useGeolocation } from '../hooks/useGeolocation';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

interface Stop {
  id: string;
  beat: number;
  stop_order: number;
  dms_customer_id: string;
  outlet_name: string;
  latitude: number;
  longitude: number;
  market_work_remark?: string;
  updated_ol_name?: string;
  owner_name?: string;
  owner_contact?: string;
  ol_closure_time?: string;
  visit_time?: string;
}

const GEOFENCE_RADIUS = 200; // meters

const BeatHygieneCorrection: React.FC = () => {
  const [beats, setBeats] = useState<number[]>([]);
  const [selectedBeat, setSelectedBeat] = useState<number | null>(null);
  const [currentStop, setCurrentStop] = useState<Stop | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { latitude, longitude, error: locationError } = useGeolocation();

  useEffect(() => {
    const fetchBeats = async () => {
      const { data, error } = await supabase
        .from('distributor_routes')
        .select('beat')
        .eq('distributor_code', supabase.auth.user()?.id)
        .order('beat');

      if (error) {
        setError('Error fetching beats: ' + error.message);
        return;
      }

      const uniqueBeats = [...new Set(data.map(d => d.beat))];
      setBeats(uniqueBeats);
      setIsLoading(false);
    };

    fetchBeats();
  }, []);

  const fetchNextStop = async () => {
    if (!selectedBeat) return;

    const { data, error } = await supabase
      .from('distributor_routes')
      .select('*')
      .eq('distributor_code', supabase.auth.user()?.id)
      .eq('beat', selectedBeat)
      .is('visit_time', null)
      .order('stop_order')
      .limit(1)
      .single();

    if (error) {
      setError('Error fetching next stop: ' + error.message);
      return;
    }

    setCurrentStop(data);
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; // Distance in meters
  };

  const handleBeatSelect = async (beat: number) => {
    setSelectedBeat(beat);
    setCurrentStop(null);
    await fetchNextStop();
  };

  const handleMarkVisit = async (formData: any) => {
    if (!currentStop || !latitude || !longitude) return;

    const distance = calculateDistance(
      latitude,
      longitude,
      currentStop.latitude,
      currentStop.longitude
    );

    if (distance > GEOFENCE_RADIUS && currentStop.stop_order !== 0) {
      setError('You must be within 200 meters of the outlet to mark a visit');
      return;
    }

    const { error } = await supabase
      .from('distributor_routes')
      .update({
        visit_time: new Date().toISOString(),
        market_work_remark: formData.marketWorkRemark,
        updated_ol_name: formData.updatedOutletName,
        owner_name: formData.ownerName,
        owner_contact: formData.ownerContact,
        ol_closure_time: formData.closureTime
      })
      .eq('id', currentStop.id);

    if (error) {
      setError('Error updating visit: ' + error.message);
      return;
    }

    await fetchNextStop();
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h2 className="text-2xl font-bold mb-6">Beat Hygiene Correction</h2>
      
      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg mb-4">
          {error}
        </div>
      )}

      {locationError && (
        <div className="bg-yellow-50 text-yellow-700 p-4 rounded-lg mb-4">
          Please enable location services to mark visits
        </div>
      )}

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Beat
        </label>
        <select
          className="w-full border-gray-300 rounded-lg shadow-sm"
          value={selectedBeat || ''}
          onChange={(e) => handleBeatSelect(Number(e.target.value))}
        >
          <option value="">Select a beat</option>
          {beats.map((beat) => (
            <option key={beat} value={beat}>Beat {beat}</option>
          ))}
        </select>
      </div>

      {currentStop && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="mb-4">
            <h3 className="text-lg font-semibold mb-2">
              {currentStop.stop_order === 0 ? 'Distribution Point' : currentStop.outlet_name}
            </h3>
            <p className="text-gray-600">Stop #{currentStop.stop_order}</p>
            <p className="text-gray-600">DMS ID: {currentStop.dms_customer_id}</p>
          </div>

          <div className="mb-4">
            <a
              href={`http://maps.google.com/maps?q=${currentStop.latitude},${currentStop.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 flex items-center"
            >
              Open in Google Maps
            </a>
          </div>

          {currentStop.stop_order === 0 ? (
            <button
              onClick={() => handleMarkVisit({})}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700"
            >
              Mark Distribution Point Visit
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.target as HTMLFormElement);
                handleMarkVisit({
                  marketWorkRemark: formData.get('marketWorkRemark'),
                  updatedOutletName: formData.get('updatedOutletName'),
                  ownerName: formData.get('ownerName'),
                  ownerContact: formData.get('ownerContact'),
                  closureTime: formData.get('closureTime')
                });
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Market Work Remarks
                </label>
                <select
                  name="marketWorkRemark"
                  required
                  className="w-full border-gray-300 rounded-lg shadow-sm"
                >
                  <option value="">Select remark</option>
                  <option value="GR1BDS">GR1BDS</option>
                  <option value="GR1ADS">GR1ADS</option>
                  <option value="GR2 DS">GR2 DS</option>
                  <option value="All DS">All DS</option>
                  <option value="No Outlet Present">No Outlet Present</option>
                  <option value="Outlet Closed">Outlet Closed</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Updated Outlet Name
                </label>
                <input
                  type="text"
                  name="updatedOutletName"
                  className="w-full border-gray-300 rounded-lg shadow-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Owner Name
                </label>
                <input
                  type="text"
                  name="ownerName"
                  className="w-full border-gray-300 rounded-lg shadow-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Owner Contact
                </label>
                <input
                  type="text"
                  name="ownerContact"
                  className="w-full border-gray-300 rounded-lg shadow-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Outlet Closure Time
                </label>
                <input
                  type="time"
                  name="closureTime"
                  className="w-full border-gray-300 rounded-lg shadow-sm"
                />
              </div>

              <button
                type="submit"
                className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700"
                disabled={!latitude || !longitude}
              >
                Mark Visit
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

export default BeatHygieneCorrection;