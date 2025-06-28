import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-constrained nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`TARGET: Exactly ${config.totalClusters * config.beatsPerCluster} beats total`);
  console.log(`Proximity constraint: All outlets within 200m of each other in the same beat`);
  console.log(`Minimum outlets per beat: ${config.minOutletsPerBeat}`);
  
  // CRITICAL: Calculate exact target number of beats
  const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
  const PROXIMITY_CONSTRAINT = 0.2; // 200 meters in kilometers
  
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
  
  // Process each cluster independently to create exactly beatsPerCluster beats
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    console.log(`Target: exactly ${config.beatsPerCluster} beats for this cluster`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create exactly beatsPerCluster beats with proximity constraints
    const clusterRoutes = createExactNumberOfBeats(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds,
      config.beatsPerCluster,
      PROXIMITY_CONSTRAINT
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned in ${clusterRoutes.length} beats`);
    
    if (assignedInCluster !== clusterSize) {
      console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
      
      // Find and assign missing customers with proximity constraints
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
      
      // Force assign missing customers to compatible beats
      missingCustomers.forEach(customer => {
        const compatibleRoute = findCompatibleRouteWithProximity(customer, clusterRoutes, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
        
        if (compatibleRoute) {
          compatibleRoute.stops.push({
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
          console.log(`Force-assigned missing customer ${customer.id} to route ${compatibleRoute.salesmanId} (proximity satisfied)`);
        } else {
          // If no compatible route, add to the route with fewest customers
          const targetRoute = clusterRoutes.reduce((min, route) => 
            route.stops.length < min.stops.length ? route : min
          );
          
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
          console.log(`Force-assigned customer ${customer.id} to smallest route ${targetRoute.salesmanId} (proximity may be violated)`);
        }
      });
    }
    
    // Add cluster customers to global tracking
    clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
    
    routes.push(...clusterRoutes);
    currentSalesmanId += clusterRoutes.length;
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} beats created (target was ${config.beatsPerCluster})`);
  }
  
  // CRITICAL: Verify we have exactly the target number of beats
  console.log(`BEAT COUNT VERIFICATION: ${routes.length} beats created (target was ${TARGET_TOTAL_BEATS})`);
  
  if (routes.length !== TARGET_TOTAL_BEATS) {
    console.error(`CRITICAL ERROR: Expected exactly ${TARGET_TOTAL_BEATS} beats, got ${routes.length}!`);
    
    // Adjust to exact target by splitting or merging routes
    const adjustedRoutes = adjustToExactBeatCount(routes, TARGET_TOTAL_BEATS, config, distributor, PROXIMITY_CONSTRAINT);
    routes.splice(0, routes.length, ...adjustedRoutes);
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
      // Find the route with the fewest customers
      const targetRoute = routes.reduce((min, route) => 
        route.stops.length < min.stops.length ? route : min
      );
      
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
  
  // CRITICAL: Apply minimum beat size enforcement - merge undersized beats with nearest beats
  const finalRoutes = enforceMinimumBeatSizeWithMerging(routes, config, distributor, PROXIMITY_CONSTRAINT);
  
  // Reassign beat IDs sequentially after merging
  const sequentialRoutes = finalRoutes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
  
  // FINAL verification and proximity validation
  const finalCustomerCount = sequentialRoutes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(sequentialRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`FINAL VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  console.log(`- Total beats created: ${sequentialRoutes.length}`);
  console.log(`- Target beats: ${TARGET_TOTAL_BEATS}`);
  
  // Validate proximity constraints
  const proximityViolations = validateProximityConstraints(sequentialRoutes, PROXIMITY_CONSTRAINT);
  console.log(`- Proximity constraint violations: ${proximityViolations}`);
  
  // Validate minimum beat size enforcement
  const undersizedBeats = sequentialRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
  console.log(`- Beats below minimum size (${config.minOutletsPerBeat}): ${undersizedBeats.length}`);
  
  // Report beats per cluster
  const beatsByCluster = sequentialRoutes.reduce((acc, route) => {
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
  
  // Calculate total distance (not optimized, just for reporting)
  const totalDistance = sequentialRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Proximity-Constrained Nearest Neighbor (${config.totalClusters} Clusters, ${sequentialRoutes.length} Beats, 200m Constraint, Min Size Enforced)`,
    totalDistance,
    totalSalesmen: sequentialRoutes.length,
    processingTime: 0,
    routes: sequentialRoutes
  };
};

function createExactNumberOfBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number,
  proximityConstraint: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating exactly ${targetBeats} beats for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`Proximity constraint: ${proximityConstraint * 1000}m between all outlets in the same beat`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Calculate equal distribution target
  const customersPerBeat = Math.ceil(remainingCustomers.length / targetBeats);
  console.log(`Target customers per beat: ${customersPerBeat} (equal distribution)`);
  
  // Create exactly targetBeats number of beats
  for (let beatIndex = 0; beatIndex < targetBeats; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Calculate how many customers this beat should get
    const remainingBeats = targetBeats - beatIndex;
    const customersForThisBeat = Math.ceil(remainingCustomers.length / remainingBeats);
    
    if (remainingCustomers.length > 0) {
      // Start with a customer (preferably one that can form a good proximity group)
      const startIndex = Math.floor(Math.random() * remainingCustomers.length);
      const startCustomer = remainingCustomers.splice(startIndex, 1)[0];
      
      route.stops.push({
        customerId: startCustomer.id,
        latitude: startCustomer.latitude,
        longitude: startCustomer.longitude,
        distanceToNext: 0,
        timeToNext: 0,
        visitTime: config.customerVisitTimeMinutes,
        clusterId: startCustomer.clusterId,
        outletName: startCustomer.outletName
      });
      assignedIds.add(startCustomer.id);
      
      // Add customers that satisfy proximity constraint
      let addedCount = 1;
      while (addedCount < customersForThisBeat && remainingCustomers.length > 0) {
        let bestCandidateIndex = -1;
        let bestDistance = Infinity;
        
        // Find the best candidate that satisfies proximity constraint with ALL existing customers in the beat
        for (let i = 0; i < remainingCustomers.length; i++) {
          const candidate = remainingCustomers[i];
          
          // Check if candidate is within proximity constraint of ALL customers in the current beat
          const satisfiesProximity = route.stops.every(stop => {
            const distance = calculateHaversineDistance(
              candidate.latitude, candidate.longitude,
              stop.latitude, stop.longitude
            );
            return distance <= proximityConstraint;
          });
          
          if (satisfiesProximity) {
            // Calculate average distance to all customers in the beat
            const avgDistance = route.stops.reduce((sum, stop) => {
              return sum + calculateHaversineDistance(
                candidate.latitude, candidate.longitude,
                stop.latitude, stop.longitude
              );
            }, 0) / route.stops.length;
            
            if (avgDistance < bestDistance) {
              bestDistance = avgDistance;
              bestCandidateIndex = i;
            }
          }
        }
        
        if (bestCandidateIndex !== -1) {
          // Add the best candidate
          const candidate = remainingCustomers.splice(bestCandidateIndex, 1)[0];
          route.stops.push({
            customerId: candidate.id,
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: candidate.clusterId,
            outletName: candidate.outletName
          });
          assignedIds.add(candidate.id);
          addedCount++;
        } else {
          // No more customers satisfy proximity constraint
          break;
        }
      }
    }
    
    routes.push(route);
    console.log(`Created beat ${route.salesmanId} with ${route.stops.length} stops (target was ${customersForThisBeat})`);
  }
  
  // If there are still remaining customers, distribute them to existing beats
  while (remainingCustomers.length > 0) {
    const customer = remainingCustomers.shift()!;
    
    // Find the beat with the fewest customers that can accommodate this customer with proximity constraint
    let bestRoute = null;
    let minSize = Infinity;
    
    for (const route of routes) {
      if (route.stops.length < config.maxOutletsPerBeat) {
        // Check if customer satisfies proximity constraint with ALL customers in the route
        const satisfiesProximity = route.stops.every(stop => {
          const distance = calculateHaversineDistance(
            customer.latitude, customer.longitude,
            stop.latitude, stop.longitude
          );
          return distance <= proximityConstraint;
        });
        
        if (satisfiesProximity && route.stops.length < minSize) {
          minSize = route.stops.length;
          bestRoute = route;
        }
      }
    }
    
    // If no route satisfies proximity constraint, add to the smallest route
    if (!bestRoute) {
      bestRoute = routes.reduce((min, route) => 
        route.stops.length < min.stops.length ? route : min
      );
    }
    
    bestRoute.stops.push({
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
    console.log(`Distributed remaining customer ${customer.id} to route ${bestRoute.salesmanId}`);
  }
  
  console.log(`Cluster ${clusterId}: Created exactly ${routes.length} beats (target was ${targetBeats})`);
  
  return routes;
}

function adjustToExactBeatCount(
  routes: SalesmanRoute[],
  targetCount: number,
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  proximityConstraint: number
): SalesmanRoute[] {
  console.log(`Adjusting from ${routes.length} beats to exactly ${targetCount} beats`);
  
  let adjustedRoutes = [...routes];
  
  if (adjustedRoutes.length > targetCount) {
    // Too many beats - merge the smallest ones
    while (adjustedRoutes.length > targetCount) {
      // Find the two smallest beats that can be merged
      adjustedRoutes.sort((a, b) => a.stops.length - b.stops.length);
      
      const smallestRoute = adjustedRoutes[0];
      let mergeTarget = null;
      
      // Find a compatible route to merge with
      for (let i = 1; i < adjustedRoutes.length; i++) {
        const candidate = adjustedRoutes[i];
        
        // Check if they're in the same cluster
        const sameCluster = candidate.clusterIds.some(id => smallestRoute.clusterIds.includes(id));
        
        // Check if merging would not exceed max size
        const wouldFit = candidate.stops.length + smallestRoute.stops.length <= config.maxOutletsPerBeat;
        
        if (sameCluster && wouldFit) {
          mergeTarget = candidate;
          break;
        }
      }
      
      if (mergeTarget) {
        // Merge smallest route into target
        mergeTarget.stops.push(...smallestRoute.stops);
        updateRouteMetrics(mergeTarget, distributor, config);
        
        // Remove the smallest route
        const smallestIndex = adjustedRoutes.indexOf(smallestRoute);
        adjustedRoutes.splice(smallestIndex, 1);
        
        console.log(`Merged beat ${smallestRoute.salesmanId} into beat ${mergeTarget.salesmanId}`);
      } else {
        // Force merge with the next smallest route
        const secondSmallest = adjustedRoutes[1];
        secondSmallest.stops.push(...smallestRoute.stops);
        updateRouteMetrics(secondSmallest, distributor, config);
        adjustedRoutes.splice(0, 1);
        
        console.log(`Force-merged beat ${smallestRoute.salesmanId} into beat ${secondSmallest.salesmanId}`);
      }
    }
  } else if (adjustedRoutes.length < targetCount) {
    // Too few beats - split the largest ones
    while (adjustedRoutes.length < targetCount) {
      // Find the largest beat that can be split
      adjustedRoutes.sort((a, b) => b.stops.length - a.stops.length);
      
      const largestRoute = adjustedRoutes[0];
      
      if (largestRoute.stops.length >= 2) {
        // Split the largest route
        const midPoint = Math.ceil(largestRoute.stops.length / 2);
        
        const newRoute: SalesmanRoute = {
          salesmanId: adjustedRoutes.length + 1,
          stops: largestRoute.stops.splice(midPoint),
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [...largestRoute.clusterIds],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        
        updateRouteMetrics(largestRoute, distributor, config);
        updateRouteMetrics(newRoute, distributor, config);
        
        adjustedRoutes.push(newRoute);
        
        console.log(`Split beat ${largestRoute.salesmanId} into two beats`);
      } else {
        // Cannot split further, create empty beat
        const emptyRoute: SalesmanRoute = {
          salesmanId: adjustedRoutes.length + 1,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [0], // Default cluster
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        
        adjustedRoutes.push(emptyRoute);
        console.log(`Created empty beat ${emptyRoute.salesmanId}`);
      }
    }
  }
  
  console.log(`Successfully adjusted to exactly ${adjustedRoutes.length} beats`);
  return adjustedRoutes;
}

function enforceMinimumBeatSizeWithMerging(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  proximityConstraint: number
): SalesmanRoute[] {
  console.log(`Enforcing minimum beat size of ${config.minOutletsPerBeat} outlets per beat with aggressive merging...`);
  
  const processedRoutes = [...routes];
  let mergesMade = true;
  let iterationCount = 0;
  const maxIterations = 20; // Increased iterations for thorough merging
  
  while (mergesMade && iterationCount < maxIterations) {
    mergesMade = false;
    iterationCount++;
    
    console.log(`Minimum beat size enforcement iteration ${iterationCount}`);
    
    // Find beats that are below the minimum size
    const undersizedBeats = processedRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
    
    if (undersizedBeats.length === 0) {
      console.log('All beats meet minimum size requirement');
      break;
    }
    
    console.log(`Found ${undersizedBeats.length} beats below minimum size of ${config.minOutletsPerBeat}`);
    
    // Process each undersized beat
    for (const undersizedBeat of undersizedBeats) {
      if (undersizedBeat.stops.length >= config.minOutletsPerBeat) {
        continue; // Skip if already processed in this iteration
      }
      
      console.log(`Processing undersized beat ${undersizedBeat.salesmanId} with ${undersizedBeat.stops.length} outlets`);
      
      // Find the nearest beat that can accommodate the undersized beat's outlets
      const nearestCompatibleBeat = findNearestBeatForMerging(
        undersizedBeat,
        processedRoutes,
        config
      );
      
      if (nearestCompatibleBeat) {
        console.log(`Merging beat ${undersizedBeat.salesmanId} (${undersizedBeat.stops.length} outlets) with beat ${nearestCompatibleBeat.salesmanId} (${nearestCompatibleBeat.stops.length} outlets)`);
        
        // Always merge - proximity constraint is secondary to minimum size requirement
        nearestCompatibleBeat.stops.push(...undersizedBeat.stops);
        
        // Update route metrics
        updateRouteMetrics(nearestCompatibleBeat, distributor, config);
        
        // Remove the undersized beat from the list
        const undersizedIndex = processedRoutes.findIndex(r => r.salesmanId === undersizedBeat.salesmanId);
        if (undersizedIndex !== -1) {
          processedRoutes.splice(undersizedIndex, 1);
          mergesMade = true;
          console.log(`Successfully merged beat ${undersizedBeat.salesmanId} into beat ${nearestCompatibleBeat.salesmanId}`);
        }
      } else {
        console.log(`No compatible beat found for undersized beat ${undersizedBeat.salesmanId} - keeping as is`);
      }
    }
  }
  
  // Final report
  const finalUndersizedBeats = processedRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
  console.log(`Minimum beat size enforcement complete after ${iterationCount} iterations`);
  console.log(`Remaining beats below minimum size: ${finalUndersizedBeats.length}`);
  
  if (finalUndersizedBeats.length > 0) {
    console.log('Remaining undersized beats:', finalUndersizedBeats.map(r => 
      `Beat ${r.salesmanId}: ${r.stops.length} outlets`
    ));
    
    // Force merge remaining undersized beats
    finalUndersizedBeats.forEach(undersizedBeat => {
      if (undersizedBeat.stops.length > 0) {
        // Find any beat that can accommodate (ignore proximity for minimum size enforcement)
        const targetBeat = processedRoutes.find(route => 
          route.salesmanId !== undersizedBeat.salesmanId &&
          route.stops.length + undersizedBeat.stops.length <= config.maxOutletsPerBeat * 1.5 // Allow some flexibility
        );
        
        if (targetBeat) {
          console.log(`Force-merging remaining undersized beat ${undersizedBeat.salesmanId} into beat ${targetBeat.salesmanId}`);
          targetBeat.stops.push(...undersizedBeat.stops);
          updateRouteMetrics(targetBeat, distributor, config);
          
          // Remove the undersized beat
          const index = processedRoutes.findIndex(r => r.salesmanId === undersizedBeat.salesmanId);
          if (index !== -1) {
            processedRoutes.splice(index, 1);
          }
        }
      }
    });
  }
  
  return processedRoutes;
}

function findNearestBeatForMerging(
  undersizedBeat: SalesmanRoute,
  allRoutes: SalesmanRoute[],
  config: ClusteringConfig
): SalesmanRoute | null {
  let nearestBeat: SalesmanRoute | null = null;
  let shortestDistance = Infinity;
  
  // Calculate centroid of undersized beat
  const undersizedCentroid = calculateRouteCentroid(undersizedBeat);
  
  for (const candidateBeat of allRoutes) {
    // Skip the undersized beat itself
    if (candidateBeat.salesmanId === undersizedBeat.salesmanId) continue;
    
    // Skip if merging would create an excessively large beat
    if (candidateBeat.stops.length + undersizedBeat.stops.length > config.maxOutletsPerBeat * 1.5) continue;
    
    // Prefer beats in the same cluster, but don't require it for minimum size enforcement
    const sameCluster = candidateBeat.clusterIds.some(id => undersizedBeat.clusterIds.includes(id));
    
    // Calculate distance between beat centroids
    const candidateCentroid = calculateRouteCentroid(candidateBeat);
    const distance = calculateHaversineDistance(
      undersizedCentroid.latitude, undersizedCentroid.longitude,
      candidateCentroid.latitude, candidateCentroid.longitude
    );
    
    // Prefer same cluster beats, but consider all beats
    const adjustedDistance = sameCluster ? distance : distance * 2;
    
    // Check if this is the nearest compatible beat so far
    if (adjustedDistance < shortestDistance) {
      shortestDistance = adjustedDistance;
      nearestBeat = candidateBeat;
    }
  }
  
  if (nearestBeat) {
    console.log(`Found nearest beat ${nearestBeat.salesmanId} at distance ${shortestDistance.toFixed(3)}km`);
  }
  
  return nearestBeat;
}

function calculateRouteCentroid(route: SalesmanRoute): { latitude: number; longitude: number } {
  if (route.stops.length === 0) {
    return { latitude: route.distributorLat, longitude: route.distributorLng };
  }
  
  const totalLat = route.stops.reduce((sum, stop) => sum + stop.latitude, 0);
  const totalLng = route.stops.reduce((sum, stop) => sum + stop.longitude, 0);
  
  return {
    latitude: totalLat / route.stops.length,
    longitude: totalLng / route.stops.length
  };
}

function findCompatibleRouteWithProximity(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  proximityConstraint: number,
  maxOutletsPerBeat: number
): SalesmanRoute | null {
  for (const route of routes) {
    // Check if route has space
    if (route.stops.length >= maxOutletsPerBeat) continue;
    
    // Check if customer satisfies proximity constraint with ALL customers in the route
    const satisfiesProximity = route.stops.every(stop => {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      return distance <= proximityConstraint;
    });
    
    if (satisfiesProximity) {
      return route;
    }
  }
  
  return null;
}

function validateProximityConstraints(routes: SalesmanRoute[], proximityConstraint: number): number {
  let violations = 0;
  
  routes.forEach(route => {
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        
        if (distance > proximityConstraint) {
          violations++;
          console.warn(`Proximity violation in beat ${route.salesmanId}: ${distance.toFixed(3)}km > ${proximityConstraint}km`);
        }
      }
    }
  });
  
  return violations;
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