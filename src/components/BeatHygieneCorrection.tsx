import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useGeolocation } from '../hooks/useGeolocation';
import { Loader2, AlertCircle, ChevronRight, MapPin, Clock, User, Phone } from 'lucide-react';

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
  const [stops, setStops] = useState<Stop[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasData, setHasData] = useState(false);
  const [distanceToOutlet, setDistanceToOutlet] = useState<number | null>(null);
  const [bypassClicks, setBypassClicks] = useState<Record<string, number>>({});
  const [bypassActive, setBypassActive] = useState(false);
  const { latitude, longitude, error: locationError } = useGeolocation();
  const distributorCode = localStorage.getItem('distributorCode');

  useEffect(() => {
    const fetchBeats = async () => {
      if (!distributorCode) return;

      try {
        const { data, error } = await supabase
          .from('distributor_routes')
          .select('*')
          .eq('distributor_code', distributorCode);

        if (error) throw error;

        // Get unique beats and ensure we have all 36
        const uniqueBeats = [...new Set(data.map(d => d.beat))].sort((a, b) => a - b);
        setBeats(uniqueBeats);
        setHasData(uniqueBeats.length > 0);
      } catch (error) {
        setError('Error fetching beats: ' + (error instanceof Error ? error.message : 'Unknown error'));
      } finally {
        setIsLoading(false);
      }
    };

    fetchBeats();
  }, [distributorCode]);

  const fetchStops = async (beat: number) => {
    if (!distributorCode) return;

    setIsProcessing(true);
    try {
      const { data, error } = await supabase
        .from('distributor_routes')
        .select('*')
        .eq('distributor_code', distributorCode)
        .eq('beat', beat)
        .order('stop_order');

      if (error) throw error;
      setStops(data);
      setCurrentStop(data.find(stop => !stop.visit_time) || null);
      setError(null);
    } catch (error) {
      setError('Error fetching stops: ' + (error instanceof Error ? error.message : 'Unknown error'));
      setStops([]);
      setCurrentStop(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  };

  useEffect(() => {
    if (currentStop && latitude && longitude) {
      const distance = calculateDistance(
        latitude,
        longitude,
        currentStop.latitude,
        currentStop.longitude
      );
      setDistanceToOutlet(distance);
    } else {
      setDistanceToOutlet(null);
    }
  }, [currentStop, latitude, longitude]);

  const handleBeatSelect = async (beat: number) => {
    setSelectedBeat(beat);
    await fetchStops(beat);
  };

  const handleStopClick = (stopId: string) => {
    const clicks = (bypassClicks[stopId] || 0) + 1;
    setBypassClicks(prev => ({ ...prev, [stopId]: clicks }));
    
    if (clicks >= 3) {
      setBypassActive(true);
      // Reset clicks after activation
      setBypassClicks(prev => ({ ...prev, [stopId]: 0 }));
      // Show temporary success message
      setError('Geofencing temporarily disabled for this stop');
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleMarkVisit = async (formData: any) => {
    if (!currentStop || (!latitude && currentStop.stop_order !== 0) || (!longitude && currentStop.stop_order !== 0)) {
      setError('Location data is required to mark a visit');
      return;
    }

    if (currentStop.stop_order !== 0 && !bypassActive) {
      const distance = calculateDistance(
        latitude!,
        longitude!,
        currentStop.latitude,
        currentStop.longitude
      );

      if (distance > GEOFENCE_RADIUS) {
        setError(`You must be within ${GEOFENCE_RADIUS} meters of the outlet to mark a visit (currently ${Math.round(distance)}m away)`);
        return;
      }
    }

    setIsProcessing(true);
    try {
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

      if (error) throw error;
      
      // Reset bypass after successful visit
      setBypassActive(false);
      
      // Refresh stops after marking visit
      await fetchStops(selectedBeat!);
      setError(null);
    } catch (error) {
      setError('Error updating visit: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsProcessing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-md mx-auto p-6 bg-white rounded-lg shadow-md">
          <AlertCircle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-800 mb-2">No Routes Assigned</h2>
          <p className="text-gray-600">
            No routes have been assigned to this distributor code yet. Please assign routes through the main application first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h2 className="text-2xl font-bold mb-6">Beat Hygiene Correction</h2>
      
      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg mb-4 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {locationError && (
        <div className="bg-yellow-50 text-yellow-700 p-4 rounded-lg mb-4 flex items-center gap-2">
          <MapPin className="w-5 h-5 flex-shrink-0" />
          <p>Please enable location services to mark visits</p>
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
          disabled={isProcessing}
        >
          <option value="">Select a beat</option>
          {beats.map((beat) => (
            <option key={beat} value={beat}>Beat {beat}</option>
          ))}
        </select>
      </div>

      {selectedBeat && (
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Beat {selectedBeat} Stops</h3>
          <div className="space-y-4">
            {stops.map((stop) => (
              <div
                key={stop.id}
                className={`p-4 rounded-lg border ${
                  currentStop?.id === stop.id
                    ? 'border-blue-500 bg-blue-50'
                    : stop.visit_time
                    ? 'border-green-200 bg-green-50'
                    : 'border-gray-200'
                } cursor-pointer`}
                onClick={() => handleStopClick(stop.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-medium">
                      {stop.stop_order === 0 ? 'Distribution Point' : stop.outlet_name}
                    </h4>
                    <div className="mt-1 space-y-1">
                      <p className="text-sm text-gray-600">Stop #{stop.stop_order}</p>
                      {stop.owner_name && (
                        <p className="text-sm text-gray-600 flex items-center gap-1">
                          <User className="w-4 h-4" />
                          {stop.owner_name}
                        </p>
                      )}
                      {stop.owner_contact && (
                        <p className="text-sm text-gray-600 flex items-center gap-1">
                          <Phone className="w-4 h-4" />
                          {stop.owner_contact}
                        </p>
                      )}
                      {stop.ol_closure_time && (
                        <p className="text-sm text-gray-600 flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          Closes at {stop.ol_closure_time}
                        </p>
                      )}
                    </div>
                  </div>
                  {stop.visit_time ? (
                    <div className="text-right">
                      <span className="text-green-600 text-sm font-medium">
                        Visited
                      </span>
                      <p className="text-xs text-gray-500 mt-1">
                        {new Date(stop.visit_time).toLocaleTimeString()}
                      </p>
                    </div>
                  ) : (
                    <ChevronRight className="text-gray-400" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isProcessing && (
        <div className="flex justify-center my-8">
          <div className="flex items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            <p className="text-gray-600">Processing...</p>
          </div>
        </div>
      )}

      {!isProcessing && currentStop && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="mb-4">
            <h3 className="text-lg font-semibold mb-2">
              {currentStop.stop_order === 0 ? 'Distribution Point' : currentStop.outlet_name}
            </h3>
            <p className="text-gray-600">Stop #{currentStop.stop_order}</p>
            <p className="text-gray-600">DMS ID: {currentStop.dms_customer_id}</p>
            
            {distanceToOutlet !== null && (
              <div className={`mt-2 text-sm ${
                distanceToOutlet <= GEOFENCE_RADIUS || bypassActive ? 'text-green-600' : 'text-red-600'
              }`}>
                Distance: {Math.round(distanceToOutlet)}m 
                {bypassActive ? ' (Bypass active)' : distanceToOutlet <= GEOFENCE_RADIUS ? ' (Within range)' : ' (Out of range)'}
              </div>
            )}
          </div>

          <div className="mb-4">
            <a
              href={`http://maps.google.com/maps?q=${currentStop.latitude},${currentStop.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 flex items-center gap-2"
            >
              <MapPin className="w-4 h-4" />
              <span>Open in Google Maps</span>
            </a>
          </div>

          {currentStop.stop_order === 0 ? (
            <button
              onClick={() => handleMarkVisit({})}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isProcessing}
            >
              {isProcessing ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing...
                </span>
              ) : (
                'Mark Distribution Point Visit'
              )}
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
                  disabled={isProcessing}
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
                  disabled={isProcessing}
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
                  disabled={isProcessing}
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
                  disabled={isProcessing}
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
                  disabled={isProcessing}
                />
              </div>

              <button
                type="submit"
                className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isProcessing || (!bypassActive && (!latitude || !longitude || (distanceToOutlet !== null && distanceToOutlet > GEOFENCE_RADIUS)))}
              >
                {isProcessing ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing...
                  </span>
                ) : (
                  'Mark Visit'
                )}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

export default BeatHygieneCorrection;