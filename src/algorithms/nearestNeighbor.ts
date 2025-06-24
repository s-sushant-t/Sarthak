import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting constraint-enforced nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`Beat constraints: ${config.minOutletsPerBeat}-${config.maxOutletsPerBeat} outlets per beat`);
  
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
  
  // Process each cluster independently with strict constraint enforcement
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create constraint-enforced routes within the cluster
    const clusterRoutes = createConstraintEnforcedRoutesInCluster(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned in ${clusterRoutes.length} beats`);
    
    // CRITICAL: Ensure no customers are lost
    if (assignedInCluster !== clusterSize) {
      console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
      
      // Find and assign missing customers
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
      
      // Force assign missing customers while respecting constraints
      missingCustomers.forEach(customer => {
        const targetRoute = clusterRoutes.find(r => r.stops.length < config.maxOutletsPerBeat);
        
        if (targetRoute) {
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
        } else {
          // Create emergency route if all routes are at max capacity
          const emergencyRoute: SalesmanRoute = {
            salesmanId: currentSalesmanId + clusterRoutes.length,
            stops: [{
              customerId: customer.id,
              latitude: customer.latitude,
              longitude: customer.longitude,
              distanceToNext: 0,
              timeToNext: 0,
              visitTime: config.customerVisitTimeMinutes,
              clusterId: customer.clusterId,
              outletName: customer.outletName
            }],
            totalDistance: 0,
            totalTime: 0,
            clusterIds: [Number(clusterId)],
            distributorLat: distributor.latitude,
            distributorLng: distributor.longitude
          };
          clusterRoutes.push(emergencyRoute);
          clusterAssignedIds.add(customer.id);
          console.log(`Created emergency route ${emergencyRoute.salesmanId} for customer ${customer.id}`);
        }
      });
    }
    
    // Add cluster customers to global tracking
    clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
    
    routes.push(...clusterRoutes);
    currentSalesmanId += clusterRoutes.length;
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} constraint-enforced beats created`);
  }
  
  // Apply constraint enforcement to all routes
  console.log('Applying constraint enforcement to all routes...');
  const constraintEnforcedRoutes = enforceAllConstraints(routes, distributor, config);
  
  // CRITICAL: Final verification - ensure ALL customers are assigned exactly once
  const finalAssignedCount = globalAssignedCustomerIds.size;
  const totalCustomers = allCustomers.length;
  
  console.log(`GLOBAL VERIFICATION: ${finalAssignedCount}/${totalCustomers} customers assigned`);
  
  if (finalAssignedCount !== totalCustomers) {
    console.error(`CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
  }
  
  // Reassign beat IDs sequentially
  const finalRoutes = constraintEnforcedRoutes.map((route, index) => ({
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
  
  // Report constraint adherence
  const constraintReport = analyzeConstraintAdherence(finalRoutes, config);
  console.log('Constraint adherence report:', constraintReport);
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`FINAL ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Constraint-Enforced Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function createConstraintEnforcedRoutesInCluster(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating constraint-enforced routes for cluster ${clusterId} with ${customers.length} customers`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Calculate optimal number of beats for this cluster
  const optimalBeats = Math.max(
    1,
    Math.min(
      config.beatsPerCluster,
      Math.ceil(customers.length / config.maxOutletsPerBeat)
    )
  );
  
  console.log(`Cluster ${clusterId}: Creating ${optimalBeats} beats for ${customers.length} customers`);
  
  // Create beats one by one with strict size constraints
  for (let beatIndex = 0; beatIndex < optimalBeats && remainingCustomers.length > 0; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Calculate target size for this beat with strict constraints
    const remainingBeats = optimalBeats - beatIndex;
    const remainingCustomersCount = remainingCustomers.length;
    
    let targetSize = Math.ceil(remainingCustomersCount / remainingBeats);
    
    // Enforce minimum constraint
    targetSize = Math.max(targetSize, config.minOutletsPerBeat);
    
    // Enforce maximum constraint
    targetSize = Math.min(targetSize, config.maxOutletsPerBeat);
    
    // Ensure we don't exceed remaining customers
    targetSize = Math.min(targetSize, remainingCustomersCount);
    
    console.log(`Beat ${route.salesmanId}: targeting ${targetSize} outlets (${remainingCustomersCount} remaining, ${remainingBeats} beats left)`);
    
    // Build route using proximity-based selection with median distance constraint
    const beatCustomers = selectCustomersForBeatWithConstraints(
      remainingCustomers,
      distributor,
      targetSize,
      config
    );
    
    // Remove selected customers from remaining pool
    beatCustomers.forEach(customer => {
      const index = remainingCustomers.findIndex(c => c.id === customer.id);
      if (index !== -1) {
        remainingCustomers.splice(index, 1);
        assignedIds.add(customer.id);
      }
    });
    
    // Add customers to route
    beatCustomers.forEach(customer => {
      route.stops.push({
        customerId: customer.id,
        latitude: customer.latitude,
        longitude: customer.longitude,
        distanceToNext: 0,
        timeToNext: 0,
        visitTime: config.customerVisitTimeMinutes,
        clusterId: customer.clusterId,
        outletName: customer.outletName
      });
    });
    
    if (route.stops.length > 0) {
      // Optimize route order and apply constraints
      optimizeRouteOrderWithConstraints(route, distributor, config);
      updateRouteMetrics(route, distributor, config);
      routes.push(route);
      console.log(`Created constraint-enforced beat ${route.salesmanId} with ${route.stops.length} stops`);
    }
  }
  
  // Handle any remaining customers by distributing them to existing routes
  if (remainingCustomers.length > 0) {
    console.log(`Distributing ${remainingCustomers.length} remaining customers to existing routes...`);
    
    remainingCustomers.forEach(customer => {
      if (assignedIds.has(customer.id)) {
        console.warn(`Customer ${customer.id} already assigned, skipping`);
        return;
      }
      
      // Find the best route that can accommodate this customer
      let bestRoute = null;
      let minViolation = Infinity;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat) {
          const violation = calculateConstraintViolationForAddition(route, customer, config);
          if (violation < minViolation) {
            minViolation = violation;
            bestRoute = route;
          }
        }
      }
      
      if (bestRoute) {
        const insertionPoint = findBestInsertionPointWithConstraints(bestRoute, customer, distributor, config);
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
        updateRouteMetrics(bestRoute, distributor, config);
        console.log(`Distributed customer ${customer.id} to route ${bestRoute.salesmanId}`);
      }
    });
  }
  
  return routes;
}

function selectCustomersForBeatWithConstraints(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  targetSize: number,
  config: ClusteringConfig
): ClusteredCustomer[] {
  if (customers.length === 0 || targetSize === 0) return [];
  
  const selected: ClusteredCustomer[] = [];
  const remaining = [...customers];
  
  // Start from the customer closest to distributor
  let currentLat = distributor.latitude;
  let currentLng = distributor.longitude;
  
  // Select first customer (closest to distributor)
  let nearestIndex = 0;
  let shortestDistance = Infinity;
  
  for (let i = 0; i < remaining.length; i++) {
    const distance = calculateHaversineDistance(
      currentLat, currentLng,
      remaining[i].latitude, remaining[i].longitude
    );
    if (distance < shortestDistance) {
      shortestDistance = distance;
      nearestIndex = i;
    }
  }
  
  const firstCustomer = remaining.splice(nearestIndex, 1)[0];
  selected.push(firstCustomer);
  currentLat = firstCustomer.latitude;
  currentLng = firstCustomer.longitude;
  
  // Select remaining customers with median distance constraint
  while (selected.length < targetSize && remaining.length > 0) {
    let bestCustomer = null;
    let bestIndex = -1;
    let minConstraintViolation = Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      
      // Calculate constraint violation if we add this customer
      const tempSelected = [...selected, candidate];
      const medianDistance = calculateMedianDistanceWithinGroup(tempSelected);
      
      let violation = 0;
      
      // Check if adding this customer would violate median distance constraint
      for (const existingCustomer of selected) {
        const distance = calculateHaversineDistance(
          existingCustomer.latitude, existingCustomer.longitude,
          candidate.latitude, candidate.longitude
        );
        
        if (distance > medianDistance) {
          violation += (distance - medianDistance);
        }
      }
      
      // Also consider proximity to current position
      const proximityDistance = calculateHaversineDistance(
        currentLat, currentLng,
        candidate.latitude, candidate.longitude
      );
      
      const totalScore = violation + (proximityDistance * 0.1); // Weight proximity less than constraint violation
      
      if (totalScore < minConstraintViolation) {
        minConstraintViolation = totalScore;
        bestCustomer = candidate;
        bestIndex = i;
      }
    }
    
    if (bestCustomer && bestIndex !== -1) {
      remaining.splice(bestIndex, 1);
      selected.push(bestCustomer);
      currentLat = bestCustomer.latitude;
      currentLng = bestCustomer.longitude;
    } else {
      // If no good candidate found, take the nearest one
      nearestIndex = 0;
      shortestDistance = Infinity;
      
      for (let i = 0; i < remaining.length; i++) {
        const distance = calculateHaversineDistance(
          currentLat, currentLng,
          remaining[i].latitude, remaining[i].longitude
        );
        if (distance < shortestDistance) {
          shortestDistance = distance;
          nearestIndex = i;
        }
      }
      
      const nearestCustomer = remaining.splice(nearestIndex, 1)[0];
      selected.push(nearestCustomer);
      currentLat = nearestCustomer.latitude;
      currentLng = nearestCustomer.longitude;
    }
  }
  
  return selected;
}

function calculateMedianDistanceWithinGroup(customers: ClusteredCustomer[]): number {
  if (customers.length < 2) return Infinity;
  
  const distances: number[] = [];
  
  for (let i = 0; i < customers.length; i++) {
    for (let j = i + 1; j < customers.length; j++) {
      const distance = calculateHaversineDistance(
        customers[i].latitude, customers[i].longitude,
        customers[j].latitude, customers[j].longitude
      );
      distances.push(distance);
    }
  }
  
  if (distances.length === 0) return Infinity;
  
  distances.sort((a, b) => a - b);
  const midIndex = Math.floor(distances.length / 2);
  
  if (distances.length % 2 === 0) {
    return (distances[midIndex - 1] + distances[midIndex]) / 2;
  } else {
    return distances[midIndex];
  }
}

function calculateConstraintViolationForAddition(
  route: SalesmanRoute,
  customer: ClusteredCustomer,
  config: ClusteringConfig
): number {
  // Calculate how much adding this customer would violate constraints
  let violation = 0;
  
  // Size constraint violation
  if (route.stops.length >= config.maxOutletsPerBeat) {
    violation += 1000; // Heavy penalty for exceeding max size
  }
  
  // Median distance constraint violation
  const allCustomers = route.stops.map(stop => ({
    latitude: stop.latitude,
    longitude: stop.longitude
  })).concat([{ latitude: customer.latitude, longitude: customer.longitude }]);
  
  if (allCustomers.length >= 2) {
    const medianDistance = calculateMedianDistanceWithinGroup(allCustomers as ClusteredCustomer[]);
    
    if (medianDistance < 50) { // Only apply if reasonable
      for (const stop of route.stops) {
        const distance = calculateHaversineDistance(
          stop.latitude, stop.longitude,
          customer.latitude, customer.longitude
        );
        
        if (distance > medianDistance) {
          violation += (distance - medianDistance) * 10;
        }
      }
    }
  }
  
  return violation;
}

function findBestInsertionPointWithConstraints(
  route: SalesmanRoute,
  customer: ClusteredCustomer,
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): number {
  if (route.stops.length === 0) return 0;
  
  let bestPosition = route.stops.length;
  let minCost = Infinity;
  
  for (let i = 0; i <= route.stops.length; i++) {
    // Calculate insertion cost (distance increase)
    let cost = 0;
    
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
      
      cost = distToCustomer + distFromCustomer - originalDist;
    } else if (i === route.stops.length) {
      // Inserting at the end
      const lastStop = route.stops[route.stops.length - 1];
      cost = calculateHaversineDistance(
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
      
      cost = distToPrev + distToNext - originalDist;
    }
    
    // Add constraint violation penalty
    const tempStops = [...route.stops];
    tempStops.splice(i, 0, {
      customerId: customer.id,
      latitude: customer.latitude,
      longitude: customer.longitude,
      distanceToNext: 0,
      timeToNext: 0,
      visitTime: config.customerVisitTimeMinutes,
      clusterId: customer.clusterId,
      outletName: customer.outletName
    });
    
    const constraintViolation = calculateMedianDistanceViolations(tempStops);
    cost += constraintViolation * 100;
    
    if (cost < minCost) {
      minCost = cost;
      bestPosition = i;
    }
  }
  
  return bestPosition;
}

function optimizeRouteOrderWithConstraints(
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): void {
  if (route.stops.length < 4) return;
  
  let improved = true;
  let iterations = 0;
  const maxIterations = 20;
  
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    
    // Try 2-opt improvements that reduce both distance and constraint violations
    for (let i = 1; i < route.stops.length - 2; i++) {
      for (let j = i + 2; j < route.stops.length; j++) {
        // Create new route order with 2-opt swap
        const newStops = [
          ...route.stops.slice(0, i),
          ...route.stops.slice(i, j).reverse(),
          ...route.stops.slice(j)
        ];
        
        // Calculate current cost (distance + constraint violations)
        const currentDistance = calculateRouteDistance(route.stops, distributor);
        const currentViolations = calculateMedianDistanceViolations(route.stops);
        const currentCost = currentDistance + (currentViolations * 100);
        
        // Calculate new cost
        const newDistance = calculateRouteDistance(newStops, distributor);
        const newViolations = calculateMedianDistanceViolations(newStops);
        const newCost = newDistance + (newViolations * 100);
        
        // If new order is better, apply the swap
        if (newCost < currentCost) {
          route.stops = newStops;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
}

function calculateRouteDistance(stops: RouteStop[], distributor: { latitude: number; longitude: number }): number {
  if (stops.length === 0) return 0;
  
  let totalDistance = 0;
  let prevLat = distributor.latitude;
  let prevLng = distributor.longitude;
  
  for (const stop of stops) {
    const distance = calculateHaversineDistance(
      prevLat, prevLng,
      stop.latitude, stop.longitude
    );
    totalDistance += distance;
    prevLat = stop.latitude;
    prevLng = stop.longitude;
  }
  
  return totalDistance;
}

function calculateMedianDistanceViolations(stops: RouteStop[]): number {
  if (stops.length < 3) return 0;
  
  const medianDistance = calculateMedianDistanceWithinBeat(stops);
  
  if (medianDistance === Infinity || medianDistance > 50) return 0;
  
  let violations = 0;
  
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      
      if (distance > medianDistance) {
        violations += (distance - medianDistance);
      }
    }
  }
  
  return violations;
}

function calculateMedianDistanceWithinBeat(stops: RouteStop[]): number {
  if (stops.length < 2) return Infinity;
  
  const distances: number[] = [];
  
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      distances.push(distance);
    }
  }
  
  if (distances.length === 0) return Infinity;
  
  distances.sort((a, b) => a - b);
  const midIndex = Math.floor(distances.length / 2);
  
  if (distances.length % 2 === 0) {
    return (distances[midIndex - 1] + distances[midIndex]) / 2;
  } else {
    return distances[midIndex];
  }
}

function enforceAllConstraints(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): SalesmanRoute[] {
  console.log('Enforcing all constraints on routes...');
  
  let constraintEnforcedRoutes = [...routes];
  
  // Step 1: Handle undersized routes
  const undersizedRoutes = constraintEnforcedRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
  const normalRoutes = constraintEnforcedRoutes.filter(route => route.stops.length >= config.minOutletsPerBeat);
  
  console.log(`Found ${undersizedRoutes.length} undersized routes (< ${config.minOutletsPerBeat} outlets)`);
  
  // Try to merge undersized routes or redistribute their customers
  undersizedRoutes.forEach(undersizedRoute => {
    // Find a route in the same cluster that can accommodate the merge
    const sameClusterRoute = normalRoutes.find(route => 
      route.clusterIds[0] === undersizedRoute.clusterIds[0] &&
      route.stops.length + undersizedRoute.stops.length <= config.maxOutletsPerBeat
    );
    
    if (sameClusterRoute) {
      // Merge the undersized route into the same cluster route
      sameClusterRoute.stops.push(...undersizedRoute.stops);
      updateRouteMetrics(sameClusterRoute, distributor, config);
      console.log(`Merged undersized route ${undersizedRoute.salesmanId} into route ${sameClusterRoute.salesmanId}`);
    } else {
      // If can't merge, keep the undersized route but mark it
      normalRoutes.push(undersizedRoute);
      console.log(`Keeping undersized route ${undersizedRoute.salesmanId} (no suitable merge target found)`);
    }
  });
  
  constraintEnforcedRoutes = normalRoutes;
  
  // Step 2: Handle oversized routes
  const oversizedRoutes = constraintEnforcedRoutes.filter(route => route.stops.length > config.maxOutletsPerBeat);
  
  console.log(`Found ${oversizedRoutes.length} oversized routes (> ${config.maxOutletsPerBeat} outlets)`);
  
  oversizedRoutes.forEach(oversizedRoute => {
    if (oversizedRoute.stops.length > config.maxOutletsPerBeat) {
      // Split the oversized route
      const midPoint = Math.ceil(oversizedRoute.stops.length / 2);
      
      const route1: SalesmanRoute = {
        ...oversizedRoute,
        stops: oversizedRoute.stops.slice(0, midPoint),
        totalDistance: 0,
        totalTime: 0
      };
      
      const route2: SalesmanRoute = {
        ...oversizedRoute,
        salesmanId: oversizedRoute.salesmanId + 1000, // Temporary ID
        stops: oversizedRoute.stops.slice(midPoint),
        totalDistance: 0,
        totalTime: 0
      };
      
      updateRouteMetrics(route1, distributor, config);
      updateRouteMetrics(route2, distributor, config);
      
      // Replace the oversized route with the two split routes
      const index = constraintEnforcedRoutes.findIndex(r => r.salesmanId === oversizedRoute.salesmanId);
      if (index !== -1) {
        constraintEnforcedRoutes.splice(index, 1, route1, route2);
        console.log(`Split oversized route ${oversizedRoute.salesmanId} into routes ${route1.salesmanId} and ${route2.salesmanId}`);
      }
    }
  });
  
  // Step 3: Apply median distance constraint optimization to all routes
  constraintEnforcedRoutes.forEach(route => {
    if (route.stops.length > 2) {
      optimizeRouteOrderWithConstraints(route, distributor, config);
      updateRouteMetrics(route, distributor, config);
    }
  });
  
  return constraintEnforcedRoutes;
}

function analyzeConstraintAdherence(routes: SalesmanRoute[], config: ClusteringConfig): any {
  const report = {
    totalRoutes: routes.length,
    undersizedRoutes: 0,
    oversizedRoutes: 0,
    properSizedRoutes: 0,
    medianDistanceViolations: 0,
    averageOutletsPerRoute: 0,
    routeSizeDistribution: {} as Record<number, number>
  };
  
  let totalOutlets = 0;
  
  routes.forEach(route => {
    const size = route.stops.length;
    totalOutlets += size;
    
    // Count size violations
    if (size < config.minOutletsPerBeat) {
      report.undersizedRoutes++;
    } else if (size > config.maxOutletsPerBeat) {
      report.oversizedRoutes++;
    } else {
      report.properSizedRoutes++;
    }
    
    // Track size distribution
    report.routeSizeDistribution[size] = (report.routeSizeDistribution[size] || 0) + 1;
    
    // Count median distance violations
    const violations = calculateMedianDistanceViolations(route.stops);
    if (violations > 0) {
      report.medianDistanceViolations++;
    }
  });
  
  report.averageOutletsPerRoute = totalOutlets / routes.length;
  
  return report;
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