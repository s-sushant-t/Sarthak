import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Highly optimized annealing parameters for fast processing with DUAL constraints
const INITIAL_TEMPERATURE = 50; // Reduced for faster convergence
const COOLING_RATE = 0.92; // Faster cooling
const MIN_TEMPERATURE = 0.5; // Higher minimum
const ITERATIONS_PER_TEMP = 15; // Reduced iterations
const MAX_TOTAL_ITERATIONS = 300; // Hard limit on total iterations
const STRICT_ISOLATION_DISTANCE = 0.05; // 50m minimum separation between beats
const MAX_INTRA_BEAT_DISTANCE = 0.2; // 200m maximum distance within a beat

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting Simulated Annealing with DUAL constraints (50m isolation + 200m max intra-beat) for ${customers.length} customers`);
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
    
    // Process each cluster independently with optimized annealing and DUAL constraints
    const clusterResults: SalesmanRoute[][] = [];
    
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithDualConstraints(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds,
        config.beatsPerCluster,
        STRICT_ISOLATION_DISTANCE,
        MAX_INTRA_BEAT_DISTANCE
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = routes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterCustomers.length} customers assigned in ${routes.length} beats`);
      
      if (assignedInCluster !== clusterCustomers.length) {
        console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterCustomers.length} customers, got ${assignedInCluster}`);
        
        // Find and assign missing customers with DUAL constraints
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers
        missingCustomers.forEach(customer => {
          const suitableBeat = findSuitableBeatWithDualConstraints(customer, routes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
          let targetRoute = suitableBeat;
          
          if (!targetRoute) {
            targetRoute = findBeatWithMinimumConstraintViolations(customer, routes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
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
    
    // Apply comprehensive DUAL constraint optimization
    console.log('🔧 Applying final DUAL constraint optimization (50m isolation + 200m intra-beat)...');
    routes = await applyFinalOptimizationWithDualConstraints(routes, distributor, config, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    
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
    
    // Generate dual constraint report
    const constraintReport = generateDualConstraintReport(routes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    console.log('📊 Final Dual Constraint Report:', constraintReport);
    
    // FINAL verification
    const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
    const uniqueCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
    
    console.log(`SIMULATED ANNEALING VERIFICATION:`);
    console.log(`- Total customers in routes: ${finalCustomerCount}`);
    console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
    console.log(`- Expected customers: ${totalCustomers}`);
    console.log(`- Total beats created: ${routes.length}`);
    console.log(`- Target beats: ${TARGET_TOTAL_BEATS}`);
    console.log(`🎯 Constraint violations: Isolation=${constraintReport.isolationViolations}, Intra-beat=${constraintReport.intraBeatViolations}`);
    console.log(`📏 Max intra-beat distance found: ${constraintReport.maxIntraBeatDistanceFound.toFixed(0)}m (limit: 200m)`);
    
    if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
      console.error(`SIMULATED ANNEALING ERROR: Customer count mismatch!`);
      console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
    }
    
    // Calculate total distance
    const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
    
    return {
      name: `Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats, 50m+200m)`,
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

async function processClusterWithDualConstraints(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetBeats: number,
  isolationDistance: number,
  maxIntraBeatDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with DUAL constraints: ${targetBeats} beats for ${customers.length} customers`);
  
  // Create initial solution with exact beat count and DUAL constraint awareness
  let bestSolution = createDualConstraintAwareInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds), targetBeats, isolationDistance, maxIntraBeatDistance);
  let bestEnergy = calculateDualConstraintAwareEnergy(bestSolution, isolationDistance, maxIntraBeatDistance);
  
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
      
      // Create neighbor solution with DUAL constraint-aware operations
      const neighborSolution = createDualConstraintAwareNeighborSolution(currentSolution, config, isolationDistance, maxIntraBeatDistance);
      const neighborEnergy = calculateDualConstraintAwareEnergy(neighborSolution, isolationDistance, maxIntraBeatDistance);
      
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

function createDualConstraintAwareInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetBeats: number,
  isolationDistance: number,
  maxIntraBeatDistance: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Create a working copy to avoid modifying the original
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  // Calculate optimal distribution of customers across beats
  const customersPerBeat = Math.ceil(remainingCustomers.length / targetBeats);
  
  console.log(`Creating exactly ${targetBeats} beats with ~${customersPerBeat} customers each (DUAL constraint-aware)`);
  
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
    
    // Take customers for this beat using DUAL constraint-aware assignment
    for (let i = 0; i < customersForThisBeat && remainingCustomers.length > 0; i++) {
      let bestCustomerIndex = -1;
      let bestScore = Infinity;
      
      // Find customer that minimizes DUAL constraint violations
      for (let j = 0; j < remainingCustomers.length; j++) {
        const customer = remainingCustomers[j];
        const constraintScore = calculateDualConstraintScore(customer, route, routes, isolationDistance, maxIntraBeatDistance);
        
        if (constraintScore < bestScore) {
          bestScore = constraintScore;
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
  
  // Handle any remaining customers by distributing to existing beats with DUAL constraints
  if (remainingCustomers.length > 0) {
    remainingCustomers.forEach(customer => {
      const suitableBeat = findSuitableBeatWithDualConstraints(customer, routes, isolationDistance, maxIntraBeatDistance);
      let targetRoute = suitableBeat;
      
      if (!targetRoute) {
        targetRoute = findBeatWithMinimumConstraintViolations(customer, routes, isolationDistance, maxIntraBeatDistance);
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

function calculateDualConstraintScore(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): number {
  let isolationViolations = 0;
  let intraBeatViolations = 0;
  let totalViolationDistance = 0;
  
  // Check isolation violations with other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < isolationDistance) {
        isolationViolations++;
        totalViolationDistance += (isolationDistance - distance);
      }
    }
  }
  
  // Check intra-beat distance violations
  for (const stop of targetBeat.stops) {
    const distance = calculateHaversineDistance(
      customer.latitude, customer.longitude,
      stop.latitude, stop.longitude
    );
    
    if (distance > maxIntraBeatDistance) {
      intraBeatViolations++;
      totalViolationDistance += (distance - maxIntraBeatDistance);
    }
  }
  
  // Return score: higher is worse, prioritize isolation violations
  return isolationViolations * 2000 + intraBeatViolations * 1000 + totalViolationDistance * 100;
}

function calculateDualConstraintAwareEnergy(solution: SalesmanRoute[], isolationDistance: number, maxIntraBeatDistance: number): number {
  // Calculate base energy (distance + route count)
  const totalDistance = solution.reduce((sum, route) => sum + route.totalDistance, 0);
  const routeCountPenalty = solution.length * 5;
  
  // Add penalty for unbalanced routes
  const avgRouteSize = solution.reduce((sum, route) => sum + route.stops.length, 0) / solution.length;
  const balancePenalty = solution.reduce((penalty, route) => {
    const deviation = Math.abs(route.stops.length - avgRouteSize);
    return penalty + deviation * 2;
  }, 0);
  
  // Add HEAVY penalty for DUAL constraint violations
  const isolationViolations = findAllIsolationViolations(solution, isolationDistance);
  const intraBeatViolations = findAllIntraBeatViolations(solution, maxIntraBeatDistance);
  
  const isolationPenalty = isolationViolations.length * 1000; // Very heavy penalty for isolation violations
  const intraBeatPenalty = intraBeatViolations.length * 500; // Heavy penalty for intra-beat violations
  
  return totalDistance + routeCountPenalty + balancePenalty + isolationPenalty + intraBeatPenalty;
}

function createDualConstraintAwareNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig, isolationDistance: number, maxIntraBeatDistance: number): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // DUAL constraint-aware operations - choose one randomly
  const operations = [
    () => swapAdjacentStopsWithDualConstraintCheck(newSolution, isolationDistance, maxIntraBeatDistance),
    () => reverseSmallSegmentWithDualConstraintCheck(newSolution, isolationDistance, maxIntraBeatDistance),
    () => moveCustomerToNearbyRouteWithDualConstraintCheck(newSolution, config, isolationDistance, maxIntraBeatDistance)
  ];
  
  // Apply one random operation
  const operation = operations[Math.floor(Math.random() * operations.length)];
  operation();
  
  return newSolution;
}

function swapAdjacentStopsWithDualConstraintCheck(solution: SalesmanRoute[], isolationDistance: number, maxIntraBeatDistance: number): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  
  // Check if swap would create DUAL constraint violations
  const stop1 = route.stops[i];
  const stop2 = route.stops[i + 1];
  
  // Temporarily swap to check violations
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  
  // Check for new violations
  const isolationViolations = findAllIsolationViolations(solution, isolationDistance);
  const intraBeatViolations = findAllIntraBeatViolations(solution, maxIntraBeatDistance);
  
  const hasNewViolations = isolationViolations.some(v => 
    v.customer1.customerId === stop1.customerId || v.customer1.customerId === stop2.customerId ||
    v.customer2.customerId === stop1.customerId || v.customer2.customerId === stop2.customerId
  ) || intraBeatViolations.some(v => 
    v.customer1.customerId === stop1.customerId || v.customer1.customerId === stop2.customerId ||
    v.customer2.customerId === stop1.customerId || v.customer2.customerId === stop2.customerId
  );
  
  // If swap creates violations, revert it
  if (hasNewViolations) {
    [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  }
}

function reverseSmallSegmentWithDualConstraintCheck(solution: SalesmanRoute[], isolationDistance: number, maxIntraBeatDistance: number): void {
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
  const isolationViolations = findAllIsolationViolations(solution, isolationDistance);
  const intraBeatViolations = findAllIntraBeatViolations(solution, maxIntraBeatDistance);
  
  const hasNewViolations = isolationViolations.some(v => 
    originalSegment.some(stop => 
      v.customer1.customerId === stop.customerId || v.customer2.customerId === stop.customerId
    )
  ) || intraBeatViolations.some(v => 
    originalSegment.some(stop => 
      v.customer1.customerId === stop.customerId || v.customer2.customerId === stop.customerId
    )
  );
  
  // If reverse creates violations, revert it
  if (hasNewViolations) {
    route.stops.splice(start, length, ...originalSegment);
  }
}

function moveCustomerToNearbyRouteWithDualConstraintCheck(solution: SalesmanRoute[], config: ClusteringConfig, isolationDistance: number, maxIntraBeatDistance: number): void {
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
  
  // Check if move would violate DUAL constraints
  if (canAddCustomerWithDualConstraints(
    {
      id: customer.customerId,
      latitude: customer.latitude,
      longitude: customer.longitude,
      clusterId: customer.clusterId,
      outletName: customer.outletName
    },
    targetRoute,
    solution,
    isolationDistance,
    maxIntraBeatDistance
  )) {
    sourceRoute.stops.splice(customerIndex, 1);
    targetRoute.stops.push(customer);
  }
}

function canAddCustomerWithDualConstraints(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): boolean {
  // CONSTRAINT 1: Check 50m isolation with other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < isolationDistance) {
        return false; // Isolation violation
      }
    }
  }
  
  // CONSTRAINT 2: Check 200m max distance within the target beat
  for (const stop of targetBeat.stops) {
    const distance = calculateHaversineDistance(
      customer.latitude, customer.longitude,
      stop.latitude, stop.longitude
    );
    
    if (distance > maxIntraBeatDistance) {
      return false; // Intra-beat distance violation
    }
  }
  
  return true; // No violations found
}

