import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 30;
const MAX_WORKING_TIME = 360; // 6 hours in minutes
const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
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
      
      // Fill route until we can't add more customers
      while (unassignedCustomers.length > 0 && remainingTime > 0) {
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
      
      // If route has less than minimum required outlets, distribute them to other routes
      if (currentRoute.stops.length < MIN_OUTLETS_PER_BEAT && routes.length > 0) {
        // Put customers back in unassigned pool
        unassignedCustomers.push(...currentRoute.stops);
        currentSalesmanId--; // Reuse the salesman ID
        
        // Try to distribute to existing routes
        const redistributed = redistributeCustomers(
          currentRoute.stops,
          routes,
          distributor,
          MAX_WORKING_TIME
        );
        
        if (!redistributed) {
          // If redistribution failed, keep the route as is
          updateRouteMetrics(currentRoute, distributor);
          routes.push(currentRoute);
        }
      } else if (currentRoute.stops.length > 0) {
        updateRouteMetrics(currentRoute, distributor);
        routes.push(currentRoute);
      }
    }
  }
  
  // Final check for any routes with too few outlets
  const finalRoutes = consolidateRoutes(routes, distributor);
  
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

function redistributeCustomers(
  customers: RouteStop[],
  existingRoutes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  maxWorkingTime: number
): boolean {
  let success = true;
  
  for (const customer of customers) {
    let assigned = false;
    
    // Find the best route to add this customer
    for (const route of existingRoutes) {
      if (canAddCustomerToRoute(customer, route, distributor, maxWorkingTime)) {
        route.stops.push(customer);
        updateRouteMetrics(route, distributor);
        assigned = true;
        break;
      }
    }
    
    if (!assigned) {
      success = false;
      break;
    }
  }
  
  return success;
}

function canAddCustomerToRoute(
  customer: RouteStop,
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number },
  maxWorkingTime: number
): boolean {
  const tempRoute = { ...route, stops: [...route.stops, customer] };
  updateRouteMetrics(tempRoute, distributor);
  return tempRoute.totalTime <= maxWorkingTime;
}

function consolidateRoutes(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number }
): SalesmanRoute[] {
  const finalRoutes: SalesmanRoute[] = [];
  let routesToConsolidate = routes.filter(r => r.stops.length < MIN_OUTLETS_PER_BEAT);
  
  // First, add all valid routes
  routes
    .filter(r => r.stops.length >= MIN_OUTLETS_PER_BEAT)
    .forEach(r => finalRoutes.push({ ...r }));
  
  // Try to consolidate small routes
  while (routesToConsolidate.length > 0) {
    const currentRoute = routesToConsolidate[0];
    let consolidated = false;
    
    // Try to merge with another small route
    for (let i = 1; i < routesToConsolidate.length; i++) {
      const otherRoute = routesToConsolidate[i];
      const mergedStops = [...currentRoute.stops, ...otherRoute.stops];
      
      const mergedRoute: SalesmanRoute = {
        salesmanId: currentRoute.salesmanId,
        stops: mergedStops,
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [...new Set([...currentRoute.clusterIds, ...otherRoute.clusterIds])]
      };
      
      updateRouteMetrics(mergedRoute, distributor);
      
      if (mergedRoute.totalTime <= MAX_WORKING_TIME) {
        finalRoutes.push(mergedRoute);
        routesToConsolidate = routesToConsolidate.filter(
          r => r !== currentRoute && r !== otherRoute
        );
        consolidated = true;
        break;
      }
    }
    
    if (!consolidated) {
      // If we can't consolidate, try to distribute to existing routes
      const redistributed = redistributeCustomers(
        currentRoute.stops,
        finalRoutes,
        distributor,
        MAX_WORKING_TIME
      );
      
      if (!redistributed) {
        // If we can't redistribute, keep the route as is
        finalRoutes.push(currentRoute);
      }
      
      routesToConsolidate = routesToConsolidate.filter(r => r !== currentRoute);
    }
  }
  
  // Renumber salesmanIds sequentially
  return finalRoutes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
}

function updateRouteMetrics(
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number }
): void {
  route.totalDistance = 0;
  route.totalTime = 0;
  
  let prevLat = distributor.latitude;
  let prevLng = distributor.longitude;
  
  route.stops.forEach((stop, index) => {
    const distance = calculateHaversineDistance(
      prevLat, prevLng,
      stop.latitude, stop.longitude
    );
    
    const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
    
    route.totalDistance += distance;
    route.totalTime += travelTime + stop.visitTime;
    
    if (index < route.stops.length - 1) {
      const nextStop = route.stops[index + 1];
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
  });
}