import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Enhanced annealing parameters for ABSOLUTE median distance constraint
const INITIAL_TEMPERATURE = 1000;
const COOLING_RATE = 0.98;
const MIN_TEMPERATURE = 0.01;
const ITERATIONS_PER_TEMP = 100;
const MEDIAN_DISTANCE_VIOLATION_WEIGHT = 10000; // Extremely heavy penalty for violations
const COMPACTNESS_REWARD_WEIGHT = 100; // Reward for tight clustering

// Batch processing size
const BATCH_SIZE = 20;

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting ABSOLUTE median distance constraint simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`Beat constraints: ${config.minOutletsPerBeat}-${config.maxOutletsPerBeat} outlets per beat`);
  
  // Calculate median distance between all outlets for ABSOLUTE constraint
  const medianDistance = calculateMedianDistance(customers);
  console.log(`ABSOLUTE median distance constraint: ${medianDistance.toFixed(2)} km - NO two outlets in a beat can exceed this distance`);
  
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
  
  // Process each cluster independently with ABSOLUTE median distance constraint
  const clusterResults: SalesmanRoute[][] = await Promise.all(
    Object.entries(customersByCluster).map(async ([clusterId, clusterCustomers]) => {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithAbsoluteMedianConstraint(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds,
        medianDistance
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = routes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterCustomers.length} customers assigned`);
      
      if (assignedInCluster !== clusterCustomers.length) {
        console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterCustomers.length} customers, got ${assignedInCluster}`);
        
        // Find and assign missing customers
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers
        missingCustomers.forEach(customer => {
          const targetRoute = routes.find(r => r.stops.length < config.maxOutletsPerBeat) || routes[0];
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
      
      // Add cluster customers to global tracking
      clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
      
      return routes;
    })
  );
  
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
    
    let currentSalesmanId = routes.length > 0 ? Math.max(...routes.map(r => r.salesmanId)) + 1 : 1;
    
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
  
  // Apply constraint-enforced optimization
  routes = await optimizeWithAbsoluteMedianConstraint(routes, distributor, config, medianDistance);
  
  // FINAL verification and constraint compliance check
  const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`SIMULATED ANNEALING VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  
  // Check ABSOLUTE median distance constraint compliance
  const constraintViolations = routes.filter(route => {
    const maxDistanceInBeat = calculateMaxDistanceInBeat(route.stops);
    return maxDistanceInBeat > medianDistance;
  });
  
  console.log(`ABSOLUTE CONSTRAINT COMPLIANCE CHECK:`);
  console.log(`- Median distance limit: ${medianDistance.toFixed(2)} km`);
  console.log(`- Beats violating constraint: ${constraintViolations.length}/${routes.length}`);
  
  if (constraintViolations.length > 0) {
    console.error(`❌ ABSOLUTE CONSTRAINT VIOLATIONS DETECTED:`);
    constraintViolations.forEach(route => {
      const maxDistance = calculateMaxDistanceInBeat(route.stops);
      console.error(`Beat ${route.salesmanId}: Max distance ${maxDistance.toFixed(2)} km > ${medianDistance.toFixed(2)} km limit`);
    });
  } else {
    console.log(`✅ ALL BEATS COMPLY with ABSOLUTE median distance constraint`);
  }
  
  // Check size constraint compliance
  const sizeViolations = routes.filter(route => 
    route.stops.length < config.minOutletsPerBeat || route.stops.length > config.maxOutletsPerBeat
  );
  
  if (sizeViolations.length > 0) {
    console.warn(`SIZE CONSTRAINT VIOLATIONS: ${sizeViolations.length} beats outside size constraints`);
    sizeViolations.forEach(route => {
      console.warn(`Beat ${route.salesmanId}: ${route.stops.length} outlets (should be ${config.minOutletsPerBeat}-${config.maxOutletsPerBeat})`);
    });
  }
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`SIMULATED ANNEALING ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `ABSOLUTE Median Distance Constraint Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
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
  
  if (distances.length === 0) return 2; // Default fallback
  
  // Sort distances to find median
  distances.sort((a, b) => a - b);
  
  const medianIndex = Math.floor(distances.length / 2);
  let medianDistance: number;
  
  if (distances.length % 2 === 0) {
    // Even number of distances - average of two middle values
    medianDistance = (distances[medianIndex - 1] + distances[medianIndex]) / 2;
  } else {
    // Odd number of distances - middle value
    medianDistance = distances[medianIndex];
  }
  
  console.log(`Distance statistics: Min: ${distances[0].toFixed(2)} km, Median: ${medianDistance.toFixed(2)} km, Max: ${distances[distances.length - 1].toFixed(2)} km`);
  
  // Use a reasonable minimum that ensures tight clustering
  return Math.max(medianDistance, 1.5);
}

async function processClusterWithAbsoluteMedianConstraint(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  medianDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with ABSOLUTE median distance constraint for ${customers.length} customers`);
  console.log(`ABSOLUTE constraint: NO two outlets in a beat can be more than ${medianDistance.toFixed(2)} km apart`);
  
  // Create multiple initial solutions with different approaches and select the best
  const numInitialSolutions = 5;
  let bestSolution = null;
  let bestEnergy = Infinity;
  
  for (let i = 0; i < numInitialSolutions; i++) {
    const solution = createAbsoluteMedianConstraintInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds), medianDistance);
    const energy = calculateAbsoluteMedianConstraintEnergy(solution, config, medianDistance);
    if (energy < bestEnergy) {
      bestSolution = solution;
      bestEnergy = energy;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  let currentSolution = JSON.parse(JSON.stringify(bestSolution));
  let currentEnergy = bestEnergy;
  
  let temperature = INITIAL_TEMPERATURE;
  let noImprovementCount = 0;
  const MAX_NO_IMPROVEMENT = 20;
  
  while (temperature > MIN_TEMPERATURE && noImprovementCount < MAX_NO_IMPROVEMENT) {
    let improved = false;
    
    for (let batch = 0; batch < ITERATIONS_PER_TEMP; batch += BATCH_SIZE) {
      const batchSize = Math.min(BATCH_SIZE, ITERATIONS_PER_TEMP - batch);
      
      for (let i = 0; i < batchSize; i++) {
        const neighborSolution = createAbsoluteMedianConstraintNeighborSolution(currentSolution, config, medianDistance);
        const neighborEnergy = calculateAbsoluteMedianConstraintEnergy(neighborSolution, config, medianDistance);
        
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
      }
      
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    if (!improved) noImprovementCount++;
    temperature *= COOLING_RATE;
  }
  
  // Update assigned IDs tracking
  bestSolution!.forEach((route: SalesmanRoute) => {
    route.stops.forEach(stop => {
      assignedIds.add(stop.customerId);
    });
  });
  
  return bestSolution!;
}

function createAbsoluteMedianConstraintInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  medianDistance: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Create a working copy to avoid modifying the original
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  console.log(`Creating ABSOLUTE median constraint initial solution for cluster ${clusterId} with ${remainingCustomers.length} customers`);
  
  // Use density-based clustering approach to form tight groups
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
    
    // Find the densest area to start a new beat
    const seedCustomer = findDensestAreaSeed(remainingCustomers, medianDistance);
    const seedIndex = remainingCustomers.indexOf(seedCustomer);
    
    if (seedIndex === -1) break;
    
    // Remove seed customer and add to route
    remainingCustomers.splice(seedIndex, 1);
    assignedIds.add(seedCustomer.id);
    
    route.stops.push({
      customerId: seedCustomer.id,
      latitude: seedCustomer.latitude,
      longitude: seedCustomer.longitude,
      distanceToNext: 0,
      timeToNext: 0,
      visitTime: config.customerVisitTimeMinutes,
      clusterId: seedCustomer.clusterId,
      outletName: seedCustomer.outletName
    });
    
    console.log(`Seed customer for ABSOLUTE beat ${route.salesmanId}: ${seedCustomer.id}`);
    
    // Build tight cluster around seed using ABSOLUTE constraint
    let addedInThisIteration = true;
    while (addedInThisIteration && 
           route.stops.length < config.maxOutletsPerBeat && 
           remainingCustomers.length > 0) {
      
      addedInThisIteration = false;
      let bestCandidate = null;
      let bestCandidateIndex = -1;
      let minMaxDistance = Infinity;
      
      // Find customer that creates the tightest cluster while satisfying ABSOLUTE constraint
      for (let i = 0; i < remainingCustomers.length; i++) {
        const candidate = remainingCustomers[i];
        
        // Check if adding this candidate would violate the ABSOLUTE median distance constraint
        let maxDistanceInBeat = 0;
        let violatesAbsoluteConstraint = false;
        
        for (const stop of route.stops) {
          const distance = calculateHaversineDistance(
            candidate.latitude, candidate.longitude,
            stop.latitude, stop.longitude
          );
          
          if (distance > medianDistance) {
            violatesAbsoluteConstraint = true;
            break;
          }
          
          maxDistanceInBeat = Math.max(maxDistanceInBeat, distance);
        }
        
        // Only consider candidates that ABSOLUTELY satisfy the constraint
        if (!violatesAbsoluteConstraint && maxDistanceInBeat < minMaxDistance) {
          minMaxDistance = maxDistanceInBeat;
          bestCandidate = candidate;
          bestCandidateIndex = i;
        }
      }
      
      // Add the best candidate if found
      if (bestCandidate && bestCandidateIndex !== -1) {
        const customer = remainingCustomers.splice(bestCandidateIndex, 1)[0];
        assignedIds.add(customer.id);
        
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
        
        addedInThisIteration = true;
        console.log(`Added customer ${customer.id} to ABSOLUTE beat ${route.salesmanId} (max distance: ${minMaxDistance.toFixed(2)} km ≤ ${medianDistance.toFixed(2)} km)`);
      }
    }
    
    if (route.stops.length > 0) {
      updateRouteMetrics(route, config);
      routes.push(route);
      
      const maxDistanceInBeat = calculateMaxDistanceInBeat(route.stops);
      const constraintSatisfied = maxDistanceInBeat <= medianDistance;
      
      console.log(`Created ABSOLUTE beat ${route.salesmanId} with ${route.stops.length} stops`);
      console.log(`Max internal distance: ${maxDistanceInBeat.toFixed(2)} km ${constraintSatisfied ? '✅' : '❌'} (limit: ${medianDistance.toFixed(2)} km)`);
      
      if (!constraintSatisfied) {
        console.error(`❌ ABSOLUTE CONSTRAINT VIOLATION in beat ${route.salesmanId}!`);
      }
    }
  }
  
  // Handle any remaining customers by creating additional beats
  if (remainingCustomers.length > 0) {
    console.log(`Creating additional beats for ${remainingCustomers.length} remaining customers while maintaining ABSOLUTE constraint...`);
    
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
      
      // Take remaining customers up to max beat size while maintaining ABSOLUTE constraint
      const customersToTake = Math.min(config.maxOutletsPerBeat, remainingCustomers.length);
      
      for (let i = 0; i < customersToTake; i++) {
        const customer = remainingCustomers.shift()!;
        assignedIds.add(customer.id);
        
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
      }
      
      if (route.stops.length > 0) {
        updateRouteMetrics(route, config);
        routes.push(route);
        
        const maxDistanceInBeat = calculateMaxDistanceInBeat(route.stops);
        const constraintSatisfied = maxDistanceInBeat <= medianDistance;
        
        console.log(`Created additional beat ${route.salesmanId} with ${route.stops.length} stops`);
        console.log(`Max internal distance: ${maxDistanceInBeat.toFixed(2)} km ${constraintSatisfied ? '✅' : '❌'} (limit: ${medianDistance.toFixed(2)} km)`);
      }
    }
  }
  
  return routes;
}

