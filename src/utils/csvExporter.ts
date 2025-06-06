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
    'Cluster ID',
    'GR1_Sale',
    'GR2_Sale'
  ].join(',');
  
  // Create rows for each stop in each route
  const rows: string[] = [];
  
  routes.forEach(route => {
    // Add distributor as first stop (stop order 0)
    if (route.stops.length > 0) {
      const firstStop = route.stops[0];
      const distanceToFirst = calculateHaversineDistance(
        route.distributorLat,
        route.distributorLng,
        firstStop.latitude,
        firstStop.longitude
      );
      const timeToFirst = calculateTravelTime(distanceToFirst);
      
      rows.push([
        route.salesmanId,
        0,
        'DISTRIBUTOR',
        'DISTRIBUTOR',
        route.distributorLat,
        route.distributorLng,
        distanceToFirst.toFixed(2),
        timeToFirst.toFixed(2),
        firstStop.clusterId,
        0, // Distributor has no sales
        0  // Distributor has no sales
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
      
      // Find the original customer data to get sales values
      const customerData = findCustomerSalesData(stop.customerId);
      
      rows.push([
        route.salesmanId,
        index + 1,
        `"${stop.customerId}"`,
        `"${stop.outletName || ''}"`,
        stop.latitude,
        stop.longitude,
        distanceToNext.toFixed(2),
        timeToNext.toFixed(2),
        stop.clusterId,
        customerData.gr1Sale || 0,
        customerData.gr2Sale || 0
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
  
  // Log export summary
  const totalCustomers = routes.reduce((sum, route) => sum + route.stops.length, 0);
  const totalGR1 = routes.reduce((sum, route) => 
    sum + route.stops.reduce((routeSum, stop) => {
      const customerData = findCustomerSalesData(stop.customerId);
      return routeSum + (customerData.gr1Sale || 0);
    }, 0), 0
  );
  const totalGR2 = routes.reduce((sum, route) => 
    sum + route.stops.reduce((routeSum, stop) => {
      const customerData = findCustomerSalesData(stop.customerId);
      return routeSum + (customerData.gr2Sale || 0);
    }, 0), 0
  );
  
  console.log(`📊 CSV Export Summary:
    - Total customers: ${totalCustomers}
    - Total beats: ${routes.length}
    - Total GR1 sales: ${totalGR1.toLocaleString()}
    - Total GR2 sales: ${totalGR2.toLocaleString()}
    - File: ${filename}.csv`);
};

// Helper function to find customer sales data from localStorage
function findCustomerSalesData(customerId: string): { gr1Sale?: number; gr2Sale?: number } {
  try {
    const locationData = localStorage.getItem('locationData');
    if (locationData) {
      const parsedData = JSON.parse(locationData);
      const customer = parsedData.customers?.find((c: any) => c.id === customerId);
      if (customer) {
        return {
          gr1Sale: customer.gr1Sale || 0,
          gr2Sale: customer.gr2Sale || 0
        };
      }
    }
  } catch (error) {
    console.warn(`Could not find sales data for customer ${customerId}:`, error);
  }
  
  return { gr1Sale: 0, gr2Sale: 0 };
}

// Helper function to calculate Haversine distance
const calculateHaversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Helper function to calculate travel time
const calculateTravelTime = (distance: number, speedKmPerHour: number = 30): number => {
  return (distance / speedKmPerHour) * 60; // Convert to minutes
};