function findSuitableBeatWithDualConstraints(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): SalesmanRoute | null {
  for (const route of routes) {
    if (canAddCustomerWithDualConstraints(customer, route, routes, isolationDistance, maxIntraBeatDistance)) {
      return route;
    }
  }
  return null;
}

function findBeatWithMinimumConstraintViolations(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): SalesmanRoute {
  let bestBeat = routes[0];
  let minViolationScore = Infinity;
  
  for (const route of routes) {
    let isolationViolations = 0;
    let intraBeatViolations = 0;
    let totalViolationDistance = 0;
    
    // Count isolation violations with other beats
    for (const otherRoute of routes) {
      if (otherRoute.salesmanId === route.salesmanId) continue;
      
      for (const stop of otherRoute.stops) {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
        
        if (distance < isolationDistance) {
          isolationViolations++;
          totalViolationDistance += (isolationDistance - distance);
        }
      }
    }
    
    // Count intra-beat distance violations
    for (const stop of route.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance > maxIntraBeatDistance) {
        intraBeatViolations++;
        totalViolationDistance += (distance - maxIntraBeatDistance);
      }
    }
    
    // Calculate violation score: prioritize isolation violations, then intra-beat violations
    const violationScore = isolationViolations * 2000 + intraBeatViolations * 1000 + totalViolationDistance * 100 + route.stops.length;
    
    if (violationScore < minViolationScore) {
      minViolationScore = violationScore;
      bestBeat = route;
    }
  }
  
  return bestBeat;
}

