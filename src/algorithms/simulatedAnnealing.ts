import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Enhanced annealing parameters for strict proximity optimization
const INITIAL_TEMPERATURE = 1000;
const COOLING_RATE = 0.98;
const MIN_TEMPERATURE = 0.01;
const ITERATIONS_PER_TEMP = 100;
const LINEARITY_WEIGHT = 0.3;
const MODE_DISTANCE_WEIGHT = 2.0; // Increased weight for stricter constraint enforcement

// Batch processing size
const BATCH_SIZE = 20;

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting STRICT proximity-optimized simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Calculate mode distance between all outlets for strict constraint
  const modeDistance = calculateModeDistance(customers);
  console.log(`STRICT mode distance between outlets: ${modeDistance.toFixed(2)} km`);
  
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
  
  // Process each cluster independently with strict assignment tracking
  const clusterResults: SalesmanRoute[][] = await Promise.all(
    Object.entries(customersByCluster).map(async ([clusterId, clusterCustomers]) => {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithStrictestProximity(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds,
        modeDistance
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
  
  // Apply cross-cluster optimization while maintaining strict assignment
  routes = await optimizeAcrossClustersWithStrictTracking(routes, distributor, config, modeDistance);
  
  // FINAL verification
  const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`SIMULATED ANNEALING VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`SIMULATED ANNEALING ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `STRICT Proximity-Optimized Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
};

function calculateModeDistance(customers: ClusteredCustomer[]): number {
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
  
  // Create frequency map with smaller binning for more precise mode
  const binSize = 0.2; // 0.2 km bins for better precision
  const frequencyMap = new Map<number, number>();
  
  distances.forEach(distance => {
    const bin = Math.round(distance / binSize) * binSize;
    frequencyMap.set(bin, (frequencyMap.get(bin) || 0) + 1);
  });
  
  // Find the bin with highest frequency (mode)
  let maxFrequency = 0;
  let modeDistance = 0;
  
  frequencyMap.forEach((frequency, bin) => {
    if (frequency > maxFrequency) {
      maxFrequency = frequency;
      modeDistance = bin;
    }
  });
  
  // Use a reasonable minimum that ensures tight clustering
  return Math.max(modeDistance, 1.5);
}

async function processClusterWithStrictestProximity(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  modeDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with STRICTEST proximity optimization for ${customers.length} customers`);
  console.log(`STRICTEST mode distance constraint: ${modeDistance.toFixed(2)} km`);
  
  // Create multiple initial solutions with different approaches and select the best
  const numInitialSolutions = 5;
  let bestSolution = null;
  let bestEnergy = Infinity;
  
  for (let i = 0; i < numInitialSolutions; i++) {
    const solution = createStrictestLinearInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds), modeDistance);
    const energy = calculateStrictProximityEnergyWithModeConstraint(solution, config, modeDistance);
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
        const neighborSolution = createStrictestProximityNeighborSolution(currentSolution, config, modeDistance);
        const neighborEnergy = calculateStrictProximityEnergyWithModeConstraint(neighborSolution, config, modeDistance);
        
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

function createStrictestLinearInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  modeDistance: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Create a working copy to avoid modifying the original
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  console.log(`Creating STRICTEST initial solution for cluster ${clusterId} with ${remainingCustomers.length} customers`);
  
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
    const seedCustomer = findDensestAreaSeed(remainingCustomers, modeDistance);
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
    
    console.log(`Seed customer for STRICTEST beat ${route.salesmanId}: ${seedCustomer.id}`);
    
    // Build tight cluster around seed using STRICTEST constraint
    let addedInThisIteration = true;
    while (addedInThisIteration && 
           route.stops.length < config.maxOutletsPerBeat && 
           remainingCustomers.length > 0) {
      
      addedInThisIteration = false;
      let bestCandidate = null;
      let bestCandidateIndex = -1;
      let minMaxDistance = Infinity;
      
      // Find customer that creates the tightest cluster (minimizes maximum internal distance)
      for (let i = 0; i < remainingCustomers.length; i++) {
        const candidate = remainingCustomers[i];
        
        // Check if adding this candidate would violate the STRICT mode distance constraint
        let maxDistanceInBeat = 0;
        let violatesConstraint = false;
        
        for (const stop of route.stops) {
          const distance = calculateHaversineDistance(
            candidate.latitude, candidate.longitude,
            stop.latitude, stop.longitude
          );
          
          if (distance > modeDistance) {
            violatesConstraint = true;
            break;
          }
          
          maxDistanceInBeat = Math.max(maxDistanceInBeat, distance);
        }
        
        // Only consider candidates that strictly satisfy the constraint
        if (!violatesConstraint && maxDistanceInBeat < minMaxDistance) {
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
        console.log(`Added customer ${customer.id} to STRICTEST beat ${route.salesmanId} (max distance: ${minMaxDistance.toFixed(2)} km)`);
      }
    }
    
    if (route.stops.length > 0) {
      updateRouteMetrics(route, config);
      routes.push(route);
      
      const maxDistanceInBeat = calculateMaxDistanceInBeat(route.stops);
      console.log(`Created STRICTEST beat ${route.salesmanId} with ${route.stops.length} stops, max internal distance: ${maxDistanceInBeat.toFixed(2)} km`);
    }
  }
  
  // Handle any remaining customers by creating additional beats
  if (remainingCustomers.length > 0) {
    console.log(`Creating additional beats for ${remainingCustomers.length} remaining customers...`);
    
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
      
      // Take remaining customers up to max beat size
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
        console.log(`Created additional beat ${route.salesmanId} with ${route.stops.length} stops`);
      }
    }
  }
  
  return routes;
}