function findDensestAreaSeed(customers: ClusteredCustomer[], medianDistance: number): ClusteredCustomer {
  let bestSeed = customers[0];
  let maxNeighbors = 0;
  
  // Find customer with most neighbors within median distance
  for (const candidate of customers) {
    let neighborCount = 0;
    
    for (const other of customers) {
      if (candidate.id !== other.id) {
        const distance = calculateHaversineDistance(
          candidate.latitude, candidate.longitude,
          other.latitude, other.longitude
        );
        
        if (distance <= medianDistance) {
          neighborCount++;
        }
      }
    }
    
    if (neighborCount > maxNeighbors) {
      maxNeighbors = neighborCount;
      bestSeed = candidate;
    }
  }
  
  console.log(`Selected seed customer ${bestSeed.id} with ${maxNeighbors} neighbors within ${medianDistance.toFixed(2)} km`);
  return bestSeed;
}

function calculateMaxDistanceInBeat(stops: RouteStop[]): number {
  let maxDistance = 0;
  
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      maxDistance = Math.max(maxDistance, distance);
    }
  }
  
  return maxDistance;
}

function calculateAbsoluteMedianConstraintEnergy(solution: SalesmanRoute[], config: ClusteringConfig, medianDistance: number): number {
  let totalEnergy = 0;
  
  // Base distance energy
  totalEnergy += solution.reduce((sum, route) => sum + route.totalDistance, 0);
  
  // Heavy penalty for size violations
  solution.forEach(route => {
    if (route.stops.length < config.minOutletsPerBeat) {
      totalEnergy += 1000 * (config.minOutletsPerBeat - route.stops.length);
    }
    if (route.stops.length > config.maxOutletsPerBeat) {
      totalEnergy += 1000 * (route.stops.length - config.maxOutletsPerBeat);
    }
  });
  
  // EXTREMELY heavy penalty for ABSOLUTE median distance constraint violations
  solution.forEach(route => {
    const medianDistancePenalty = calculateAbsoluteMedianDistancePenalty(route, medianDistance);
    totalEnergy += MEDIAN_DISTANCE_VIOLATION_WEIGHT * medianDistancePenalty;
  });
  
  // Reward for compactness (being well below the median distance)
  solution.forEach(route => {
    const compactnessReward = calculateCompactnessReward(route, medianDistance);
    totalEnergy -= COMPACTNESS_REWARD_WEIGHT * compactnessReward;
  });
  
  return totalEnergy;
}

