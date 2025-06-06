import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 30; // Updated minimum outlets per beat
const MAX_OUTLETS_PER_BEAT = 45; // Updated maximum outlets per beat
const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
const MAX_WORKING_TIME = 360; // 6 hours in minutes
const TRAVEL_SPEED = 30; // km/h
const MAX_DISTANCE_VARIANCE = 5; // Maximum allowed distance variance between beats (in km)

export const nearestNeighbor = async (locationData: LocationData): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting nearest neighbor algorithm with ${customers.length} total customers`);
  
  // Create a copy of all customers to track which ones have been assigned
  const allCustomers = [...customers];
  const assignedCustomerIds = new Set<string>();
  
  // Group customers by cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  console.log('Customers by cluster:', Object.entries(customersByCluster).map(([id, custs]) => 
    `Cluster ${id}: ${custs.length} customers`
  ));
  
  const routes: SalesmanRoute[] = [];
  let currentSalesmanId = 1;
  
  // Process each cluster
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    
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
        
        // Track that this customer has been assigned
        assignedCustomerIds.add(nearestCustomer.id);
        
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
        console.log(`Created route ${currentRoute.salesmanId} with ${currentRoute.stops.length} stops`);
      }
    }
  }
  
  // CRITICAL: Check for any unassigned customers and force them into routes
  const unassignedCustomers = allCustomers.filter(customer => !assignedCustomerIds.has(customer.id));
  
  if (unassignedCustomers.length > 0) {
    console.warn(`Found ${unassignedCustomers.length} unassigned customers! Force-assigning them...`);
    
    // Force assign unassigned customers to existing routes or create new ones
    while (unassignedCustomers.length > 0) {
      // Try to add to existing routes first
      let assigned = false;
      
      for (const route of routes) {
        if (route.stops.length < MAX_OUTLETS_PER_BEAT && unassignedCustomers.length > 0) {
          const customer = unassignedCustomers.shift()!;
          
          route.stops.push({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: CUSTOMER_VISIT_TIME,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          });
          
          assignedCustomerIds.add(customer.id);
          assigned = true;
          console.log(`Force-assigned customer ${customer.id} to route ${route.salesmanId}`);
        }
      }
      
      // If no existing route can accommodate, create a new route
      if (!assigned && unassignedCustomers.length > 0) {
        const newRoute: SalesmanRoute = {
          salesmanId: currentSalesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        
        // Add up to MAX_OUTLETS_PER_BEAT customers to this new route
        const customersToAdd = Math.min(MAX_OUTLETS_PER_BEAT, unassignedCustomers.length);
        const clusterIds = new Set<number>();
        
        for (let i = 0; i < customersToAdd; i++) {
          const customer = unassignedCustomers.shift()!;
          clusterIds.add(customer.clusterId);
          
          newRoute.stops.push({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: CUSTOMER_VISIT_TIME,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          });
          
          assignedCustomerIds.add(customer.id);
        }
        
        newRoute.clusterIds = Array.from(clusterIds);
        routes.push(newRoute);
        console.log(`Created new route ${newRoute.salesmanId} for ${customersToAdd} unassigned customers`);
      }
    }
  }
  
  // Final verification: ensure all customers are assigned
  const finalAssignedCount = assignedCustomerIds.size;
  const totalCustomers = allCustomers.length;
  
  console.log(`Assignment verification: ${finalAssignedCount}/${totalCustomers} customers assigned`);
  
  if (finalAssignedCount !== totalCustomers) {
    console.error(`CRITICAL: Missing ${totalCustomers - finalAssignedCount} customers in route assignment!`);
    
    // Emergency fallback: find missing customers and force assign them
    const missingCustomers = allCustomers.filter(customer => !assignedCustomerIds.has(customer.id));
    console.error('Missing customers:', missingCustomers.map(c => c.id));
    
    // Add missing customers to the last route or create a new one
    if (missingCustomers.length > 0) {
      let targetRoute = routes[routes.length - 1];
      
      if (!targetRoute || targetRoute.stops.length >= MAX_OUTLETS_PER_BEAT) {
        targetRoute = {
          salesmanId: currentSalesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        routes.push(targetRoute);
      }
      
      missingCustomers.forEach(customer => {
        targetRoute.stops.push({
          customerId: customer.id,
          latitude: customer.latitude,
          longitude: customer.longitude,
          distanceToNext: 0,
          timeToNext: 0,
          visitTime: CUSTOMER_VISIT_TIME,
          clusterId: customer.clusterId,
          outletName: customer.outletName
        });
        
        if (!targetRoute.clusterIds.includes(customer.clusterId)) {
          targetRoute.clusterIds.push(customer.clusterId);
        }
      });
      
      console.log(`Emergency assignment: Added ${missingCustomers.length} missing customers to route ${targetRoute.salesmanId}`);
    }
  }
  
  // Balance routes within clusters
  const routesByCluster = routes.reduce((acc, route) => {
    const clusterId = route.clusterIds[0] || 0;
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
  
  // Final verification of customer assignment
  const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
  console.log(`Final verification: ${finalCustomerCount}/${totalCustomers} customers in final routes`);
  
  if (finalCustomerCount !== totalCustomers) {
    console.error(`FINAL ERROR: Route generation lost ${totalCustomers - finalCustomerCount} customers!`);
  }
  
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