function findDensestAreaSeed(customers: ClusteredCustomer[], modeDistance: number): ClusteredCustomer {
  let bestSeed = customers[0];
  let maxNeighbors = 0;
  
  // Find customer with most neighbors within mode distance
  for (const candidate of customers) {
    let neighborCount = 0;
    
    for (const other of customers) {
      if (candidate.id !== other.id) {
        const distance = calculateHaversineDistance(
          candidate.latitude, candidate.longitude,
          other.latitude, other.longitude
        );
        
        if (distance <= modeDistance) {
          neighborCount++;
        }
      }
    }
    
    if (neighborCount > maxNeighbors) {
      maxNeighbors = neighborCount;
      bestSeed = candidate;
    }
  }
  
  console.log(`Selected seed customer ${bestSeed.id} with ${maxNeighbors} neighbors within ${modeDistance.toFixed(2)} km`);
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

function calculateStrictProximityEnergyWithModeConstraint(solution: SalesmanRoute[], config: ClusteringConfig, modeDistance: number): number {
  let totalEnergy = 0;
  
  // Base distance energy
  totalEnergy += solution.reduce((sum, route) => sum + route.totalDistance, 0);
  
  // Penalty for size violations
  solution.forEach(route => {
    if (route.stops.length < config.minOutletsPerBeat) {
      totalEnergy += 1000 * (config.minOutletsPerBeat - route.stops.length);
    }
    if (route.stops.length > config.maxOutletsPerBeat) {
      totalEnergy += 1000 * (route.stops.length - config.maxOutletsPerBeat);
    }
  });
  
  // STRICT mode distance constraint penalty - heavily penalize violations
  solution.forEach(route => {
    const modeDistancePenalty = calculateStrictModeDistancePenalty(route, modeDistance);
    totalEnergy += MODE_DISTANCE_WEIGHT * modeDistancePenalty;
  });
  
  // Compactness bonus - reward tighter clusters
  solution.forEach(route => {
    const compactnessBonus = calculateCompactnessBonus(route, modeDistance);
    totalEnergy -= compactnessBonus; // Subtract to reward compactness
  });
  
  return totalEnergy;
}

function calculateStrictModeDistancePenalty(route: SalesmanRoute, modeDistance: number): number {
  let penalty = 0;
  
  for (let i = 0; i < route.stops.length; i++) {
    for (let j = i + 1; j < route.stops.length; j++) {
      const distance = calculateHaversineDistance(
        route.stops[i].latitude, route.stops[i].longitude,
        route.stops[j].latitude, route.stops[j].longitude
      );
      
      if (distance > modeDistance) {
        // Exponential penalty for violations to strongly discourage them
        penalty += Math.pow(distance - modeDistance, 2) * 5000;
      }
    }
  }
  
  return penalty;
}

function calculateCompactnessBonus(route: SalesmanRoute, modeDistance: number): number {
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
  
  // Bonus for being well below the mode distance
  if (avgDistance < modeDistance * 0.8) {
    return (modeDistance * 0.8 - avgDistance) * 100;
  }
  
  return 0;
}

function createStrictestProximityNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig, modeDistance: number): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Only allow operations that maintain STRICT assignment and mode distance constraint
  const operations = [
    () => swapAdjacentStopsStrictestWithConstraint(newSolution, config, modeDistance),
    () => optimizeRouteOrderStrictestWithConstraint(newSolution, config, modeDistance)
  ];
  
  const numOperations = 1; // Limit to one operation to maintain strictness
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapAdjacentStopsStrictestWithConstraint(solution: SalesmanRoute[], config: ClusteringConfig, modeDistance: number): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  // Only swap adjacent stops to maintain linearity
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  
  // Check if swap would violate STRICT mode distance constraint
  const tempStops = [...route.stops];
  [tempStops[i], tempStops[i + 1]] = [tempStops[i + 1], tempStops[i]];
  
  if (!checkStrictModeDistanceConstraintViolation(tempStops, modeDistance)) {
    [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
    updateRouteMetrics(route, config);
  }
}