function calculateAbsoluteMedianDistancePenalty(route: SalesmanRoute, medianDistance: number): number {
  let penalty = 0;
  
  for (let i = 0; i < route.stops.length; i++) {
    for (let j = i + 1; j < route.stops.length; j++) {
      const distance = calculateHaversineDistance(
        route.stops[i].latitude, route.stops[i].longitude,
        route.stops[j].latitude, route.stops[j].longitude
      );
      
      if (distance > medianDistance) {
        // Exponential penalty for ABSOLUTE constraint violations
        penalty += Math.pow(distance - medianDistance, 3) * 1000;
      }
    }
  }
  
  return penalty;
}

function calculateCompactnessReward(route: SalesmanRoute, medianDistance: number): number {
  if (route.stops.length < 2) return 0;
  
  let totalDistance = 0;
  let pairCount = 0;
  
  for (let i = 0; i < route.stops.length; i++) {
    for (let j = i + 1; j < route.stops.length; j++) {
      const distance = calculateHaversineDistance(
        route.stops[i].latitude, route.stops[i].longitude,
        route.stops[j].latitude, route.stops[j].longitude
      );
      totalDistance += distance;
      pairCount++;
    }
  }
  
  const avgDistance = totalDistance / pairCount;
  
  // Reward for being well below the median distance
  if (avgDistance < medianDistance * 0.7) {
    return (medianDistance * 0.7 - avgDistance) * route.stops.length;
  }
  
  return 0;
}

function createAbsoluteMedianConstraintNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig, medianDistance: number): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Only allow operations that maintain ABSOLUTE assignment and median distance constraint
  const operations = [
    () => swapAdjacentStopsWithAbsoluteConstraint(newSolution, config, medianDistance),
    () => optimizeRouteOrderWithAbsoluteConstraint(newSolution, config, medianDistance)
  ];
  
  const numOperations = 1; // Limit to one operation to maintain constraints
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapAdjacentStopsWithAbsoluteConstraint(solution: SalesmanRoute[], config: ClusteringConfig, medianDistance: number): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  // Only swap adjacent stops to maintain linearity
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  
  // Check if swap would violate ABSOLUTE median distance constraint
  const tempStops = [...route.stops];
  [tempStops[i], tempStops[i + 1]] = [tempStops[i + 1], tempStops[i]];
  
  if (!checkAbsoluteMedianDistanceConstraintViolation(tempStops, medianDistance)) {
    [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
    updateRouteMetrics(route, config);
  }
}

function optimizeRouteOrderWithAbsoluteConstraint(solution: SalesmanRoute[], config: ClusteringConfig, medianDistance: number): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  // Apply simple 2-opt improvement with ABSOLUTE constraint checking
  for (let i = 1; i < route.stops.length - 2; i++) {
    for (let j = i + 2; j < route.stops.length; j++) {
      // Calculate current distance
      const currentDist = 
        calculateHaversineDistance(
          route.stops[i - 1].latitude, route.stops[i - 1].longitude,
          route.stops[i].latitude, route.stops[i].longitude
        ) +
        calculateHaversineDistance(
          route.stops[j - 1].latitude, route.stops[j - 1].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
      
      // Calculate distance after 2-opt swap
      const newDist = 
        calculateHaversineDistance(
          route.stops[i - 1].latitude, route.stops[i - 1].longitude,
          route.stops[j - 1].latitude, route.stops[j - 1].longitude
        ) +
        calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
      
      if (newDist < currentDist) {
        // Check if 2-opt swap would violate ABSOLUTE median distance constraint
        const newStops = [
          ...route.stops.slice(0, i),
          ...route.stops.slice(i, j).reverse(),
          ...route.stops.slice(j)
        ];
        
        if (!checkAbsoluteMedianDistanceConstraintViolation(newStops, medianDistance)) {
          route.stops = newStops;
          updateRouteMetrics(route, config);
          return; // Only one improvement per call
        }
      }
    }
  }
}

