import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useGeolocation } from '../hooks/useGeolocation';
import { Loader2, AlertCircle, ChevronRight, MapPin, Clock, User, Phone, LogOut, Binary, Network, Cpu, Edit2 } from 'lucide-react';

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
  auditor_name?: string;
  auditor_designation?: string;
  is_being_audited?: boolean;
}

interface AuditorInfo {
  name: string;
  designation: string;
}

interface BeatInfo {
  beat: number;
  auditor_name?: string;
  is_being_audited?: boolean;
}

const GEOFENCE_RADIUS = 200; // meters

const BeatHygieneCorrection: React.FC = () => {
  const [beats, setBeats] = useState<BeatInfo[]>([]);
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
  const [auditorInfo, setAuditorInfo] = useState<AuditorInfo | null>(null);
  const [showAuditorModal, setShowAuditorModal] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const { latitude, longitude, error: locationError } = useGeolocation();
  const distributorCode = localStorage.getItem('distributorCode');

  useEffect(() => {
    const fetchBeats = async () => {
      if (!distributorCode) return;

      try {
        setIsLoading(true);
        console.log('Fetching beats for distributor:', distributorCode);

        // First, get all distinct beats with a count
        const { data: beatData, error: beatError, count } = await supabase
          .from('distributor_routes')
          .select('beat', { count: 'exact' })
          .eq('distributor_code', distributorCode);

        if (beatError) throw beatError;

        console.log('Initial beat data:', { count, rows: beatData?.length });

        // Get unique beats and ensure they're properly sorted
        const uniqueBeats = beatData ? 
          Array.from(new Set(beatData.map(row => row.beat)))
            .sort((a, b) => a - b) : 
          [];

        console.log('Unique beats:', uniqueBeats);

        // Fetch additional information for each unique beat
        const beatInfoPromises = uniqueBeats.map(async (beat) => {
          const { data: stopData, error: stopError } = await supabase
            .from('distributor_routes')
            .select('auditor_name, is_being_audited, stop_order')
            .eq('distributor_code', distributorCode)
            .eq('beat', beat)
            .order('stop_order', { ascending: true });

          if (stopError) {
            console.error(`Error fetching info for beat ${beat}:`, stopError);
            return { beat, auditor_name: null, is_being_audited: false };
          }

          // Use the first non-null auditor info
          const beatInfo = stopData?.find(stop => stop.auditor_name || stop.is_being_audited);
          return {
            beat,
            auditor_name: beatInfo?.auditor_name || null,
            is_being_audited: beatInfo?.is_being_audited || false
          };
        });

        const beatInfoResults = await Promise.all(beatInfoPromises);

        console.log('Beat processing results:', {
          expectedCount: count,
          uniqueBeatsCount: uniqueBeats.length,
          processedBeatsCount: beatInfoResults.length,
          beatNumbers: uniqueBeats,
          beatInfo: beatInfoResults
        });

        setBeats(beatInfoResults);
        setHasData(beatInfoResults.length > 0);

      } catch (error) {
        console.error('Error in fetchBeats:', error);
        setError('Error fetching beats: ' + (error instanceof Error ? error.message : 'Unknown error'));
      } finally {
        setIsLoading(false);
      }
    };

    fetchBeats();
  }, [distributorCode]);

  const handleLogout = () => {
    localStorage.clear();
    window.location.href = '/';
  };

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
      
      setStops(data || []);
      
      const nextUnvisitedStop = data?.find(stop => !stop.visit_time);
      setCurrentStop(nextUnvisitedStop || null);
      setShowForm(false);

      const isBeingAudited = data?.[0]?.is_being_audited;
      const auditorName = data?.[0]?.auditor_name;
      const auditorDesignation = data?.[0]?.auditor_designation;

      if (isBeingAudited && !auditorInfo && auditorName && auditorDesignation) {
        setAuditorInfo({ name: auditorName, designation: auditorDesignation });
      } else if (!isBeingAudited) {
        setShowAuditorModal(true);
      }
      
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
    const R = 6371e3;
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
    setShowForm(false);
    await fetchStops(beat);
  };

  const handleStopClick = (stop: Stop) => {
    if (stop.visit_time) return;
    
    setCurrentStop(stop);
    setShowForm(true);
    const clicks = (bypassClicks[stop.id] || 0) + 1;
    setBypassClicks(prev => ({ ...prev, [stop.id]: clicks }));
    
    if (clicks >= 3) {
      setBypassActive(true);
      setBypassClicks(prev => ({ ...prev, [stop.id]: 0 }));
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
      
      setBypassActive(false);
      setShowForm(false);
      await fetchStops(selectedBeat!);
      setError(null);
    } catch (error) {
      setError('Error updating visit: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleEditMarketWork = async (stopId: string, newRemark: string) => {
    setIsProcessing(true);
    try {
      const { error } = await supabase
        .from('distributor_routes')
        .update({
          market_work_remark: newRemark
        })
        .eq('id', stopId);

      if (error) throw error;
      
      await fetchStops(selectedBeat!);
      setError(null);
    } catch (error) {
      setError('Error updating market work remark: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAuditorSubmit = async (name: string, designation: string) => {
    if (!selectedBeat || !distributorCode) return;

    try {
      const { error } = await supabase
        .from('distributor_routes')
        .update({
          auditor_name: name,
          auditor_designation: designation,
          is_being_audited: true
        })
        .eq('distributor_code', distributorCode)
        .eq('beat', selectedBeat);

      if (error) throw error;

      setAuditorInfo({ name, designation });
      setShowAuditorModal(false);
      await fetchStops(selectedBeat);
    } catch (error) {
      setError('Error updating auditor information: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const handleEditClick = (e: React.MouseEvent, stop: Stop) => {
    e.stopPropagation();
    setEditingStop(stop);
    setCurrentStop(stop);
    setShowForm(true);
    setBypassActive(true);
  };

  const handleEditSubmit = async (formData: any) => {
    if (!editingStop) return;

    setIsProcessing(true);
    try {
      const { error } = await supabase
        .from('distributor_routes')
        .update({
          market_work_remark: formData.marketWorkRemark,
          updated_ol_name: formData.updatedOutletName,
          owner_name: formData.ownerName,
          owner_contact: formData.ownerContact,
          ol_closure_time: formData.closureTime
        })
        .eq('id', editingStop.id);

      if (error) throw error;
      
      setEditingStop(null);
      setShowForm(false);
      setBypassActive(false);
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
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 z-0">
          <Binary className="absolute text-blue-200 opacity-10 w-24 h-24 animate-float\" style={{ top: '15%', left: '10%' }} />
          <Network className="absolute text-purple-200 opacity-10 w-32 h-32 animate-float-delayed\" style={{ top: '60%', right: '15%' }} />
          <Cpu className="absolute text-indigo-200 opacity-10 w-28 h-28 animate-float\" style={{ top: '30%', right: '25%' }} />
        </div>
        <div className="flex flex-col items-center gap-3 z-10">
          <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
          <p className="text-blue-200">Loading your beats...</p>
        </div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto p-8 bg-white/10 backdrop-blur-lg rounded-xl border border-white/20 shadow-xl">
          <AlertCircle className="w-12 h-12 text-yellow-400 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">No Routes Assigned</h2>
          <p className="text-blue-200">
            No routes have been assigned to this distributor code yet. Please contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900">
      <div className="max-w-4xl mx-auto p-4">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-white">Beat Hygiene Correction</h2>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-4 py-2 text-red-300 hover:text-red-200 hover:bg-red-500/20 rounded-lg transition-colors"
          >
            <LogOut className="w-5 h-5" />
            <span>Logout</span>
          </button>
        </div>
        
        {error && (
          <div className="bg-red-500/20 backdrop-blur-lg text-red-200 p-4 rounded-lg mb-4 flex items-center gap-2 border border-red-500/30">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {locationError && (
          <div className="bg-yellow-500/20 backdrop-blur-lg text-yellow-200 p-4 rounded-lg mb-4 flex items-center gap-2 border border-yellow-500/30">
            <MapPin className="w-5 h-5 flex-shrink-0" />
            <p>Please enable location services to mark visits</p>
          </div>
        )}

        <div className="mb-6">
          <label className="block text-sm font-medium text-blue-200 mb-2">
            Select Beat
          </label>
          <select
            className="w-full bg-white backdrop-blur-lg border border-white/20 rounded-lg px-4 py-2 text-black placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
            value={selectedBeat || ''}
            onChange={(e) => handleBeatSelect(Number(e.target.value))}
            disabled={isProcessing}
          >
            <option value="" className="text-black">Select a beat</option>
            {beats.map((beatInfo) => (
              <option key={beatInfo.beat} value={beatInfo.beat} className="text-black">
                Beat {beatInfo.beat} 
                {beatInfo.is_being_audited ? ` (Being audited by ${beatInfo.auditor_name})` : ''}
              </option>
            ))}
          </select>
          <div className="mt-2 flex items-center gap-2">
            <div className="bg-white/10 backdrop-blur-lg px-4 py-2 rounded-lg border border-white/20">
              <span className="text-blue-200">Total Beats: </span>
              <span className="text-white font-semibold">{beats.length}</span>
            </div>
          </div>
        </div>

        {selectedBeat && (
          <div className="bg-white/10 backdrop-blur-lg rounded-xl border border-white/20 p-6 mb-6 shadow-xl">
            <h3 className="text-lg font-semibold text-white mb-4">Beat {selectedBeat} Stops</h3>
            <div className="space-y-4">
              {stops.map((stop) => (
                <div
                  key={stop.id}
                  className={`p-4 rounded-lg backdrop-blur-lg transition-all cursor-pointer ${
                    currentStop?.id === stop.id
                      ? 'bg-blue-500/20 border border-blue-400/30'
                      : stop.visit_time
                      ? 'bg-green-500/20 border border-green-400/30'
                      : 'bg-white/5 border border-white/10 hover:bg-white/10'
                  }`}
                  onClick={() => !stop.visit_time && handleStopClick(stop)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium text-white">
                        {stop.stop_order === 0 ? 'Distribution Point' : stop.outlet_name}
                      </h4>
                      <div className="mt-1 space-y-1">
                        <p className="text-sm text-blue-200">Stop #{stop.stop_order}</p>
                        {stop.owner_name && (
                          <p className="text-sm text-blue-200 flex items-center gap-1">
                            <User className="w-4 h-4" />
                            {stop.owner_name}
                          </p>
                        )}
                        {stop.owner_contact && (
                          <p className="text-sm text-blue-200 flex items-center gap-1">
                            <Phone className="w-4 h-4" />
                            {stop.owner_contact}
                          </p>
                        )}
                        {stop.ol_closure_time && (
                          <p className="text-sm text-blue-200 flex items-center gap-1">
                            <Clock className="w-4 h-4" />
                            Closes at {stop.ol_closure_time}
                          </p>
                        )}
                      </div>
                    </div>
                    {stop.visit_time ? (
                      <div className="text-right">
                        <span className="text-green-300 text-sm font-medium">
                          Visited
                        </span>
                        <p className="text-xs text-blue-200 mt-1">
                          {new Date(stop.visit_time).toLocaleTimeString()}
                        </p>
                      </div>
                    ) : (
                      <ChevronRight className="text-blue-300" />
                    )}
                  </div>

                  {stop.visit_time && (
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/10">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-blue-200">
                          Market Work: {stop.market_work_remark || 'Not set'}
                        </p>
                        <button
                          onClick={(e) => handleEditClick(e, stop)}
                          className="p-1 hover:bg-white/10 rounded-full transition-colors"
                        >
                          <Edit2 className="w-4 h-4 text-blue-300" />
                        </button>
                      </div>
                      <div className="text-right">
                        <span className="text-green-300 text-sm font-medium">
                          Visited
                        </span>
                        <p className="text-xs text-blue-200 mt-1">
                          {new Date(stop.visit_time).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  )}

                  {showForm && currentStop?.id === stop.id && (
                    <div className="mt-4 pt-4 border-t border-white/10">
                      {!editingStop && (
                        <>
                          <div className="mb-4">
                            <a
                              href={`http://maps.google.com/maps?q=${stop.latitude},${stop.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-300 hover:text-blue-200 flex items-center gap-2"
                            >
                              <MapPin className="w-4 h-4" />
                              <span>Open in Google Maps</span>
                            </a>
                          </div>

                          {distanceToOutlet !== null && !editingStop && (
                            <div className={`mb-4 text-sm ${
                              distanceToOutlet <= GEOFENCE_RADIUS || bypassActive ? 'text-green-300' : 'text-red-300'
                            }`}>
                              Distance: {Math.round(distanceToOutlet)}m 
                              {bypassActive ? ' (Bypass active)' : distanceToOutlet <= GEOFENCE_RADIUS ? ' (Within range)' : ' (Out of range)'}
                            </div>
                          )}
                        </>
                      )}

                      {stop.stop_order === 0 ? (
                        <button
                          onClick={() => handleMarkVisit({})}
                          className="w-full bg-gradient-to-r from-blue-500 to-purple-500 text-white py-2 px-4 rounded-lg hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transform transition-all duration-200 hover:scale-[1.02]"
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
                            const data = {
                              marketWorkRemark: formData.get('marketWorkRemark'),
                              updatedOutletName: formData.get('updatedOutletName'),
                              ownerName: formData.get('ownerName'),
                              ownerContact: formData.get('ownerContact'),
                              closureTime: formData.get('closureTime')
                            };
                            
                            if (editingStop) {
                              handleEditSubmit(data);
                            } else {
                              handleMarkVisit(data);
                            }
                          }}
                          className="space-y-4"
                        >
                          <div>
                            <label className="block text-sm font-medium text-blue-200 mb-1">
                              Market Work Remarks
                            </label>
                            <select
                              name="marketWorkRemark"
                              required
                              defaultValue={editingStop?.market_work_remark || ''}
                              className="w-full bg-white backdrop-blur-lg border border-white/20 rounded-lg px-4 py-2 text-black placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
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
                            <label className="block text-sm font-medium text-blue-200 mb-1">
                              Updated Outlet Name
                            </label>
                            <input
                              type="text"
                              name="updatedOutletName"
                              defaultValue={editingStop?.updated_ol_name || ''}
                              className="w-full bg-white backdrop-blur-lg border border-white/20 rounded-lg px-4 py-2 text-black placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                              disabled={isProcessing}
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-medium text-blue-200 mb-1">
                              Owner Name
                            </label>
                            <input
                              type="text"
                              name="ownerName"
                              defaultValue={editingStop?.owner_name || ''}
                              className="w-full bg-white backdrop-blur-lg border border-white/20 rounded-lg px-4 py-2 text-black placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                              disabled={isProcessing}
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-medium text-blue-200 mb-1">
                              Owner Contact
                            </label>
                            <input
                              type="text"
                              name="ownerContact"
                              defaultValue={editingStop?.owner_contact || ''}
                              className="w-full bg-white backdrop-blur-lg border border-white/20 rounded-lg px-4 py-2 text-black placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                              disabled={isProcessing}
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-medium text-blue-200 mb-1">
                              Outlet Closure Time
                            </label>
                            <input
                              type="time"
                              name="closureTime"
                              defaultValue={editingStop?.ol_closure_time || ''}
                              className="w-full bg-white backdrop-blur-lg border border-white/20 rounded-lg px-4 py-2 text-black placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                              disabled={isProcessing}
                            />
                          </div>

                          <button
                            type="submit"
                            className="w-full bg-gradient-to-r from-blue-500 to-purple-500 text-white py-2 px-4 rounded-lg hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transform transition-all duration-200 hover:scale-[1.02]"
                            disabled={isProcessing || (!editingStop && !bypassActive && (!latitude || !longitude || (distanceToOutlet !== null && distanceToOutlet > GEOFENCE_RADIUS)))}
                          >
                            {isProcessing ? (
                              <span className="flex items-center justify-center gap-2">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Processing...
                              </span>
                            ) : (
                              editingStop ? 'Update Visit Details' : 'Mark Visit'
                            )}
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {showAuditorModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Enter Auditor Information
              </h3>
              <form onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.target as HTMLFormElement);
                handleAuditorSubmit(
                  formData.get('auditorName') as string,
                  formData.get('auditorDesignation') as string
                );
              }}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Auditor Name
                    </label>
                    <input
                      type="text"
                      name="auditorName"
                      required
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Auditor Designation
                    </label>
                    <input
                      type="text"
                      name="auditorDesignation"
                      required
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex justify-end gap-3">
                    <button
                      type="submit"
                      className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
                    >
                      Start Audit
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BeatHygieneCorrection;