function optimizeRouteOrderStrictestWithConstraint(solution: SalesmanRoute[], config: ClusteringConfig, modeDistance: number): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  // Apply simple 2-opt improvement with STRICT constraint checking
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
        // Check if 2-opt swap would violate STRICT mode distance constraint
        const newStops = [
          ...route.stops.slice(0, i),
          ...route.stops.slice(i, j).reverse(),
          ...route.stops.slice(j)
        ];
        
        if (!checkStrictModeDistanceConstraintViolation(newStops, modeDistance)) {
          route.stops = newStops;
          updateRouteMetrics(route, config);
          return; // Only one improvement per call
        }
      }
    }
  }
}

function checkStrictModeDistanceConstraintViolation(stops: RouteStop[], modeDistance: number): boolean {
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      if (distance > modeDistance) {
        return true; // STRICT constraint violated
      }
    }
  }
  return false; // STRICT constraint satisfied
}

async function optimizeAcrossClustersWithStrictTracking(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  modeDistance: number
): Promise<SalesmanRoute[]> {
  // For STRICT tracking, we only optimize within routes, not across routes
  // This prevents any customer reassignment that could cause duplicates
  
  routes.forEach(route => {
    if (route.stops.length >= 3) {
      optimizeRouteOrderStrictestWithConstraint([route], config, modeDistance);
    }
  });
  
  return optimizeBeatsStrict(routes, distributor, config);
}

function optimizeBeatsStrict(routes: SalesmanRoute[], distributor: { latitude: number; longitude: number }, config: ClusteringConfig): SalesmanRoute[] {
  // Only merge routes if they're in the same cluster and won't violate size constraints
  const optimizedRoutes = routes.reduce((acc, route) => {
    if (route.stops.length >= config.minOutletsPerBeat && route.stops.length <= config.maxOutletsPerBeat) {
      acc.push(route);
    } else if (route.stops.length < config.minOutletsPerBeat) {
      const mergeCandidate = acc.find(r => 
        r.clusterIds[0] === route.clusterIds[0] && 
        r.stops.length + route.stops.length <= config.maxOutletsPerBeat
      );
      
      if (mergeCandidate) {
        mergeCandidate.stops.push(...route.stops);
        updateRouteMetrics(mergeCandidate, config);
      } else {
        acc.push(route);
      }
    } else {
      // Split oversized routes
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