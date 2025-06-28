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
  console.log(`Proximity constraint: All outlets within 200m of each other in the same beat`);
  console.log(`Minimum outlets per beat: ${config.minOutletsPerBeat}`);
  
  const startTime = Date.now();
  
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
      const routes = await processClusterWithProximityConstraints(
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
        
        // Find and assign missing customers with proximity constraints
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to compatible routes
        missingCustomers.forEach(customer => {
          const compatibleRoute = findCompatibleRouteWithProximity(customer, routes, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
          
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
            // Create new route for incompatible customer
            const newRoute: SalesmanRoute = {
              salesmanId: routes.length + 1,
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
            routes.push(newRoute);
            clusterAssignedIds.add(customer.id);
            console.log(`Created new route for customer ${customer.id} (proximity constraint)`);
          }
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
        // Find a compatible route in the same cluster
        const sameClusterRoutes = routes.filter(route => 
          route.clusterIds.includes(customer.clusterId)
        );
        
        const compatibleRoute = findCompatibleRouteWithProximity(customer, sameClusterRoutes, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
        
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
          globalAssignedCustomerIds.add(customer.id);
          console.log(`Emergency assigned customer ${customer.id} to route ${compatibleRoute.salesmanId} (proximity satisfied)`);
        } else {
          // Create emergency route
          const emergencyRoute: SalesmanRoute = {
            salesmanId: routes.length + 1,
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
            clusterIds: [customer.clusterId],
            distributorLat: distributor.latitude,
            distributorLng: distributor.longitude
          };
          routes.push(emergencyRoute);
          globalAssignedCustomerIds.add(customer.id);
          console.log(`Created emergency route for customer ${customer.id}`);
        }
      });
    }
    
    // Apply final proximity-focused optimization
    routes = await applyProximityFocusedOptimization(routes, distributor, config);
    
    // CRITICAL: Apply minimum beat size enforcement - merge undersized beats with nearest beats
    const finalRoutes = enforceMinimumBeatSize(routes, config, distributor, PROXIMITY_CONSTRAINT);
    
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

function enforceMinimumBeatSize(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  proximityConstraint: number
): SalesmanRoute[] {
  console.log(`Enforcing minimum beat size of ${config.minOutletsPerBeat} outlets per beat...`);
  
  const processedRoutes = [...routes];
  let mergesMade = true;
  let iterationCount = 0;
  const maxIterations = 10; // Prevent infinite loops
  
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
      const nearestCompatibleBeat = findNearestCompatibleBeat(
        undersizedBeat,
        processedRoutes,
        config,
        proximityConstraint
      );
      
      if (nearestCompatibleBeat) {
        console.log(`Merging beat ${undersizedBeat.salesmanId} (${undersizedBeat.stops.length} outlets) with beat ${nearestCompatibleBeat.salesmanId} (${nearestCompatibleBeat.stops.length} outlets)`);
        
        // Check if all outlets from undersized beat can be added while maintaining proximity constraint
        const canMergeAll = undersizedBeat.stops.every(stop => {
          return nearestCompatibleBeat.stops.every(existingStop => {
            const distance = calculateHaversineDistance(
              stop.latitude, stop.longitude,
              existingStop.latitude, existingStop.longitude
            );
            return distance <= proximityConstraint;
          });
        });
        
        if (canMergeAll && nearestCompatibleBeat.stops.length + undersizedBeat.stops.length <= config.maxOutletsPerBeat) {
          // Merge all outlets from undersized beat to nearest compatible beat
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
          console.log(`Cannot merge beat ${undersizedBeat.salesmanId} with beat ${nearestCompatibleBeat.salesmanId} due to proximity or size constraints`);
          
          // Try to merge individual outlets that satisfy proximity constraint
          const outletsToMove: RouteStop[] = [];
          
          for (const stop of undersizedBeat.stops) {
            const satisfiesProximity = nearestCompatibleBeat.stops.every(existingStop => {
              const distance = calculateHaversineDistance(
                stop.latitude, stop.longitude,
                existingStop.latitude, existingStop.longitude
              );
              return distance <= proximityConstraint;
            });
            
            if (satisfiesProximity && nearestCompatibleBeat.stops.length < config.maxOutletsPerBeat) {
              outletsToMove.push(stop);
              nearestCompatibleBeat.stops.push(stop);
            }
          }
          
          if (outletsToMove.length > 0) {
            // Remove moved outlets from undersized beat
            undersizedBeat.stops = undersizedBeat.stops.filter(stop => 
              !outletsToMove.some(moved => moved.customerId === stop.customerId)
            );
            
            updateRouteMetrics(nearestCompatibleBeat, distributor, config);
            updateRouteMetrics(undersizedBeat, distributor, config);
            
            console.log(`Moved ${outletsToMove.length} outlets from beat ${undersizedBeat.salesmanId} to beat ${nearestCompatibleBeat.salesmanId}`);
            
            // If undersized beat is now empty, remove it
            if (undersizedBeat.stops.length === 0) {
              const undersizedIndex = processedRoutes.findIndex(r => r.salesmanId === undersizedBeat.salesmanId);
              if (undersizedIndex !== -1) {
                processedRoutes.splice(undersizedIndex, 1);
                mergesMade = true;
                console.log(`Removed empty beat ${undersizedBeat.salesmanId}`);
              }
            }
          }
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
  }
  
  return processedRoutes;
}

function findNearestCompatibleBeat(
  undersizedBeat: SalesmanRoute,
  allRoutes: SalesmanRoute[],
  config: ClusteringConfig,
  proximityConstraint: number
): SalesmanRoute | null {
  let nearestBeat: SalesmanRoute | null = null;
  let shortestDistance = Infinity;
  
  // Calculate centroid of undersized beat
  const undersizedCentroid = calculateRouteCentroid(undersizedBeat);
  
  for (const candidateBeat of allRoutes) {
    // Skip the undersized beat itself
    if (candidateBeat.salesmanId === undersizedBeat.salesmanId) continue;
    
    // Skip if candidate beat is also undersized (to avoid merging two undersized beats)
    if (candidateBeat.stops.length < config.minOutletsPerBeat) continue;
    
    // Skip if merging would exceed maximum beat size
    if (candidateBeat.stops.length + undersizedBeat.stops.length > config.maxOutletsPerBeat) continue;
    
    // Prefer beats in the same cluster
    const sameCluster = candidateBeat.clusterIds.some(id => undersizedBeat.clusterIds.includes(id));
    if (!sameCluster) continue;
    
    // Calculate distance between beat centroids
    const candidateCentroid = calculateRouteCentroid(candidateBeat);
    const distance = calculateHaversineDistance(
      undersizedCentroid.latitude, undersizedCentroid.longitude,
      candidateCentroid.latitude, candidateCentroid.longitude
    );
    
    // Check if this is the nearest compatible beat so far
    if (distance < shortestDistance) {
      shortestDistance = distance;
      nearestBeat = candidateBeat;
    }
  }
  
  if (nearestBeat) {
    console.log(`Found nearest compatible beat ${nearestBeat.salesmanId} at distance ${shortestDistance.toFixed(3)}km`);
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

async function processClusterWithProximityConstraints(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with proximity constraints: ${targetBeats} beats for ${customers.length} customers`);
  
  // Create initial solution with proximity constraints
  let bestSolution = createProximityConstrainedInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds), targetBeats);
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

function createProximityConstrainedInitialSolution(
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
  
  console.log(`Creating proximity-constrained initial solution with ${targetBeats} beats for ${remainingCustomers.length} customers`);
  
  // Create beats with strict proximity constraints and equal distribution
  const customersPerBeat = Math.ceil(remainingCustomers.length / targetBeats);
  
  for (let beatIndex = 0; beatIndex < targetBeats && remainingCustomers.length > 0; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
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
    let targetSize = Math.min(customersPerBeat, config.maxOutletsPerBeat);
    
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
    
    if (route.stops.length > 0) {
      updateRouteMetrics(route, config);
      routes.push(route);
    }
  }
  
  // Handle remaining customers by creating additional beats
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
    
    // Take the first remaining customer
    const startCustomer = remainingCustomers.shift()!;
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
    
    // Add compatible customers
    for (let i = remainingCustomers.length - 1; i >= 0; i--) {
      const candidate = remainingCustomers[i];
      
      const satisfiesProximity = route.stops.every(stop => {
        const distance = calculateHaversineDistance(
          candidate.latitude, candidate.longitude,
          stop.latitude, stop.longitude
        );
        return distance <= PROXIMITY_CONSTRAINT;
      });
      
      if (satisfiesProximity && route.stops.length < config.maxOutletsPerBeat) {
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
        remainingCustomers.splice(i, 1);
      }
    }
    
    updateRouteMetrics(route, config);
    routes.push(route);
  }
  
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