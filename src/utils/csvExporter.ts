import { RouteData, SalesmanRoute, RouteStop } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from './distanceCalculator';

export const exportToCSV = (routes: RouteData, filename: string): void => {
  // Create CSV headers
  const headers = [
    'Salesman ID',
    'Stop Order',
    'DMS Customer ID', 
    'OL_Latitude',
    'OL_Longitude',
    'Distance to Next Node (km)',
    'Time to Next Node (min)',
    'Cluster ID'
  ].join(',');
  
  // Create rows for each stop in each route
  const rows: string[] = [];
  
  routes.forEach(route => {
    let prevLat = route.stops[0]?.latitude;
    let prevLng = route.stops[0]?.longitude;
    
    // Add distributor as first stop (stop order 0)
    if (route.stops.length > 0) {
      const firstStop = route.stops[0];
      const distanceToFirst = calculateHaversineDistance(
        prevLat,
        prevLng,
        firstStop.latitude,
        firstStop.longitude
      );
      const timeToFirst = calculateTravelTime(distanceToFirst);
      
      rows.push([
        route.salesmanId,
        0,
        'DISTRIBUTOR',
        prevLat,
        prevLng,
        distanceToFirst.toFixed(3),
        timeToFirst.toFixed(2),
        firstStop.clusterId
      ].join(','));
    }
    
    // Add customer stops
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
      
      rows.push([
        route.salesmanId,
        index + 1,
        stop.customerId,
        stop.latitude,
        stop.longitude,
        distanceToNext.toFixed(3),
        timeToNext.toFixed(2),
        stop.clusterId
      ].join(','));
    });
  });
  
  // Combine headers and rows
  const csvContent = [headers, ...rows].join('\n');
  
  // Create a Blob and download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${filename}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};