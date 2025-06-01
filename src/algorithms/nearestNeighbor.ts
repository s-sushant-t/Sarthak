import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS = 30; // Strict minimum outlets per beat
const MAX_OUTLETS = 40; // Maximum outlets per beat
const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
const MAX_WORKING_TIME = 360; // 6 hours in minutes
const TRAVEL_SPEED = 20; // km/h - Updated from 30 to 20

export const nearestNeighbor = async (locationData: LocationData): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  // Group customers by cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  const routes: SalesmanRoute[] = [];
  let currentSalesmanId = 1;
  
  // Process each cluster
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    let unassignedCustomers = [...clusterCustomers];
    
    while (unassignedCustomers.length > 0) {
      const currentRoute: SalesmanRoute = {
        salesmanId: currentSalesmanId++,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [Number(clusterId)]
      };
      
      let currentLat = distributor.latitude;
      let currentLng = distributor.longitude;
      let remainingTime = MAX_WORKING_TIME;
      let assignedOutlets = 0;
      
      // Keep adding outlets until we hit MAX_OUTLETS or can't add more
      while (unassignedCustomers.length > 0 && 
             remainingTime > CUSTOMER_VISIT_TIME && // Ensure enough time for at least one more stop
             assignedOutlets < MAX_OUTLETS) {
        let nearestIndex = -1;
        let shortestDistance = Infinity;
        
        // Find the nearest customer that can be serviced within remaining time
        for (let i = 0; i < unassignedCustomers.length; i++) {
          const customer = unassignedCustomers[i];
          const distance = calculateHaversineDistance(
            currentLat, currentLng,
            customer.latitude, customer.longitude
          );
          
          const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
          if (travelTime + CUSTOMER_VISIT_TIME > remainingTime) continue;
          
          if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestIndex = i;
          }
        }
        
        // Break if we can't find a valid next customer
        if (nearestIndex === -1) break;
        
        const nearestCustomer = unassignedCustomers[nearestIndex];
        const travelTime = calculateTravelTime(shortestDistance, TRAVEL_SPEED);
        
        // Only add the customer if we won't exceed MAX_OUTLETS
        if (assignedOutlets < MAX_OUTLETS) {
          currentRoute.stops.push({
            customerId: nearestCustomer.id,
            latitude: nearestCustomer.latitude,
            longitude: nearestCustomer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: CUSTOMER_VISIT_TIME,
            clusterId: nearestCustomer.clusterId
          });
          
          currentRoute.totalDistance += shortestDistance;
          currentRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
          remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
          
          currentLat = nearestCustomer.latitude;
          currentLng = nearestCustomer.longitude;
          assignedOutlets++;
          
          // Remove the customer from unassigned list
          unassignedCustomers.splice(nearestIndex, 1);
        }
      }
      
      // Update distanceToNext and timeToNext for each stop
      for (let i = 0; i < currentRoute.stops.length - 1; i++) {
        const currentStop = currentRoute.stops[i];
        const nextStop = currentRoute.stops[i + 1];
        
        const distance = calculateHaversineDistance(
          currentStop.latitude, currentStop.longitude,
          nextStop.latitude, nextStop.longitude
        );
        
        const time = calculateTravelTime(distance, TRAVEL_SPEED);
        
        currentStop.distanceToNext = distance;
        currentStop.timeToNext = time;
      }
      
      // Only add routes that meet the minimum outlet requirement
      if (currentRoute.stops.length >= MIN_OUTLETS) {
        routes.push(currentRoute);
      } else if (currentRoute.stops.length > 0) {
        // If we have a partial route, try to merge it with the previous route
        const lastRoute = routes[routes.length - 1];
        if (lastRoute && 
            lastRoute.clusterIds[0] === Number(clusterId) &&
            lastRoute.stops.length + currentRoute.stops.length <= MAX_OUTLETS) {
          // Merge routes
          lastRoute.stops.push(...currentRoute.stops);
          
          // Recalculate metrics for the merged route
          let totalDistance = 0;
          let totalTime = 0;
          let prevLat = distributor.latitude;
          let prevLng = distributor.longitude;
          
          for (let i = 0; i < lastRoute.stops.length; i++) {
            const stop = lastRoute.stops[i];
            const distance = calculateHaversineDistance(
              prevLat, prevLng,
              stop.latitude, stop.longitude
            );
            const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
            
            totalDistance += distance;
            totalTime += travelTime + CUSTOMER_VISIT_TIME;
            
            if (i < lastRoute.stops.length - 1) {
              const nextStop = lastRoute.stops[i + 1];
              const distanceToNext = calculateHaversineDistance(
                stop.latitude, stop.longitude,
                nextStop.latitude, nextStop.longitude
              );
              const timeToNext = calculateTravelTime(distanceToNext, TRAVEL_SPEED);
              
              stop.distanceToNext = distanceToNext;
              stop.timeToNext = timeToNext;
            } else {
              stop.distanceToNext = 0;
              stop.timeToNext = 0;
            }
            
            prevLat = stop.latitude;
            prevLng = stop.longitude;
          }
          
          lastRoute.totalDistance = totalDistance;
          lastRoute.totalTime = totalTime;
        } else {
          // If we can't merge, put customers back in unassigned pool
          unassignedCustomers.push(...currentRoute.stops.map(stop => ({
            id: stop.customerId,
            latitude: stop.latitude,
            longitude: stop.longitude,
            clusterId: stop.clusterId
          })));
        }
      }
    }
  }
  
  // Calculate total distance
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: 'Nearest Neighbor (Clustered)',
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
};