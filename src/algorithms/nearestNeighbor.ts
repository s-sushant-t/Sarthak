import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-optimized nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Calculate median distance between all outlets for constraint
  const medianDistance = calculateMedianDistance(customers);
  console.log(`Median distance between outlets: ${medianDistance.toFixed(2)} km`);
  
  // CRITICAL: Track all customers to ensure no duplicates or missing outlets
  const allCustomers = [...customers];
  const globalAssignedCustomerIds = new Set<string>();
  
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
  
  // Process each cluster independently to ensure no cross-cluster contamination
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    console.log(`Target: ${config.beatsPerCluster} beats for this cluster`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create proximity-based linear routes within the cluster with median distance constraint
    const clusterRoutes = createProximityBasedRoutesInCluster(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds,
      medianDistance
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned`);
    
    if (assignedInCluster !== clusterSize) {
      console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
      
      // Find and assign missing customers
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
      
      // Force assign missing customers to the route with the least customers
      missingCustomers.forEach(customer => {
        const targetRoute = clusterRoutes.reduce((min, route) => 
          route.stops.length < min.stops.length ? route : min
        );
        
        if (targetRoute && targetRoute.stops.length < config.maxOutletsPerBeat) {
          targetRoute.stops.push({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          });
          clusterAssignedIds.add(customer.id);
          console.log(`Force-assigned missing customer ${customer.id} to route ${targetRoute.salesmanId}`);
        }
      });
    }
    
    // Add cluster customers to global tracking
    clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
    
    routes.push(...clusterRoutes);
    currentSalesmanId += clusterRoutes.length;
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} proximity-based beats created`);
  }
  
  // CRITICAL: Final verification - ensure ALL customers are assigned exactly once
  const finalAssignedCount = globalAssignedCustomerIds.size;
  const totalCustomers = allCustomers.length;
  
  console.log(`GLOBAL VERIFICATION: ${finalAssignedCount}/${totalCustomers} customers assigned`);
  
  if (finalAssignedCount !== totalCustomers) {
    console.error(`CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
    
    // Emergency assignment of missing customers
    const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
    console.error('Missing customers:', missingCustomers.map(c => c.id));
    
    missingCustomers.forEach(customer => {
      // Find a route in the same cluster with space
      const sameClusterRoutes = routes.filter(route => 
        route.clusterIds.includes(customer.clusterId) && 
        route.stops.length < config.maxOutletsPerBeat
      );
      
      let targetRoute = sameClusterRoutes[0];
      
      if (!targetRoute) {
        // Create emergency route if no space in existing routes
        targetRoute = {
          salesmanId: currentSalesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [customer.clusterId],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        routes.push(targetRoute);
      }
      
      targetRoute.stops.push({
        customerId: customer.id,
        latitude: customer.latitude,
        longitude: customer.longitude,
        distanceToNext: 0,
        timeToNext: 0,
        visitTime: config.customerVisitTimeMinutes,
        clusterId: customer.clusterId,
        outletName: customer.outletName
      });
      
      globalAssignedCustomerIds.add(customer.id);
      console.log(`Emergency assigned customer ${customer.id} to route ${targetRoute.salesmanId}`);
    });
  }
  
  // Update route metrics for all routes
  routes.forEach(route => {
    updateRouteMetrics(route, distributor, config);
  });
  
  // Reassign beat IDs sequentially
  const finalRoutes = routes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
  
  // FINAL verification
  const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(finalRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`FINAL VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  console.log(`- Total beats created: ${finalRoutes.length}`);
  
  // Report beats per cluster
  const beatsByCluster = finalRoutes.reduce((acc, route) => {
    route.clusterIds.forEach(clusterId => {
      if (!acc[clusterId]) acc[clusterId] = 0;
      acc[clusterId]++;
    });
    return acc;
  }, {} as Record<number, number>);
  
  console.log('Beats per cluster:', beatsByCluster);
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`FINAL ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Proximity-Optimized Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function calculateMedianDistance(customers: ClusteredCustomer[]): number {
  const distances: number[] = [];
  
  // Calculate distances between all pairs of customers
  for (let i = 0; i < customers.length; i++) {
    for (let j = i + 1; j < customers.length; j++) {
      const distance = calculateHaversineDistance(
        customers[i].latitude, customers[i].longitude,
        customers[j].latitude, customers[j].longitude
      );
      distances.push(distance);
    }
  }
  
  // Sort distances and find median
  distances.sort((a, b) => a - b);
  const midIndex = Math.floor(distances.length / 2);
  
  if (distances.length % 2 === 0) {
    return (distances[midIndex - 1] + distances[midIndex]) / 2;
  } else {
    return distances[midIndex];
  }
}

function createProximityBasedRoutesInCluster(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  medianDistance: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating proximity-based routes for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`Median distance constraint: ${medianDistance.toFixed(2)} km`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Create beats one by one using proximity-based selection with median distance constraint
  while (remainingCustomers.length > 0) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Calculate target size for this beat
    const remainingBeats = Math.max(1, config.beatsPerCluster - routes.length);
    const targetSize = Math.min(
      Math.ceil(remainingCustomers.length / remainingBeats),
      config.maxOutletsPerBeat
    );
    
    console.log(`Creating beat ${route.salesmanId}: targeting ${targetSize} outlets from ${remainingCustomers.length} remaining`);
    
    // Build route using proximity-based nearest neighbor with median distance constraint
    let currentLat = distributor.latitude;
    let currentLng = distributor.longitude;
    
    for (let i = 0; i < targetSize && remainingCustomers.length > 0; i++) {
      let nearestIndex = -1;
      let shortestDistance = Infinity;
      
      // Find the nearest unvisited customer that satisfies the median distance constraint
      for (let j = 0; j < remainingCustomers.length; j++) {
        const customer = remainingCustomers[j];
        const distance = calculateHaversineDistance(
          currentLat, currentLng,
          customer.latitude, customer.longitude
        );
        
        // Check if adding this customer would violate the median distance constraint
        if (route.stops.length > 0) {
          const violatesConstraint = route.stops.some(stop => {
            const distanceToStop = calculateHaversineDistance(
              customer.latitude, customer.longitude,
              stop.latitude, stop.longitude
            );
            return distanceToStop > medianDistance;
          });
          
          if (violatesConstraint) {
            continue; // Skip this customer as it violates the median distance constraint
          }
        }
        
        if (distance < shortestDistance) {
          shortestDistance = distance;
          nearestIndex = j;
        }
      }
      
      // If no customer satisfies the constraint, try to find the best available option
      if (nearestIndex === -1 && remainingCustomers.length > 0) {
        console.log(`No customer satisfies median distance constraint for beat ${route.salesmanId}, finding best compromise...`);
        
        // Find customer with minimum constraint violations
        let bestCustomerIndex = -1;
        let minViolations = Infinity;
        
        for (let j = 0; j < remainingCustomers.length; j++) {
          const customer = remainingCustomers[j];
          let violations = 0;
          
          if (route.stops.length > 0) {
            route.stops.forEach(stop => {
              const distanceToStop = calculateHaversineDistance(
                customer.latitude, customer.longitude,
                stop.latitude, stop.longitude
              );
              if (distanceToStop > medianDistance) {
                violations += distanceToStop - medianDistance; // Count excess distance as violation
              }
            });
          }
          
          if (violations < minViolations) {
            minViolations = violations;
            bestCustomerIndex = j;
          }
        }
        
        if (bestCustomerIndex !== -1) {
          nearestIndex = bestCustomerIndex;
          console.log(`Selected customer with minimal constraint violation: ${minViolations.toFixed(2)} km excess`);
        }
      }
      
      if (nearestIndex === -1) break;
      
      // Remove customer from remaining and add to route
      const nearestCustomer = remainingCustomers.splice(nearestIndex, 1)[0];
      
      // CRITICAL: Ensure no duplicate assignment
      if (assignedIds.has(nearestCustomer.id)) {
        console.error(`DUPLICATE ASSIGNMENT DETECTED: Customer ${nearestCustomer.id} already assigned!`);
        continue;
      }
      
      assignedIds.add(nearestCustomer.id);
      
      route.stops.push({
        customerId: nearestCustomer.id,
        latitude: nearestCustomer.latitude,
        longitude: nearestCustomer.longitude,
        distanceToNext: 0,
        timeToNext: 0,
        visitTime: config.customerVisitTimeMinutes,
        clusterId: nearestCustomer.clusterId,
        outletName: nearestCustomer.outletName
      });
      
      // Update current position for next nearest neighbor search
      currentLat = nearestCustomer.latitude;
      currentLng = nearestCustomer.longitude;
    }
    
    if (route.stops.length > 0) {
      // Apply 2-opt optimization to improve route linearity while maintaining median distance constraint
      optimizeRouteFor2OptWithConstraint(route, distributor, medianDistance);
      routes.push(route);
      console.log(`Created proximity beat ${route.salesmanId} with ${route.stops.length} stops (median distance constraint applied)`);
    }
    
    // Safety check to prevent infinite loops
    if (routes.length >= config.beatsPerCluster * 2) {
      console.warn(`Safety break: Created ${routes.length} routes for cluster ${clusterId}`);
      break;
    }
  }
  
  // If there are still remaining customers, distribute them to existing routes
  if (remainingCustomers.length > 0) {
    console.log(`Distributing ${remainingCustomers.length} remaining customers to existing routes...`);
    
    remainingCustomers.forEach(customer => {
      if (assignedIds.has(customer.id)) {
        console.warn(`Customer ${customer.id} already assigned, skipping`);
        return;
      }
      
      // Find the route with space that would have minimum distance increase and satisfies median constraint
      let bestRoute = null;
      let minDistanceIncrease = Infinity;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat) {
          // Check if adding this customer would violate median distance constraint
          const violatesConstraint = route.stops.some(stop => {
            const distanceToStop = calculateHaversineDistance(
              customer.latitude, customer.longitude,
              stop.latitude, stop.longitude
            );
            return distanceToStop > medianDistance;
          });
          
          if (!violatesConstraint) {
            const distanceIncrease = calculateInsertionCost(route, customer, distributor);
            if (distanceIncrease < minDistanceIncrease) {
              minDistanceIncrease = distanceIncrease;
              bestRoute = route;
            }
          }
        }
      }
      
      // If no route satisfies the constraint, find the route with minimal violation
      if (!bestRoute) {
        console.log(`No route satisfies median distance constraint for customer ${customer.id}, finding best compromise...`);
        
        let minViolation = Infinity;
        for (const route of routes) {
          if (route.stops.length < config.maxOutletsPerBeat) {
            let maxViolation = 0;
            route.stops.forEach(stop => {
              const distanceToStop = calculateHaversineDistance(
                customer.latitude, customer.longitude,
                stop.latitude, stop.longitude
              );
              if (distanceToStop > medianDistance) {
                maxViolation = Math.max(maxViolation, distanceToStop - medianDistance);
              }
            });
            
            if (maxViolation < minViolation) {
              minViolation = maxViolation;
              bestRoute = route;
            }
          }
        }
      }
      
      if (bestRoute) {
        const insertionPoint = findBestInsertionPoint(bestRoute, customer, distributor);
        bestRoute.stops.splice(insertionPoint, 0, {
          customerId: customer.id,
          latitude: customer.latitude,
          longitude: customer.longitude,
          distanceToNext: 0,
          timeToNext: 0,
          visitTime: config.customerVisitTimeMinutes,
          clusterId: customer.clusterId,
          outletName: customer.outletName
        });
        
        assignedIds.add(customer.id);
        console.log(`Distributed customer ${customer.id} to route ${bestRoute.salesmanId}`);
      }
    });
  }
  
  return routes;
}

function optimizeRouteFor2OptWithConstraint(
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number },
  medianDistance: number
): void {
  if (route.stops.length < 4) return;
  
  let improved = true;
  let iterations = 0;
  const maxIterations = 10; // Limit iterations to prevent excessive processing
  
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    
    for (let i = 1; i < route.stops.length - 2; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        if (j - i === 1) continue; // Skip adjacent edges
        
        // Calculate current distance
        const currentDistance = 
          calculateHaversineDistance(
            i === 1 ? distributor.latitude : route.stops[i - 1].latitude,
            i === 1 ? distributor.longitude : route.stops[i - 1].longitude,
            route.stops[i].latitude, route.stops[i].longitude
          ) +
          calculateHaversineDistance(
            route.stops[j - 1].latitude, route.stops[j - 1].longitude,
            route.stops[j].latitude, route.stops[j].longitude
          );
        
        // Calculate distance after 2-opt swap
        const newDistance = 
          calculateHaversineDistance(
            i === 1 ? distributor.latitude : route.stops[i - 1].latitude,
            i === 1 ? distributor.longitude : route.stops[i - 1].longitude,
            route.stops[j - 1].latitude, route.stops[j - 1].longitude
          ) +
          calculateHaversineDistance(
            route.stops[i].latitude, route.stops[i].longitude,
            route.stops[j].latitude, route.stops[j].longitude
          );
        
        // Check if the swap would violate median distance constraint
        const newStops = [
          ...route.stops.slice(0, i),
          ...route.stops.slice(i, j).reverse(),
          ...route.stops.slice(j)
        ];
        
        const violatesConstraint = checkMedianDistanceConstraint(newStops, medianDistance);
        
        // If improvement found and doesn't violate constraint, apply 2-opt swap
        if (newDistance < currentDistance && !violatesConstraint) {
          route.stops = newStops;
          improved = true;
        }
      }
    }
  }
}

function checkMedianDistanceConstraint(stops: RouteStop[], medianDistance: number): boolean {
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      if (distance > medianDistance) {
        return true; // Constraint violated
      }
    }
  }
  return false; // Constraint satisfied
}

function calculateInsertionCost(
  route: SalesmanRoute,
  customer: ClusteredCustomer,
  distributor: { latitude: number; longitude: number }
): number {
  if (route.stops.length === 0) {
    return calculateHaversineDistance(
      distributor.latitude, distributor.longitude,
      customer.latitude, customer.longitude
    );
  }
  
  // Calculate cost of inserting at the end
  const lastStop = route.stops[route.stops.length - 1];
  return calculateHaversineDistance(
    lastStop.latitude, lastStop.longitude,
    customer.latitude, customer.longitude
  );
}

function findBestInsertionPoint(
  route: SalesmanRoute,
  customer: ClusteredCustomer,
  distributor: { latitude: number; longitude: number }
): number {
  if (route.stops.length === 0) return 0;
  
  let bestPosition = route.stops.length;
  let minIncrease = Infinity;
  
  for (let i = 0; i <= route.stops.length; i++) {
    let increase = 0;
    
    if (i === 0) {
      // Inserting at the beginning
      const distToCustomer = calculateHaversineDistance(
        distributor.latitude, distributor.longitude,
        customer.latitude, customer.longitude
      );
      const distFromCustomer = route.stops.length > 0 ? 
        calculateHaversineDistance(
          customer.latitude, customer.longitude,
          route.stops[0].latitude, route.stops[0].longitude
        ) : 0;
      const originalDist = route.stops.length > 0 ?
        calculateHaversineDistance(
          distributor.latitude, distributor.longitude,
          route.stops[0].latitude, route.stops[0].longitude
        ) : 0;
      
      increase = distToCustomer + distFromCustomer - originalDist;
    } else if (i === route.stops.length) {
      // Inserting at the end
      const lastStop = route.stops[route.stops.length - 1];
      increase = calculateHaversineDistance(
        lastStop.latitude, lastStop.longitude,
        customer.latitude, customer.longitude
      );
    } else {
      // Inserting in the middle
      const prevStop = route.stops[i - 1];
      const nextStop = route.stops[i];
      
      const distToPrev = calculateHaversineDistance(
        prevStop.latitude, prevStop.longitude,
        customer.latitude, customer.longitude
      );
      const distToNext = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        nextStop.latitude, nextStop.longitude
      );
      const originalDist = calculateHaversineDistance(
        prevStop.latitude, prevStop.longitude,
        nextStop.latitude, nextStop.longitude
      );
      
      increase = distToPrev + distToNext - originalDist;
    }
    
    if (increase < minIncrease) {
      minIncrease = increase;
      bestPosition = i;
    }
  }
  
  return bestPosition;
}

function updateRouteMetrics(
  route: SalesmanRoute, 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): void {
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
    
    const travelTime = calculateTravelTime(distance, config.travelSpeedKmh);
    
    route.totalDistance += distance;
    route.totalTime += travelTime + config.customerVisitTimeMinutes;
    
    if (i < route.stops.length - 1) {
      const nextStop = route.stops[i + 1];
      const nextDistance = calculateHaversineDistance(
        stop.latitude, stop.longitude,
        nextStop.latitude, nextStop.longitude
      );
      
      const nextTime = calculateTravelTime(nextDistance, config.travelSpeedKmh);
      
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