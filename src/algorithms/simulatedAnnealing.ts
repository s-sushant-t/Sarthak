import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Optimized annealing parameters for proximity-constrained optimization
const INITIAL_TEMPERATURE = 30; // Lower for proximity-focused optimization
const COOLING_RATE = 0.95; // Slower cooling for better proximity solutions
const MIN_TEMPERATURE = 0.1;
const ITERATIONS_PER_TEMP = 20;
const MAX_TOTAL_ITERATIONS = 200; // Reduced for faster processing
const PROXIMITY_CONSTRAINT = 0.2; // 200 meters in kilometers

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-constrained simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`TARGET: Exactly ${config.totalClusters * config.beatsPerCluster} beats total`);
  console.log(`Proximity constraint: All outlets within 200m of each other in the same beat`);
  console.log(`Minimum outlets per beat: ${config.minOutletsPerBeat}`);
  
  const startTime = Date.now();
  const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
  
  try {
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
    
    // Process each cluster independently with proximity-constrained annealing
    const clusterResults: SalesmanRoute[][] = [];
    
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithExactBeatCount(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds,
        config.beatsPerCluster
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = routes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterCustomers.length} customers assigned in ${routes.length} beats`);
      
      if (assignedInCluster !== clusterCustomers.length) {
        console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterCustomers.length} customers, got ${assignedInCluster}`);
        
        // Find and assign missing customers
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to any available route
        missingCustomers.forEach(customer => {
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
          clusterAssignedIds.add(customer.id);
          console.log(`Force-assigned missing customer ${customer.id} to route ${targetRoute.salesmanId}`);
        });
      }
      
      // Add cluster customers to global tracking
      clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
      
      clusterResults.push(routes);
      
      // Yield control between clusters
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Combine routes from all clusters
    let routes = clusterResults.flat();
    
    // CRITICAL: Verify we have exactly the target number of beats
    console.log(`BEAT COUNT VERIFICATION: ${routes.length} beats created (target was ${TARGET_TOTAL_BEATS})`);
    
    if (routes.length !== TARGET_TOTAL_BEATS) {
      console.error(`CRITICAL ERROR: Expected exactly ${TARGET_TOTAL_BEATS} beats, got ${routes.length}!`);
      
      // Adjust to exact target by splitting or merging routes
      routes = adjustToExactBeatCount(routes, TARGET_TOTAL_BEATS, config, distributor, PROXIMITY_CONSTRAINT);
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
    
    // Apply final proximity-focused optimization
    routes = await applyProximityFocusedOptimization(routes, distributor, config);
    
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
    
    console.log(`SIMULATED ANNEALING VERIFICATION:`);
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
    
    if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
      console.error(`SIMULATED ANNEALING ERROR: Customer count mismatch!`);
      console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
    }
    
    // Calculate total distance (not optimized, just for reporting)
    const totalDistance = sequentialRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    return {
      name: `Proximity-Constrained Simulated Annealing (${config.totalClusters} Clusters, ${sequentialRoutes.length} Beats, 200m Constraint, Min Size Enforced)`,
      totalDistance,
      totalSalesmen: sequentialRoutes.length,
      processingTime: Date.now() - startTime,
      routes: sequentialRoutes
    };
    
  } catch (error) {
    console.error('Proximity-constrained simulated annealing failed:', error);
    throw error; // Re-throw to let the caller handle fallback
  }
};

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
        const wouldFit = candidate.stops.length + smallestRoute.stops.length <= config.maxOutletsPerBeat * 1.5;
        
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

