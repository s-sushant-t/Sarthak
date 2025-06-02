import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 30; // Minimum outlets per beat
const MAX_OUTLETS_PER_BEAT = 40; // Maximum outlets per beat
const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
const MAX_WORKING_TIME = 360; // 6 hours in minutes
const TRAVEL_SPEED = 30; // km/h

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
    const clusterCustomers = customersByCluster[Number(clusterId)];
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
      
      // Calculate target outlets for this route
      const remainingOutlets = unassignedCustomers.length;
      const targetOutlets = Math.max(
        MIN_OUTLETS_PER_BEAT,
        Math.min(MAX_OUTLETS_PER_BEAT, remainingOutlets)
      );
      
      while (unassignedCustomers.length > 0 && 
             remainingTime > 0 && 
             currentRoute.stops.length < targetOutlets) {
        let nearestIndex = -1;
        let shortestDistance = Infinity;
        
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
        
        if (nearestIndex === -1) break;
        
        const nearestCustomer = unassignedCustomers.splice(nearestIndex, 1)[0];
        const travelTime = calculateTravelTime(shortestDistance, TRAVEL_SPEED);
        
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
      }
      
      // If we have less than minimum outlets, try to merge with an existing route
      if (currentRoute.stops.length < MIN_OUTLETS_PER_BEAT) {
        // Find the nearest route to merge with
        let nearestRouteIndex = -1;
        let minDistance = Infinity;
        
        routes.forEach((route, index) => {
          // Only consider routes from the same cluster that won't exceed max outlets when merged
          if (route.clusterIds[0] === Number(clusterId) && 
              route.stops.length + currentRoute.stops.length <= MAX_OUTLETS_PER_BEAT) {
            const lastStop = route.stops[route.stops.length - 1];
            const distance = calculateHaversineDistance(
              lastStop.latitude, lastStop.longitude,
              currentRoute.stops[0].latitude, currentRoute.stops[0].longitude
            );
            
            if (distance < minDistance) {
              minDistance = distance;
              nearestRouteIndex = index;
            }
          }
        });
        
        if (nearestRouteIndex !== -1) {
          // Merge with nearest route
          const targetRoute = routes[nearestRouteIndex];
          targetRoute.stops.push(...currentRoute.stops);
          
          // Recalculate metrics
          let prevLat = distributor.latitude;
          let prevLng = distributor.longitude;
          targetRoute.totalDistance = 0;
          targetRoute.totalTime = 0;
          
          targetRoute.stops.forEach((stop, index) => {
            const distance = calculateHaversineDistance(prevLat, prevLng, stop.latitude, stop.longitude);
            const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
            
            targetRoute.totalDistance += distance;
            targetRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
            
            if (index < targetRoute.stops.length - 1) {
              const nextStop = targetRoute.stops[index + 1];
              stop.distanceToNext = calculateHaversineDistance(
                stop.latitude, stop.longitude,
                nextStop.latitude, nextStop.longitude
              );
              stop.timeToNext = calculateTravelTime(stop.distanceToNext, TRAVEL_SPEED);
            } else {
              stop.distanceToNext = 0;
              stop.timeToNext = 0;
            }
            
            prevLat = stop.latitude;
            prevLng = stop.longitude;
          });
          
          continue; // Skip adding current route since it was merged
        }
        
        // If we can't merge and have less than minimum required outlets,
        // return customers to unassigned pool for redistribution
        unassignedCustomers.push(...currentRoute.stops.map(stop => ({
          id: stop.customerId,
          latitude: stop.latitude,
          longitude: stop.longitude,
          clusterId: stop.clusterId
        })));
        continue; // Skip adding current route
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
      if (currentRoute.stops.length >= MIN_OUTLETS_PER_BEAT) {
        routes.push(currentRoute);
      }
    }
  }
  
  // Final pass to merge any remaining small beats
  const finalRoutes = routes.reduce((acc, route) => {
    if (route.stops.length >= MIN_OUTLETS_PER_BEAT) {
      acc.push(route);
      return acc;
    }
    
    // Find best route to merge with
    let bestRouteIndex = -1;
    let minDistance = Infinity;
    
    acc.forEach((existingRoute, index) => {
      if (existingRoute.clusterIds[0] === route.clusterIds[0] &&
          existingRoute.stops.length + route.stops.length <= MAX_OUTLETS_PER_BEAT) {
        const lastStop = existingRoute.stops[existingRoute.stops.length - 1];
        const firstStop = route.stops[0];
        const distance = calculateHaversineDistance(
          lastStop.latitude, lastStop.longitude,
          firstStop.latitude, firstStop.longitude
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          bestRouteIndex = index;
        }
      }
    });
    
    if (bestRouteIndex !== -1) {
      const targetRoute = acc[bestRouteIndex];
      targetRoute.stops.push(...route.stops);
      
      // Recalculate metrics
      let prevLat = distributor.latitude;
      let prevLng = distributor.longitude;
      targetRoute.totalDistance = 0;
      targetRoute.totalTime = 0;
      
      targetRoute.stops.forEach((stop, index) => {
        const distance = calculateHaversineDistance(prevLat, prevLng, stop.latitude, stop.longitude);
        const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
        
        targetRoute.totalDistance += distance;
        targetRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
        
        if (index < targetRoute.stops.length - 1) {
          const nextStop = targetRoute.stops[index + 1];
          stop.distanceToNext = calculateHaversineDistance(
            stop.latitude, stop.longitude,
            nextStop.latitude, nextStop.longitude
          );
          stop.timeToNext = calculateTravelTime(stop.distanceToNext, TRAVEL_SPEED);
        } else {
          stop.distanceToNext = 0;
          stop.timeToNext = 0;
        }
        
        prevLat = stop.latitude;
        prevLng = stop.longitude;
      });
    }
    
    return acc;
  }, [] as SalesmanRoute[]);
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: 'Nearest Neighbor (Clustered)',
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};