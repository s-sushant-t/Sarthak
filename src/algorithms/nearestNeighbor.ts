import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 30; // Minimum outlets per beat
const MAX_OUTLETS_PER_BEAT = 40; // Maximum outlets per beat
const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
const MAX_WORKING_TIME = 360; // 6 hours in minutes
const TRAVEL_SPEED = 30; // km/h
const MAX_DISTANCE_VARIANCE = 5; // Maximum allowed distance variance between beats (in km)

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
        clusterIds: [Number(clusterId)],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
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
          clusterId: nearestCustomer.clusterId,
          outletName: nearestCustomer.outletName
        });
        
        currentRoute.totalDistance += shortestDistance;
        currentRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
        remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
        
        currentLat = nearestCustomer.latitude;
        currentLng = nearestCustomer.longitude;
      }
      
      if (currentRoute.stops.length > 0) {
        routes.push(currentRoute);
      }
    }
  }
  
  // Balance routes within clusters
  const routesByCluster = routes.reduce((acc, route) => {
    const clusterId = route.clusterIds[0];
    if (!acc[clusterId]) acc[clusterId] = [];
    acc[clusterId].push(route);
    return acc;
  }, {} as Record<number, SalesmanRoute[]>);
  
  const balancedRoutes: SalesmanRoute[] = [];
  
  for (const clusterId in routesByCluster) {
    const clusterRoutes = routesByCluster[clusterId];
    let iterations = 0;
    const MAX_BALANCE_ITERATIONS = 100;
    
    while (iterations < MAX_BALANCE_ITERATIONS) {
      const avgDistance = clusterRoutes.reduce((sum, r) => sum + r.totalDistance, 0) / clusterRoutes.length;
      const maxVariance = Math.max(...clusterRoutes.map(r => Math.abs(r.totalDistance - avgDistance)));
      
      if (maxVariance <= MAX_DISTANCE_VARIANCE) break;
      
      // Find the most unbalanced pair of routes
      let maxRoute = clusterRoutes[0];
      let minRoute = clusterRoutes[0];
      
      for (const route of clusterRoutes) {
        if (route.totalDistance > maxRoute.totalDistance) maxRoute = route;
        if (route.totalDistance < minRoute.totalDistance) minRoute = route;
      }
      
      // Try to move a stop from the longer route to the shorter one
      if (maxRoute.stops.length > MIN_OUTLETS_PER_BEAT && 
          minRoute.stops.length < MAX_OUTLETS_PER_BEAT) {
        // Find the stop that would best balance the routes
        let bestStop = null;
        let bestImprovement = 0;
        
        for (let i = 0; i < maxRoute.stops.length; i++) {
          const stop = maxRoute.stops[i];
          const distanceContribution = calculateHaversineDistance(
            maxRoute.stops[i-1]?.latitude || maxRoute.distributorLat,
            maxRoute.stops[i-1]?.longitude || maxRoute.distributorLng,
            stop.latitude,
            stop.longitude
          );
          
          if (Math.abs(maxRoute.totalDistance - minRoute.totalDistance - 2 * distanceContribution) < bestImprovement) {
            bestStop = i;
            bestImprovement = Math.abs(maxRoute.totalDistance - minRoute.totalDistance - 2 * distanceContribution);
          }
        }
        
        if (bestStop !== null) {
          const [stop] = maxRoute.stops.splice(bestStop, 1);
          minRoute.stops.push(stop);
          updateRouteMetrics(maxRoute, distributor);
          updateRouteMetrics(minRoute, distributor);
        }
      }
      
      iterations++;
    }
    
    balancedRoutes.push(...clusterRoutes);
  }
  
  // Optimize beats to ensure they meet size requirements
  const optimizedRoutes = balancedRoutes.reduce((acc, route) => {
    if (route.stops.length >= MIN_OUTLETS_PER_BEAT && route.stops.length <= MAX_OUTLETS_PER_BEAT) {
      // Route is within acceptable range
      acc.push(route);
    } else if (route.stops.length < MIN_OUTLETS_PER_BEAT) {
      // Try to merge with another small route from the same cluster
      const mergeCandidate = acc.find(r => 
        r.clusterIds[0] === route.clusterIds[0] && 
        r.stops.length + route.stops.length <= MAX_OUTLETS_PER_BEAT
      );
      
      if (mergeCandidate) {
        mergeCandidate.stops.push(...route.stops);
        updateRouteMetrics(mergeCandidate, distributor);
      } else {
        acc.push(route);
      }
    } else {
      // Split route that exceeds maximum size
      const midPoint = Math.ceil(route.stops.length / 2);
      
      const route1: SalesmanRoute = {
        ...route,
        stops: route.stops.slice(0, midPoint),
        totalDistance: 0,
        totalTime: 0
      };
      
      const route2: SalesmanRoute = {
        ...route,
        stops: route.stops.slice(midPoint),
        totalDistance: 0,
        totalTime: 0
      };
      
      updateRouteMetrics(route1, distributor);
      updateRouteMetrics(route2, distributor);
      
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

function updateRouteMetrics(route: SalesmanRoute, distributor: { latitude: number; longitude: number }): void {
  route.totalDistance = 0;
  route.totalTime = 0;
  
  if (route.stops.length === 0) return;
  
  let prevLat = distributor.latitude;
  let prevLng = distributor.longitude;
  
  for (let i = 0; i < route.stops.length; i++) {
    const stop = route.stops[i];
    const distance = calculateHaversineDistance(
      prevLat, prevLng,
      stop.latitude, stop.longitude
    );
    
    const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
    
    route.totalDistance += distance;
    route.totalTime += travelTime + CUSTOMER_VISIT_TIME;
    
    if (i < route.stops.length - 1) {
      const nextStop = route.stops[i + 1];
      const nextDistance = calculateHaversineDistance(
        stop.latitude, stop.longitude,
        nextStop.latitude, nextStop.longitude
      );
      
      const nextTime = calculateTravelTime(nextDistance, TRAVEL_SPEED);
      
      stop.distanceToNext = nextDistance;
      stop.timeToNext = nextTime;
    } else {
      stop.distanceToNext = 0;
      stop.timeToNext = 0;
    }
    
    prevLat = stop.latitude;
    prevLng = stop.longitude;
  }
}