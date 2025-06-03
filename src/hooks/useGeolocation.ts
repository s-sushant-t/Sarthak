import { useState, useEffect } from 'react';

interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  error: string | null;
}

export const useGeolocation = () => {
  const [state, setState] = useState<GeolocationState>({
    latitude: null,
    longitude: null,
    error: null
  });

  useEffect(() => {
    if (!navigator.geolocation) {
      setState(prev => ({ ...prev, error: 'Geolocation is not supported' }));
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setState({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          error: null
        });
      },
      (error) => {
        setState(prev => ({ ...prev, error: error.message }));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15000,
        timeout: 12000
      }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return state;
};