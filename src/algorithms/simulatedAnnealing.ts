import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Highly optimized annealing parameters for fast processing with isolation constraints
const INITIAL_TEMPERATURE = 50; // Reduced for faster convergence
const COOLING_RATE = 0.92; // Faster cooling
const MIN_TEMPERATURE = 0.5; // Higher minimum
const ITERATIONS_PER_TEMP = 15; // Reduced iterations
const MAX_TOTAL_ITERATIONS = 300; // Hard limit on total iterations
const ISOLATION_DISTANCE = 0.2; // 200m minimum separation

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting Simulated Annealing with strict 200m isolation for ${customers.length} customers`);
  console.log(`Target: ${config.totalClusters} clusters × ${config.beatsPerCluster} beats = ${config.totalClusters * config.beatsPerCluster} total beats`);
  
  const startTime = Date.now();
  
  try {
    // CRITICAL: Calculate exact target number of beats
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    
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
    
    // Process each cluster independently with optimized annealing and isolation
    const clusterResults: SalesmanRoute[][] = [];
    
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithStrictBeatCountAndIsolation(
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
        
        // Find and assign missing customers with isolation constraints
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers
        missingCustomers.forEach(customer => {
          const suitableBeat = findSuitableBeatWithIsolation(customer, routes, ISOLATION_DISTANCE);
          let targetRoute = suitableBeat;
          
          if (!targetRoute) {
            targetRoute = findBeatWithMinimumConflicts(customer, routes, ISOLATION_DISTANCE);
          }
          
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
          }
        });
      }
      
      // Verify we have exactly the target number of beats
      if (routes.length !== config.beatsPerCluster) {
        console.warn(`Cluster ${clusterId}: Expected ${config.beatsPerCluster} beats, got ${routes.length}`);
      }
      
      // Add cluster customers to global tracking
      clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
      
      clusterResults.push(routes);
      
      // Yield control between clusters
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Combine routes from all clusters
    let routes = clusterResults.flat();
    
    // Apply comprehensive isolation optimization
    console.log('🔧 Applying final isolation optimization...');
    routes = await applyFinalOptimizationWithIsolation(routes, distributor, config);
    
    // CRITICAL: Final verification - ensure ALL customers are assigned exactly once
    const finalAssignedCount = globalAssignedCustomerIds.size;
    const totalCustomers = allCustomers.length;
    
    console.log(`GLOBAL VERIFICATION: ${finalAssignedCount}/${totalCustomers} customers assigned`);
    console.log(`BEAT COUNT VERIFICATION: ${routes.length}/${TARGET_TOTAL_BEATS} beats created`);
    
    if (finalAssignedCount !== totalCustomers) {
      console.error(`CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
      
      // Emergency assignment of missing customers
      const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
      console.error('Missing customers:', missingCustomers.map(c => c.id));
      
      missingCustomers.forEach(customer => {
        // Find a route in the same cluster with space
        const sameClusterRoutes = routes.filter(route => 
          route.clusterIds.includes(customer.clusterId)
        );
        
        let targetRoute = sameClusterRoutes.reduce((min, route) => 
          route.stops.length < min.stops.length ? route : min
        );
        
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
          
          globalAssignedCustomerIds.add(customer.id);
          console.log(`Emergency assigned customer ${customer.id} to route ${targetRoute.salesmanId}`);
        }
      });
    }
    
    // Generate isolation report
    const isolationReport = generateIsolationReport(routes);
    console.log('📊 Final Isolation Report:', isolationReport);
    
    // FINAL verification
    const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
    const uniqueCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
    
    console.log(`SIMULATED ANNEALING VERIFICATION:`);
    console.log(`- Total customers in routes: ${finalCustomerCount}`);
    console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
    console.log(`- Expected customers: ${totalCustomers}`);
    console.log(`- Total beats created: ${routes.length}`);
    console.log(`- Target beats: ${TARGET_TOTAL_BEATS}`);
    console.log(`🎯 Isolation violations: ${isolationReport.totalViolations} (${isolationReport.violationPercentage.toFixed(1)}%)`);
    
    if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
      console.error(`SIMULATED ANNEALING ERROR: Customer count mismatch!`);
      console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
    }
    
    // Calculate total distance
    const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
    
    return {
      name: `Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats)`,
      totalDistance,
      totalSalesmen: routes.length,
      processingTime: Date.now() - startTime,
      routes
    };
    
  } catch (error) {
    console.error('Simulated annealing failed:', error);
    throw error; // Re-throw to let the caller handle fallback
  }
};

