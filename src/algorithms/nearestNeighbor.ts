import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 28; // Minimum outlets per beat
const MAX_OUTLETS_PER_BEAT = 35; // Maximum outlets per beat
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
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    
    while (clusterCustomers.length > 0) {
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
      const remainingOutlets = clusterCustomers.length;
      let targetOutlets = MAX_OUTLETS_PER_BEAT;
      
      if (remainingOutlets <= MAX_OUTLETS_PER_BEAT) {
        targetOutlets = remainingOutlets;
      } else if (remainingOutlets < (MAX_OUTLETS_PER_BEAT * 2)) {
        // If remaining outlets can't form two full beats, split them more evenly
        targetOutlets = Math.ceil(remainingOutlets / 2);
      }
      
      while (clusterCustomers.length > 0 && 
             remainingTime > 0 && 
             currentRoute.stops.length < targetOutlets) {
        let nearestIndex = -1;
        let shortestDistance = Infinity;
        
        for (let i = 0; i < clusterCustomers.length; i++) {
          const customer = clusterCustomers[i];
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
        
        const nearestCustomer = clusterCustomers.splice(nearestIndex, 1)[0];
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
      
      if (currentRoute.stops.length > 0) {
        routes.push(currentRoute);
      }
    }
  }
  
  // Optimize beats to ensure they meet the size requirements
  const optimizedRoutes = routes.reduce((acc, route) => {
    if (route.stops.length >= MIN_OUTLETS_PER_BEAT && route.stops.length <= MAX_OUTLETS_PER_BEAT) {
      // Route is within acceptable range, keep as is
      acc.push(route);
    } else if (route.stops.length < MIN_OUTLETS_PER_BEAT) {
      // Try to merge with another small route from the same cluster
      const mergeCandidate = acc.find(r => 
        r.clusterIds[0] === route.clusterIds[0] && 
        r.stops.length + route.stops.length <= MAX_OUTLETS_PER_BEAT
      );
      
      if (mergeCandidate) {
        mergeCandidate.stops.push(...route.stops);
        
        // Recalculate metrics
        let prevLat = distributor.latitude;
        let prevLng = distributor.longitude;
        mergeCandidate.totalDistance = 0;
        mergeCandidate.totalTime = 0;
        
        mergeCandidate.stops.forEach((stop, index) => {
          const distance = calculateHaversineDistance(prevLat, prevLng, stop.latitude, stop.longitude);
          const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
          
          mergeCandidate.totalDistance += distance;
          mergeCandidate.totalTime += travelTime + CUSTOMER_VISIT_TIME;
          
          if (index < mergeCandidate.stops.length - 1) {
            const nextStop = mergeCandidate.stops[index + 1];
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
      } else {
        // If we can't merge, keep the route
        acc.push(route);
      }
    } else {
      // Route has too many stops, split it
      const midPoint = Math.ceil(route.stops.length / 2);
      
      const route1: SalesmanRoute = {
        salesmanId: currentSalesmanId++,
        stops: route.stops.slice(0, midPoint),
        totalDistance: 0,
        totalTime: 0,
        clusterIds: route.clusterIds
      };
      
      const route2: SalesmanRoute = {
        salesmanId: currentSalesmanId++,
        stops: route.stops.slice(midPoint),
        totalDistance: 0,
        totalTime: 0,
        clusterIds: route.clusterIds
      };
      
      // Recalculate metrics for both routes
      [route1, route2].forEach(newRoute => {
        let prevLat = distributor.latitude;
        let prevLng = distributor.longitude;
        
        newRoute.stops.forEach((stop, index) => {
          const distance = calculateHaversineDistance(prevLat, prevLng, stop.latitude, stop.longitude);
          const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
          
          newRoute.totalDistance += distance;
          newRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
          
          if (index < newRoute.stops.length - 1) {
            const nextStop = newRoute.stops[index + 1];
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
      });
      
      acc.push(route1);
      if (route2.stops.length > 0) {
        acc.push(route2);
      }
    }
    
    return acc;
  }, [] as SalesmanRoute[]);
  
  // Reassign beat IDs sequentially
  const finalRoutes = optimizedRoutes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
  
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