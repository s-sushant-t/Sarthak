import { RouteData, SalesmanRoute, RouteStop } from '../types';

export const exportToCSV = (routes: RouteData, filename: string): void => {
  // Create CSV headers
  const headers = [
    'Beat',
    'Stop Order',
    'DMS Customer ID',
    'Outlet Name',
    'OL_Latitude',
    'OL_Longitude',
    'Distance to Next Node (km)',
    'Time to Next Node (min)',
    'Cluster ID'
  ].join(',');
  
  // Create rows for each stop in each route
  const rows: string[] = [];
  
  routes.forEach(route => {
    // Add distributor as first stop (stop order 0)
    if (route.stops.length > 0) {
      rows.push([
        route.salesmanId,
        0,
        'DISTRIBUTOR',
        'DISTRIBUTOR',
        route.distributorLat,
        route.distributorLng,
        route.stops[0].distanceToNext,
        route.stops[0].timeToNext,
        route.stops[0].clusterId
      ].join(','));
    }
    
    // Add customer stops
    route.stops.forEach((stop, index) => {
      rows.push([
        route.salesmanId,
        index + 1,
        stop.customerId,
        stop.outletName || '',
        stop.latitude,
        stop.longitude,
        stop.distanceToNext,
        stop.timeToNext,
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