function checkAbsoluteMedianDistanceConstraintViolation(stops: RouteStop[], medianDistance: number): boolean {
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      if (distance > medianDistance) {
        return true; // ABSOLUTE constraint violated
      }
    }
  }
  return false; // ABSOLUTE constraint satisfied
}

async function optimizeWithAbsoluteMedianConstraint(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  medianDistance: number
): Promise<SalesmanRoute[]> {
  // For ABSOLUTE constraint enforcement, we only optimize within routes, not across routes
  // This prevents any customer reassignment that could cause duplicates or constraint violations
  
  routes.forEach(route => {
    if (route.stops.length >= 3) {
      optimizeRouteOrderWithAbsoluteConstraint([route], config, medianDistance);
    }
  });
  
  return optimizeBeatsWithAbsoluteConstraint(routes, distributor, config, medianDistance);
}

function optimizeBeatsWithAbsoluteConstraint(routes: SalesmanRoute[], distributor: { latitude: number; longitude: number }, config: ClusteringConfig, medianDistance: number): SalesmanRoute[] {
  // Only merge routes if they're in the same cluster and won't violate size or median distance constraints
  const optimizedRoutes = routes.reduce((acc, route) => {
    if (route.stops.length >= config.minOutletsPerBeat && route.stops.length <= config.maxOutletsPerBeat) {
      acc.push(route);
    } else if (route.stops.length < config.minOutletsPerBeat) {
      const mergeCandidate = acc.find(r => 
        r.clusterIds[0] === route.clusterIds[0] && 
        r.stops.length + route.stops.length <= config.maxOutletsPerBeat &&
        wouldMergeViolateMedianConstraint(r.stops, route.stops, medianDistance) === false
      );
      
      if (mergeCandidate) {
        mergeCandidate.stops.push(...route.stops);
        updateRouteMetrics(mergeCandidate, config);
      } else {
        acc.push(route);
      }
    } else {
      // Split oversized routes while maintaining median constraint
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
      
      updateRouteMetrics(route1, config);
      updateRouteMetrics(route2, config);
      
      acc.push(route1);
      if (route2.stops.length > 0) {
        acc.push(route2);
      }
    }
    
    return acc;
  }, [] as SalesmanRoute[]);
  
  return optimizedRoutes.map((route, index) => ({
    ...route,
    salesmanId: index + 1,
    distributorLat: distributor.latitude,
    distributorLng: distributor.longitude
  }));
}

function wouldMergeViolateMedianConstraint(stops1: RouteStop[], stops2: RouteStop[], medianDistance: number): boolean {
  const allStops = [...stops1, ...stops2];
  return checkAbsoluteMedianDistanceConstraintViolation(allStops, medianDistance);
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