async function processClusterWithStrictBeatCountAndIsolation(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with strict beat count and isolation: ${targetBeats} beats for ${customers.length} customers`);
  
  // Create initial solution with exact beat count and isolation awareness
  let bestSolution = createIsolationAwareInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds), targetBeats);
  let bestEnergy = calculateIsolationAwareEnergy(bestSolution);
  
  let currentSolution = JSON.parse(JSON.stringify(bestSolution));
  let currentEnergy = bestEnergy;
  
  let temperature = INITIAL_TEMPERATURE;
  let totalIterations = 0;
  let noImprovementCount = 0;
  const maxNoImprovement = 20; // Early stopping
  
  while (temperature > MIN_TEMPERATURE && totalIterations < MAX_TOTAL_ITERATIONS && noImprovementCount < maxNoImprovement) {
    let improved = false;
    
    for (let i = 0; i < ITERATIONS_PER_TEMP && totalIterations < MAX_TOTAL_ITERATIONS; i++) {
      totalIterations++;
      
      // Create neighbor solution with isolation-aware operations
      const neighborSolution = createIsolationAwareNeighborSolution(currentSolution, config);
      const neighborEnergy = calculateIsolationAwareEnergy(neighborSolution);
      
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
      
      // Yield control every 25 iterations
      if (totalIterations % 25 === 0) {
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
  
  console.log(`Cluster ${clusterId} annealing completed in ${totalIterations} iterations with ${bestSolution.length} beats`);
  
  return bestSolution;
}

function createIsolationAwareInitialSolution(
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
  
  // Calculate optimal distribution of customers across beats
  const customersPerBeat = Math.ceil(remainingCustomers.length / targetBeats);
  
  console.log(`Creating exactly ${targetBeats} beats with ~${customersPerBeat} customers each (isolation-aware)`);
  
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
    const remainingCustomersCount = remainingCustomers.length;
    const customersForThisBeat = Math.ceil(remainingCustomersCount / remainingBeats);
    
    // Take customers for this beat using isolation-aware assignment
    for (let i = 0; i < customersForThisBeat && remainingCustomers.length > 0; i++) {
      let bestCustomerIndex = -1;
      let bestScore = Infinity;
      
      // Find customer that minimizes isolation violations
      for (let j = 0; j < remainingCustomers.length; j++) {
        const customer = remainingCustomers[j];
        const isolationScore = calculateIsolationScore(customer, route, routes);
        
        if (isolationScore < bestScore) {
          bestScore = isolationScore;
          bestCustomerIndex = j;
        }
      }
      
      if (bestCustomerIndex !== -1) {
        const customer = remainingCustomers.splice(bestCustomerIndex, 1)[0];
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
        assignedIds.add(customer.id);
      }
    }
    
    if (route.stops.length > 0) {
      updateRouteMetrics(route, config);
    }
    
    routes.push(route); // Add route even if empty to maintain exact beat count
  }
  
  // Handle any remaining customers by distributing to existing beats with isolation constraints
  if (remainingCustomers.length > 0) {
    remainingCustomers.forEach(customer => {
      const suitableBeat = findSuitableBeatWithIsolation(customer, routes, ISOLATION_DISTANCE);
      let targetRoute = suitableBeat;
      
      if (!targetRoute) {
        targetRoute = findBeatWithMinimumConflicts(customer, routes, ISOLATION_DISTANCE);
      }
      
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
        assignedIds.add(customer.id);
        updateRouteMetrics(targetRoute, config);
      }
    });
  }
  
  return routes;
}

function calculateIsolationScore(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[]
): number {
  let violationCount = 0;
  let totalViolationDistance = 0;
  
  // Check against all customers in other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < ISOLATION_DISTANCE) {
        violationCount++;
        totalViolationDistance += (ISOLATION_DISTANCE - distance);
      }
    }
  }
  
  // Return score: higher is worse
  return violationCount * 1000 + totalViolationDistance * 100;
}

function calculateIsolationAwareEnergy(solution: SalesmanRoute[]): number {
  // Calculate base energy (distance + route count)
  const totalDistance = solution.reduce((sum, route) => sum + route.totalDistance, 0);
  const routeCountPenalty = solution.length * 5;
  
  // Add penalty for unbalanced routes
  const avgRouteSize = solution.reduce((sum, route) => sum + route.stops.length, 0) / solution.length;
  const balancePenalty = solution.reduce((penalty, route) => {
    const deviation = Math.abs(route.stops.length - avgRouteSize);
    return penalty + deviation * 2;
  }, 0);
  
  // Add heavy penalty for isolation violations
  const violations = findAllIsolationViolations(solution, ISOLATION_DISTANCE);
  const isolationPenalty = violations.length * 100; // Heavy penalty for violations
  
  return totalDistance + routeCountPenalty + balancePenalty + isolationPenalty;
}

function createIsolationAwareNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Isolation-aware operations - choose one randomly
  const operations = [
    () => swapAdjacentStopsWithIsolationCheck(newSolution),
    () => reverseSmallSegmentWithIsolationCheck(newSolution),
    () => moveCustomerToNearbyRouteWithIsolationCheck(newSolution, config)
  ];
  
  // Apply one random operation
  const operation = operations[Math.floor(Math.random() * operations.length)];
  operation();
  
  return newSolution;
}

function swapAdjacentStopsWithIsolationCheck(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  
  // Check if swap would create isolation violations
  const stop1 = route.stops[i];
  const stop2 = route.stops[i + 1];
  
  // Temporarily swap to check violations
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  
  // Check for new violations
  const violations = findAllIsolationViolations(solution, ISOLATION_DISTANCE);
  const hasNewViolations = violations.some(v => 
    v.customer1.customerId === stop1.customerId || v.customer1.customerId === stop2.customerId ||
    v.customer2.customerId === stop1.customerId || v.customer2.customerId === stop2.customerId
  );
  
  // If swap creates violations, revert it
  if (hasNewViolations) {
    [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  }
}

function reverseSmallSegmentWithIsolationCheck(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2; // Always reverse just 2 elements for simplicity
  
  const originalSegment = route.stops.slice(start, start + length);
  const segment = [...originalSegment];
  segment.reverse();
  route.stops.splice(start, length, ...segment);
  
  // Check for new violations
  const violations = findAllIsolationViolations(solution, ISOLATION_DISTANCE);
  const hasNewViolations = violations.some(v => 
    originalSegment.some(stop => 
      v.customer1.customerId === stop.customerId || v.customer2.customerId === stop.customerId
    )
  );
  
  // If reverse creates violations, revert it
  if (hasNewViolations) {
    route.stops.splice(start, length, ...originalSegment);
  }
}

function moveCustomerToNearbyRouteWithIsolationCheck(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const sourceRouteIndex = Math.floor(Math.random() * solution.length);
  const sourceRoute = solution[sourceRouteIndex];
  
  if (sourceRoute.stops.length <= 1) return;
  
  // Find a nearby route (prefer routes in same cluster)
  const sameClusterRoutes = solution.filter((route, index) => 
    index !== sourceRouteIndex && 
    route.clusterIds.some(id => sourceRoute.clusterIds.includes(id))
  );
  
  if (sameClusterRoutes.length === 0) return;
  
  const targetRoute = sameClusterRoutes[Math.floor(Math.random() * sameClusterRoutes.length)];
  
  // Move a random customer
  const customerIndex = Math.floor(Math.random() * sourceRoute.stops.length);
  const customer = sourceRoute.stops[customerIndex];
  
  // Check if move would violate isolation
  if (canAddCustomerWithIsolation(
    {
      id: customer.customerId,
      latitude: customer.latitude,
      longitude: customer.longitude,
      clusterId: customer.clusterId,
      outletName: customer.outletName
    },
    targetRoute,
    solution,
    ISOLATION_DISTANCE
  )) {
    sourceRoute.stops.splice(customerIndex, 1);
    targetRoute.stops.push(customer);
  }
}

function canAddCustomerWithIsolation(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  minDistance: number
): boolean {
  // Check against all customers in other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < minDistance) {
        return false; // Violation found
      }
    }
  }
  
  return true; // No violations
}

function findSuitableBeatWithIsolation(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  minDistance: number
): SalesmanRoute | null {
  for (const route of routes) {
    if (canAddCustomerWithIsolation(customer, route, routes, minDistance)) {
      return route;
    }
  }
  return null;
}

function findBeatWithMinimumConflicts(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  minDistance: number
): SalesmanRoute {
  let bestBeat = routes[0];
  let minConflicts = Infinity;
  
  for (const route of routes) {
    let conflicts = 0;
    
    // Count conflicts with other beats
    for (const otherRoute of routes) {
      if (otherRoute.salesmanId === route.salesmanId) continue;
      
      for (const stop of otherRoute.stops) {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
        
        if (distance < minDistance) {
          conflicts++;
        }
      }
    }
    
    // Prefer beats with fewer customers if conflicts are equal
    const score = conflicts * 1000 + route.stops.length;
    
    if (score < minConflicts) {
      minConflicts = score;
      bestBeat = route;
    }
  }
  
  return bestBeat;
}

async function applyFinalOptimizationWithIsolation(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  // Apply isolation optimization
  const optimizedRoutes = await enforceStrictIsolation(routes, config);
  
  // Very lightweight final optimization
  optimizedRoutes.forEach((route, index) => {
    updateRouteMetrics(route, config);
    
    // Yield control every 20 routes
    if (index % 20 === 0) {
      setTimeout(() => {}, 0);
    }
  });
  
  // Reassign sequential IDs
  return optimizedRoutes.map((route, index) => ({
    ...route,
    salesmanId: index + 1,
    distributorLat: distributor.latitude,
    distributorLng: distributor.longitude
  }));
}

async function enforceStrictIsolation(
  routes: SalesmanRoute[],
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  console.log('🔧 Enforcing strict 200m isolation between beats...');
  
  const MAX_ITERATIONS = 5;
  const MAX_MOVES_PER_ITERATION = 20;
  
  let optimizedRoutes = [...routes];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    console.log(`🔄 Isolation iteration ${iteration + 1}/${MAX_ITERATIONS}`);
    
    // Find all violations
    const violations = findAllIsolationViolations(optimizedRoutes, ISOLATION_DISTANCE);
    
    if (violations.length === 0) {
      console.log(`✅ Perfect isolation achieved after ${iteration + 1} iterations`);
      break;
    }
    
    console.log(`🚨 Found ${violations.length} isolation violations`);
    
    // Sort violations by severity (closest distances first)
    violations.sort((a, b) => a.distance - b.distance);
    
    let movesMade = 0;
    const maxMovesThisIteration = Math.min(violations.length, MAX_MOVES_PER_ITERATION);
    
    // Attempt to resolve violations by moving customers
    for (let i = 0; i < maxMovesThisIteration; i++) {
      const violation = violations[i];
      
      if (attemptViolationResolution(violation, optimizedRoutes, ISOLATION_DISTANCE)) {
        movesMade++;
      }
    }
    
    console.log(`📊 Iteration ${iteration + 1}: Resolved ${movesMade}/${maxMovesThisIteration} violations`);
    
    if (movesMade === 0) {
      console.log('⚠️ No more beneficial moves possible');
      break;
    }
    
    // Yield control
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  return optimizedRoutes;
}

function findAllIsolationViolations(
  routes: SalesmanRoute[],
  minDistance: number
): Array<{
  customer1: RouteStop;
  customer2: RouteStop;
  beat1Id: number;
  beat2Id: number;
  distance: number;
}> {
  const violations: Array<{
    customer1: RouteStop;
    customer2: RouteStop;
    beat1Id: number;
    beat2Id: number;
    distance: number;
  }> = [];
  
  // Check all pairs of beats
  for (let i = 0; i < routes.length; i++) {
    const beat1 = routes[i];
    
    for (let j = i + 1; j < routes.length; j++) {
      const beat2 = routes[j];
      
      // Check all customer pairs between these beats
      for (const customer1 of beat1.stops) {
        for (const customer2 of beat2.stops) {
          const distance = calculateHaversineDistance(
            customer1.latitude, customer1.longitude,
            customer2.latitude, customer2.longitude
          );
          
          if (distance < minDistance) {
            violations.push({
              customer1,
              customer2,
              beat1Id: beat1.salesmanId,
              beat2Id: beat2.salesmanId,
              distance
            });
          }
        }
      }
    }
  }
  
  return violations;
}

function attemptViolationResolution(
  violation: {
    customer1: RouteStop;
    customer2: RouteStop;
    beat1Id: number;
    beat2Id: number;
    distance: number;
  },
  routes: SalesmanRoute[],
  minDistance: number
): boolean {
  const { customer1, customer2, beat1Id, beat2Id } = violation;
  
  // Try moving customer1 to a different beat in the same cluster
  const customer1Beat = routes.find(r => r.salesmanId === beat1Id);
  const customer2Beat = routes.find(r => r.salesmanId === beat2Id);
  
  if (!customer1Beat || !customer2Beat) return false;
  
  // Find alternative beats for customer1 in the same cluster
  const sameClusterBeats = routes.filter(route => 
    route.salesmanId !== beat1Id && 
    route.clusterIds.some(id => customer1.clusterId === id)
  );
  
  // Try moving customer1
  for (const alternativeBeat of sameClusterBeats) {
    if (canAddCustomerWithIsolation(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      alternativeBeat, 
      routes, 
      minDistance
    )) {
      // Move customer1 to alternative beat
      const customerIndex = customer1Beat.stops.findIndex(s => s.customerId === customer1.customerId);
      if (customerIndex !== -1) {
        customer1Beat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer1);
        console.log(`🔄 Moved customer ${customer1.customerId} from beat ${beat1Id} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  // Try moving customer2 if moving customer1 failed
  const customer2SameClusterBeats = routes.filter(route => 
    route.salesmanId !== beat2Id && 
    route.clusterIds.some(id => customer2.clusterId === id)
  );
  
  for (const alternativeBeat of customer2SameClusterBeats) {
    if (canAddCustomerWithIsolation(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      alternativeBeat, 
      routes, 
      minDistance
    )) {
      // Move customer2 to alternative beat
      const customerIndex = customer2Beat.stops.findIndex(s => s.customerId === customer2.customerId);
      if (customerIndex !== -1) {
        customer2Beat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer2);
        console.log(`🔄 Moved customer ${customer2.customerId} from beat ${beat2Id} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  return false; // Could not resolve this violation
}

function generateIsolationReport(routes: SalesmanRoute[]): {
  totalViolations: number;
  violationPercentage: number;
  averageViolationDistance: number;
  beatPairViolations: number;
} {
  const violations = findAllIsolationViolations(routes, ISOLATION_DISTANCE);
  const totalCustomerPairs = routes.reduce((total, route, i) => {
    return total + routes.slice(i + 1).reduce((pairCount, otherRoute) => {
      return pairCount + (route.stops.length * otherRoute.stops.length);
    }, 0);
  }, 0);
  
  const averageDistance = violations.length > 0 
    ? violations.reduce((sum, v) => sum + v.distance, 0) / violations.length 
    : 0;
  
  const beatPairs = new Set(violations.map(v => `${v.beat1Id}-${v.beat2Id}`)).size;
  
  return {
    totalViolations: violations.length,
    violationPercentage: totalCustomerPairs > 0 ? (violations.length / totalCustomerPairs) * 100 : 0,
    averageViolationDistance: averageDistance * 1000, // Convert to meters
    beatPairViolations: beatPairs
  };
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