async function processClusterWithExactBeatCount(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with exact beat count: ${targetBeats} beats for ${customers.length} customers`);
  
  // Create initial solution with exact number of beats
  let bestSolution = createExactBeatCountInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds), targetBeats);
  let bestEnergy = calculateProximityFocusedEnergy(bestSolution);
  
  let currentSolution = JSON.parse(JSON.stringify(bestSolution));
  let currentEnergy = bestEnergy;
  
  let temperature = INITIAL_TEMPERATURE;
  let totalIterations = 0;
  let noImprovementCount = 0;
  const maxNoImprovement = 15; // Early stopping
  
  while (temperature > MIN_TEMPERATURE && totalIterations < MAX_TOTAL_ITERATIONS && noImprovementCount < maxNoImprovement) {
    let improved = false;
    
    for (let i = 0; i < ITERATIONS_PER_TEMP && totalIterations < MAX_TOTAL_ITERATIONS; i++) {
      totalIterations++;
      
      // Create neighbor solution with proximity constraints
      const neighborSolution = createProximityConstrainedNeighborSolution(currentSolution, config);
      const neighborEnergy = calculateProximityFocusedEnergy(neighborSolution);
      
      const acceptanceProbability = Math.exp(-(neighborEnergy - currentEnergy) / temperature);
      
      if (neighborEnergy < currentEnergy || Math.random() < acceptanceProbability) {
        currentSolution = neighborSolution;
        currentEnergy = neighborEnergy;
        
        if (neighborEnergy < bestEnergy) {
          bestSolution = JSON.parse(JSON.stringify(neighborSolution));
          bestEnergy = neighborEnergy;
          improved = true;
          noImprovementCount = 0;
        }
      }
      
      // Yield control every 20 iterations
      if (totalIterations % 20 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    if (!improved) {
      noImprovementCount++;
    }
    
    temperature *= COOLING_RATE;
  }
  
  // Update assigned IDs tracking
  bestSolution.forEach((route: SalesmanRoute) => {
    route.stops.forEach(stop => {
      assignedIds.add(stop.customerId);
    });
  });
  
  console.log(`Cluster ${clusterId} proximity-constrained annealing completed in ${totalIterations} iterations with ${bestSolution.length} beats`);
  
  return bestSolution;
}

function createExactBeatCountInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetBeats: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Create a working copy to avoid modifying the original
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  console.log(`Creating exact beat count initial solution with ${targetBeats} beats for ${remainingCustomers.length} customers`);
  
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
      // Start with a random customer for equal distribution
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
      let targetSize = Math.min(customersForThisBeat, config.maxOutletsPerBeat);
      
      while (route.stops.length < targetSize && remainingCustomers.length > 0) {
        let bestCandidate = null;
        let bestCandidateIndex = -1;
        
        // Find the best candidate that satisfies proximity constraint
        for (let i = 0; i < remainingCustomers.length; i++) {
          const candidate = remainingCustomers[i];
          
          // Check if candidate satisfies proximity constraint with ALL customers in the beat
          const satisfiesProximity = route.stops.every(stop => {
            const distance = calculateHaversineDistance(
              candidate.latitude, candidate.longitude,
              stop.latitude, stop.longitude
            );
            return distance <= PROXIMITY_CONSTRAINT;
          });
          
          if (satisfiesProximity) {
            bestCandidate = candidate;
            bestCandidateIndex = i;
            break; // Take the first valid candidate for equal distribution
          }
        }
        
        if (bestCandidate && bestCandidateIndex !== -1) {
          route.stops.push({
            customerId: bestCandidate.id,
            latitude: bestCandidate.latitude,
            longitude: bestCandidate.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: bestCandidate.clusterId,
            outletName: bestCandidate.outletName
          });
          assignedIds.add(bestCandidate.id);
          remainingCustomers.splice(bestCandidateIndex, 1);
        } else {
          break; // No more compatible customers
        }
      }
    }
    
    routes.push(route);
  }
  
  // Distribute any remaining customers to existing beats
  while (remainingCustomers.length > 0) {
    const customer = remainingCustomers.shift()!;
    
    // Find the beat with the fewest customers
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
    assignedIds.add(customer.id);
  }
  
  // Update route metrics
  routes.forEach(route => {
    updateRouteMetrics(route, config);
  });
  
  return routes;
}

function calculateProximityFocusedEnergy(solution: SalesmanRoute[]): number {
  let energy = 0;
  
  // Primary focus: Proximity constraint violations (heavily penalized)
  solution.forEach(route => {
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        
        if (distance > PROXIMITY_CONSTRAINT) {
          // Heavy penalty for proximity violations
          energy += (distance - PROXIMITY_CONSTRAINT) * 10000;
        }
      }
    }
  });
  
  // Secondary: Route balance (equal distribution)
  const avgRouteSize = solution.reduce((sum, route) => sum + route.stops.length, 0) / solution.length;
  solution.forEach(route => {
    const deviation = Math.abs(route.stops.length - avgRouteSize);
    energy += deviation * 100; // Moderate penalty for imbalance
  });
  
  // Tertiary: Total distance (minimal weight, not the primary goal)
  const totalDistance = solution.reduce((sum, route) => sum + route.totalDistance, 0);
  energy += totalDistance * 0.1; // Very low weight on distance
  
  return energy;
}

function createProximityConstrainedNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Only allow operations that maintain proximity constraints
  const operations = [
    () => swapAdjacentStopsWithProximityCheck(newSolution),
    () => reverseSmallSegmentWithProximityCheck(newSolution),
    () => moveCustomerToCompatibleRoute(newSolution, config)
  ];
  
  // Apply one random operation
  const operation = operations[Math.floor(Math.random() * operations.length)];
  operation();
  
  return newSolution;
}

function swapAdjacentStopsWithProximityCheck(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  
  // Temporarily swap to check proximity
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  
  // Check if swap maintains proximity constraints
  const violatesProximity = checkRouteProximityViolation(route);
  
  if (violatesProximity) {
    // Revert swap if it violates proximity
    [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  }
}

function reverseSmallSegmentWithProximityCheck(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2; // Always reverse just 2 elements
  
  const originalStops = [...route.stops];
  const segment = route.stops.slice(start, start + length);
  segment.reverse();
  route.stops.splice(start, length, ...segment);
  
  // Check if reversal maintains proximity constraints
  const violatesProximity = checkRouteProximityViolation(route);
  
  if (violatesProximity) {
    // Revert reversal if it violates proximity
    route.stops = originalStops;
  }
}

function moveCustomerToCompatibleRoute(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const sourceRouteIndex = Math.floor(Math.random() * solution.length);
  const sourceRoute = solution[sourceRouteIndex];
  
  if (sourceRoute.stops.length <= 1) return;
  
  const customerIndex = Math.floor(Math.random() * sourceRoute.stops.length);
  const customer = sourceRoute.stops[customerIndex];
  
  // Find a compatible route in the same cluster
  const compatibleRoutes = solution.filter((route, index) => 
    index !== sourceRouteIndex && 
    route.clusterIds.some(id => sourceRoute.clusterIds.includes(id)) &&
    route.stops.length < config.maxOutletsPerBeat
  );
  
  if (compatibleRoutes.length === 0) return;
  
  const targetRoute = compatibleRoutes[Math.floor(Math.random() * compatibleRoutes.length)];
  
  // Check if customer can be added to target route without violating proximity
  const wouldViolateProximity = targetRoute.stops.some(stop => {
    const distance = calculateHaversineDistance(
      customer.latitude, customer.longitude,
      stop.latitude, stop.longitude
    );
    return distance > PROXIMITY_CONSTRAINT;
  });
  
  if (!wouldViolateProximity) {
    // Move customer
    sourceRoute.stops.splice(customerIndex, 1);
    targetRoute.stops.push(customer);
  }
}

function checkRouteProximityViolation(route: SalesmanRoute): boolean {
  for (let i = 0; i < route.stops.length; i++) {
    for (let j = i + 1; j < route.stops.length; j++) {
      const distance = calculateHaversineDistance(
        route.stops[i].latitude, route.stops[i].longitude,
        route.stops[j].latitude, route.stops[j].longitude
      );
      
      if (distance > PROXIMITY_CONSTRAINT) {
        return true; // Violation found
      }
    }
  }
  return false; // No violations
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

async function applyProximityFocusedOptimization(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  // Focus on maintaining proximity constraints rather than distance optimization
  routes.forEach((route, index) => {
    updateRouteMetrics(route, config);
    
    // Yield control every 20 routes
    if (index % 20 === 0) {
      setTimeout(() => {}, 0);
    }
  });
  
  // Reassign sequential IDs
  return routes.map((route, index) => ({
    ...route,
    salesmanId: index + 1,
    distributorLat: distributor.latitude,
    distributorLng: distributor.longitude
  }));
}

function updateRouteMetrics(route: SalesmanRoute, config: ClusteringConfig): void {
  route.totalDistance = 0;
  route.totalTime = 0;
  
  if (route.stops.length === 0) return;
  
  let prevLat = route.distributorLat;
  let prevLng = route.distributorLng;
  
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