async function applyFinalOptimizationWithDualConstraints(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  isolationDistance: number,
  maxIntraBeatDistance: number
): Promise<SalesmanRoute[]> {
  // Apply DUAL constraint optimization
  const optimizedRoutes = await enforceDualConstraintsSA(routes, config, isolationDistance, maxIntraBeatDistance);
  
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

async function enforceDualConstraintsSA(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  isolationDistance: number,
  maxIntraBeatDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`🔧 Enforcing dual constraints: ${isolationDistance * 1000}m isolation + ${maxIntraBeatDistance * 1000}m max intra-beat...`);
  
  const MAX_ITERATIONS = 10;
  const MAX_MOVES_PER_ITERATION = 50;
  
  let optimizedRoutes = [...routes];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    console.log(`🔄 Dual constraint iteration ${iteration + 1}/${MAX_ITERATIONS}`);
    
    // Find all constraint violations
    const isolationViolations = findAllIsolationViolations(optimizedRoutes, isolationDistance);
    const intraBeatViolations = findAllIntraBeatViolations(optimizedRoutes, maxIntraBeatDistance);
    
    const totalViolations = isolationViolations.length + intraBeatViolations.length;
    
    if (totalViolations === 0) {
      console.log(`✅ Perfect dual constraint compliance achieved after ${iteration + 1} iterations`);
      break;
    }
    
    console.log(`🚨 Found ${isolationViolations.length} isolation + ${intraBeatViolations.length} intra-beat violations`);
    
    let movesMade = 0;
    
    // Prioritize resolving isolation violations first (more critical)
    const prioritizedViolations = [
      ...isolationViolations.map(v => ({ ...v, type: 'isolation', priority: 1 })),
      ...intraBeatViolations.map(v => ({ ...v, type: 'intra-beat', priority: 2 }))
    ].sort((a, b) => a.priority - b.priority || a.distance - b.distance);
    
    const maxMovesThisIteration = Math.min(prioritizedViolations.length, MAX_MOVES_PER_ITERATION);
    
    // Attempt to resolve violations by moving customers
    for (let i = 0; i < maxMovesThisIteration; i++) {
      const violation = prioritizedViolations[i];
      
      if (violation.type === 'isolation') {
        if (attemptIsolationViolationResolution(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
          movesMade++;
        }
      } else {
        if (attemptIntraBeatViolationResolution(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
          movesMade++;
        }
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

function findAllIntraBeatViolations(
  routes: SalesmanRoute[],
  maxIntraBeatDistance: number
): Array<{
  customer1: RouteStop;
  customer2: RouteStop;
  beatId: number;
  distance: number;
}> {
  const violations: Array<{
    customer1: RouteStop;
    customer2: RouteStop;
    beatId: number;
    distance: number;
  }> = [];
  
  // Check all customer pairs within each beat
  for (const beat of routes) {
    for (let i = 0; i < beat.stops.length; i++) {
      for (let j = i + 1; j < beat.stops.length; j++) {
        const customer1 = beat.stops[i];
        const customer2 = beat.stops[j];
        
        const distance = calculateHaversineDistance(
          customer1.latitude, customer1.longitude,
          customer2.latitude, customer2.longitude
        );
        
        if (distance > maxIntraBeatDistance) {
          violations.push({
            customer1,
            customer2,
            beatId: beat.salesmanId,
            distance
          });
        }
      }
    }
  }
  
  return violations;
}

function attemptIsolationViolationResolution(
  violation: {
    customer1: RouteStop;
    customer2: RouteStop;
    beat1Id: number;
    beat2Id: number;
    distance: number;
  },
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
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
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
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
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
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

function attemptIntraBeatViolationResolution(
  violation: {
    customer1: RouteStop;
    customer2: RouteStop;
    beatId: number;
    distance: number;
  },
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): boolean {
  const { customer1, customer2, beatId } = violation;
  
  console.log(`🔧 Attempting to resolve intra-beat violation: ${customer1.customerId} ↔ ${customer2.customerId} in beat ${beatId} = ${(violation.distance * 1000).toFixed(0)}m`);
  
  const sourceBeat = routes.find(r => r.salesmanId === beatId);
  if (!sourceBeat) return false;
  
  // Try moving customer1 to a different beat in the same cluster
  const sameClusterBeats = routes.filter(route => 
    route.salesmanId !== beatId && 
    route.clusterIds.some(id => customer1.clusterId === id)
  );
  
  // Try moving customer1
  for (const alternativeBeat of sameClusterBeats) {
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
    )) {
      // Move customer1 to alternative beat
      const customerIndex = sourceBeat.stops.findIndex(s => s.customerId === customer1.customerId);
      if (customerIndex !== -1) {
        sourceBeat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer1);
        console.log(`✅ Moved customer ${customer1.customerId} from beat ${beatId} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  // Try moving customer2 if moving customer1 failed
  for (const alternativeBeat of sameClusterBeats) {
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
    )) {
      // Move customer2 to alternative beat
      const customerIndex = sourceBeat.stops.findIndex(s => s.customerId === customer2.customerId);
      if (customerIndex !== -1) {
        sourceBeat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer2);
        console.log(`✅ Moved customer ${customer2.customerId} from beat ${beatId} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  console.log(`❌ Could not resolve intra-beat violation between ${customer1.customerId} and ${customer2.customerId}`);
  return false;
}

function generateDualConstraintReport(routes: SalesmanRoute[], isolationDistance: number, maxIntraBeatDistance: number): {
  isolationViolations: number;
  intraBeatViolations: number;
  totalViolations: number;
  isolationPercentage: number;
  intraBeatPercentage: number;
  averageIntraBeatDistance: number;
  maxIntraBeatDistanceFound: number;
} {
  const isolationViolations = findAllIsolationViolations(routes, isolationDistance);
  const intraBeatViolations = findAllIntraBeatViolations(routes, maxIntraBeatDistance);
  
  // Calculate total customer pairs between different beats
  const totalInterBeatPairs = routes.reduce((total, route, i) => {
    return total + routes.slice(i + 1).reduce((pairCount, otherRoute) => {
      return pairCount + (route.stops.length * otherRoute.stops.length);
    }, 0);
  }, 0);
  
  // Calculate total customer pairs within beats
  const totalIntraBeatPairs = routes.reduce((total, route) => {
    return total + (route.stops.length * (route.stops.length - 1)) / 2;
  }, 0);
  
  // Calculate average and max intra-beat distances
  let totalIntraBeatDistance = 0;
  let intraBeatDistanceCount = 0;
  let maxIntraBeatDistanceFound = 0;
  
  routes.forEach(route => {
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        totalIntraBeatDistance += distance;
        intraBeatDistanceCount++;
        maxIntraBeatDistanceFound = Math.max(maxIntraBeatDistanceFound, distance);
      }
    }
  });
  
  const averageIntraBeatDistance = intraBeatDistanceCount > 0 ? totalIntraBeatDistance / intraBeatDistanceCount : 0;
  
  return {
    isolationViolations: isolationViolations.length,
    intraBeatViolations: intraBeatViolations.length,
    totalViolations: isolationViolations.length + intraBeatViolations.length,
    isolationPercentage: totalInterBeatPairs > 0 ? (isolationViolations.length / totalInterBeatPairs) * 100 : 0,
    intraBeatPercentage: totalIntraBeatPairs > 0 ? (intraBeatViolations.length / totalIntraBeatPairs) * 100 : 0,
    averageIntraBeatDistance: averageIntraBeatDistance * 1000, // Convert to meters
    maxIntraBeatDistanceFound: maxIntraBeatDistanceFound * 1000 // Convert to meters
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