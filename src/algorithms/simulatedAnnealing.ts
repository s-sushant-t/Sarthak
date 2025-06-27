import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Enhanced annealing parameters for equal distribution and first-to-last optimization
const INITIAL_TEMPERATURE = 1000;
const COOLING_RATE = 0.98;
const MIN_TEMPERATURE = 0.01;
const ITERATIONS_PER_TEMP = 100;
const FIRST_TO_LAST_WEIGHT = 0.7; // Weight for first-to-last distance in energy calculation
const DISTRIBUTION_PENALTY_WEIGHT = 1000; // Heavy penalty for unequal distribution

// Batch processing size
const BATCH_SIZE = 20;

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting equal-distribution simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Calculate target outlets per beat and cluster with 5% deviation tolerance
  const totalBeats = config.totalClusters * config.beatsPerCluster;
  const targetOutletsPerBeat = Math.floor(customers.length / totalBeats);
  const targetOutletsPerCluster = Math.floor(customers.length / config.totalClusters);
  const maxDeviation = Math.ceil(targetOutletsPerBeat * 0.05); // 5% deviation
  
  const minOutletsPerBeat = Math.max(1, targetOutletsPerBeat - maxDeviation);
  const maxOutletsPerBeat = targetOutletsPerBeat + maxDeviation;
  
  console.log(`Target distribution: ${targetOutletsPerBeat} outlets per beat (${minOutletsPerBeat}-${maxOutletsPerBeat})`);
  
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
  
  // Process each cluster independently with strict equal distribution
  const clusterResults: SalesmanRoute[][] = await Promise.all(
    Object.entries(customersByCluster).map(async ([clusterId, clusterCustomers]) => {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithEqualDistribution(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds,
        targetOutletsPerBeat,
        minOutletsPerBeat,
        maxOutletsPerBeat
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
          const targetRoute = routes.find(r => r.stops.length < maxOutletsPerBeat) || routes[0];
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
        route.stops.length < maxOutletsPerBeat
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
  
  // Apply cross-cluster optimization while maintaining equal distribution
  routes = await optimizeAcrossClustersWithEqualDistribution(routes, distributor, config, targetOutletsPerBeat, minOutletsPerBeat, maxOutletsPerBeat);
  
  // FINAL verification and distribution check
  const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`SIMULATED ANNEALING VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  
  // Check distribution equality
  const beatSizes = routes.map(route => route.stops.length);
  const minBeatSize = Math.min(...beatSizes);
  const maxBeatSize = Math.max(...beatSizes);
  const avgBeatSize = beatSizes.reduce((sum, size) => sum + size, 0) / beatSizes.length;
  const deviation = ((maxBeatSize - minBeatSize) / avgBeatSize) * 100;
  
  console.log(`DISTRIBUTION ANALYSIS:`);
  console.log(`- Beat sizes: min=${minBeatSize}, max=${maxBeatSize}, avg=${avgBeatSize.toFixed(1)}`);
  console.log(`- Deviation: ${deviation.toFixed(1)}% (target: ≤5%)`);
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`SIMULATED ANNEALING ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance (sum of first-to-last distances for all beats)
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Equal-Distribution Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats, ${deviation.toFixed(1)}% deviation)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
};

async function processClusterWithEqualDistribution(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetOutletsPerBeat: number,
  minOutletsPerBeat: number,
  maxOutletsPerBeat: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with equal distribution optimization for ${customers.length} customers`);
  console.log(`Target: ${targetOutletsPerBeat} outlets per beat (${minOutletsPerBeat}-${maxOutletsPerBeat})`);
  
  // Create multiple initial solutions with equal distribution and select the best
  const numInitialSolutions = 5;
  let bestSolution = null;
  let bestEnergy = Infinity;
  
  for (let i = 0; i < numInitialSolutions; i++) {
    const solution = createEqualDistributionInitialSolution(
      clusterId, 
      customers, 
      distributor, 
      config, 
      new Set(assignedIds), 
      targetOutletsPerBeat,
      minOutletsPerBeat,
      maxOutletsPerBeat
    );
    const energy = calculateEqualDistributionEnergyWithFirstToLast(solution, targetOutletsPerBeat);
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
        const neighborSolution = createEqualDistributionNeighborSolution(
          currentSolution, 
          targetOutletsPerBeat,
          minOutletsPerBeat,
          maxOutletsPerBeat
        );
        const neighborEnergy = calculateEqualDistributionEnergyWithFirstToLast(neighborSolution, targetOutletsPerBeat);
        
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

function createEqualDistributionInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetOutletsPerBeat: number,
  minOutletsPerBeat: number,
  maxOutletsPerBeat: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Create a working copy to avoid modifying the original
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  // Calculate exact number of beats needed for equal distribution
  const beatsNeeded = Math.ceil(remainingCustomers.length / targetOutletsPerBeat);
  
  for (let beatIndex = 0; beatIndex < beatsNeeded && remainingCustomers.length > 0; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Calculate exact size for this beat to ensure equal distribution
    const remainingBeats = beatsNeeded - beatIndex;
    const remainingCustomersCount = remainingCustomers.length;
    const beatSize = Math.min(
      Math.ceil(remainingCustomersCount / remainingBeats),
      maxOutletsPerBeat
    );
    
    // Select customers for this beat using equal distribution
    const beatCustomers = [];
    for (let i = 0; i < beatSize && remainingCustomers.length > 0; i++) {
      // Use round-robin selection for equal distribution
      const selectedIndex = i % remainingCustomers.length;
      const selectedCustomer = remainingCustomers.splice(selectedIndex, 1)[0];
      beatCustomers.push(selectedCustomer);
    }
    
    // Optimize order within this beat for minimal first-to-last distance
    const optimizedOrder = optimizeOrderForMinimalFirstToLastDistance(beatCustomers, distributor);
    
    optimizedOrder.forEach(customer => {
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
    });
    
    if (route.stops.length > 0) {
      updateRouteMetricsWithFirstToLastFocus(route, config);
      routes.push(route);
    }
  }
  
  return routes;
}

function calculateEqualDistributionEnergyWithFirstToLast(solution: SalesmanRoute[], targetOutletsPerBeat: number): number {
  let totalEnergy = 0;
  
  // Primary energy: sum of first-to-last distances for all beats
  solution.forEach(route => {
    totalEnergy += route.totalDistance * FIRST_TO_LAST_WEIGHT;
  });
  
  // Heavy penalty for unequal distribution
  solution.forEach(route => {
    const deviation = Math.abs(route.stops.length - targetOutletsPerBeat);
    totalEnergy += deviation * DISTRIBUTION_PENALTY_WEIGHT;
  });
  
  // Additional penalty for extreme size violations
  solution.forEach(route => {
    if (route.stops.length === 0) {
      totalEnergy += 10000; // Very heavy penalty for empty routes
    }
  });
  
  return totalEnergy;
}

function createEqualDistributionNeighborSolution(
  solution: SalesmanRoute[], 
  targetOutletsPerBeat: number,
  minOutletsPerBeat: number,
  maxOutletsPerBeat: number
): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Only allow operations that maintain equal distribution
  const operations = [
    () => swapCustomersBetweenRoutesForEqualDistribution(newSolution, targetOutletsPerBeat),
    () => optimizeRouteOrderForFirstToLast(newSolution),
    () => rebalanceRouteSizesForEqualDistribution(newSolution, targetOutletsPerBeat, minOutletsPerBeat, maxOutletsPerBeat)
  ];
  
  const numOperations = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapCustomersBetweenRoutesForEqualDistribution(solution: SalesmanRoute[], targetOutletsPerBeat: number): void {
  if (solution.length < 2) return;
  
  // Find routes that deviate from target size
  const oversizedRoutes = solution.filter(route => route.stops.length > targetOutletsPerBeat);
  const undersizedRoutes = solution.filter(route => route.stops.length < targetOutletsPerBeat);
  
  if (oversizedRoutes.length > 0 && undersizedRoutes.length > 0) {
    const oversizedRoute = oversizedRoutes[Math.floor(Math.random() * oversizedRoutes.length)];
    const undersizedRoute = undersizedRoutes[Math.floor(Math.random() * undersizedRoutes.length)];
    
    if (oversizedRoute.stops.length > 0) {
      // Move one customer from oversized to undersized route
      const customerIndex = Math.floor(Math.random() * oversizedRoute.stops.length);
      const customer = oversizedRoute.stops.splice(customerIndex, 1)[0];
      undersizedRoute.stops.push(customer);
      
      // Update route metrics
      updateRouteMetricsWithFirstToLastFocus(oversizedRoute, { customerVisitTimeMinutes: 6, travelSpeedKmh: 30 });
      updateRouteMetricsWithFirstToLastFocus(undersizedRoute, { customerVisitTimeMinutes: 6, travelSpeedKmh: 30 });
    }
  }
}

function optimizeRouteOrderForFirstToLast(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  // Try 2-opt improvement focusing on first-to-last distance
  for (let i = 1; i < route.stops.length - 2; i++) {
    for (let j = i + 2; j < route.stops.length; j++) {
      // Calculate current first-to-last distance
      const currentFirstToLast = calculateHaversineDistance(
        route.stops[0].latitude, route.stops[0].longitude,
        route.stops[route.stops.length - 1].latitude, route.stops[route.stops.length - 1].longitude
      );
      
      // Try 2-opt swap
      const newStops = [
        ...route.stops.slice(0, i),
        ...route.stops.slice(i, j).reverse(),
        ...route.stops.slice(j)
      ];
      
      // Calculate new first-to-last distance
      const newFirstToLast = calculateHaversineDistance(
        newStops[0].latitude, newStops[0].longitude,
        newStops[newStops.length - 1].latitude, newStops[newStops.length - 1].longitude
      );
      
      if (newFirstToLast < currentFirstToLast) {
        route.stops = newStops;
        updateRouteMetricsWithFirstToLastFocus(route, { customerVisitTimeMinutes: 6, travelSpeedKmh: 30 });
        return; // Only one improvement per call
      }
    }
  }
}

function rebalanceRouteSizesForEqualDistribution(
  solution: SalesmanRoute[], 
  targetOutletsPerBeat: number,
  minOutletsPerBeat: number,
  maxOutletsPerBeat: number
): void {
  // Calculate current distribution
  const totalCustomers = solution.reduce((sum, route) => sum + route.stops.length, 0);
  const avgSize = totalCustomers / solution.length;
  
  // Find routes that need rebalancing
  const routesToRebalance = solution.filter(route => 
    Math.abs(route.stops.length - targetOutletsPerBeat) > 1
  );
  
  if (routesToRebalance.length < 2) return;
  
  // Redistribute customers to achieve equal distribution
  const allCustomers = solution.flatMap(route => route.stops);
  const customersPerRoute = Math.floor(allCustomers.length / solution.length);
  const extraCustomers = allCustomers.length % solution.length;
  
  // Clear all routes and redistribute
  solution.forEach(route => route.stops = []);
  
  let customerIndex = 0;
  solution.forEach((route, routeIndex) => {
    const routeSize = customersPerRoute + (routeIndex < extraCustomers ? 1 : 0);
    
    for (let i = 0; i < routeSize && customerIndex < allCustomers.length; i++) {
      route.stops.push(allCustomers[customerIndex++]);
    }
    
    updateRouteMetricsWithFirstToLastFocus(route, { customerVisitTimeMinutes: 6, travelSpeedKmh: 30 });
  });
}

function optimizeOrderForMinimalFirstToLastDistance(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[] {
  if (customers.length <= 2) return customers;
  
  // Use nearest neighbor starting from distributor, but optimize for minimal first-to-last distance
  const optimized: ClusteredCustomer[] = [];
  const remaining = [...customers];
  
  // Find the customer closest to distributor as starting point
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
  optimized.push(firstCustomer);
  currentLat = firstCustomer.latitude;
  currentLng = firstCustomer.longitude;
  
  // For the remaining customers, use nearest neighbor but consider the impact on first-to-last distance
  while (remaining.length > 1) {
    let bestNextIndex = 0;
    let bestScore = Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      
      // Calculate immediate distance (nearest neighbor component)
      const immediateDistance = calculateHaversineDistance(
        currentLat, currentLng,
        candidate.latitude, candidate.longitude
      );
      
      // Calculate potential first-to-last distance if we add this customer
      const potentialLastDistance = calculateHaversineDistance(
        firstCustomer.latitude, firstCustomer.longitude,
        candidate.latitude, candidate.longitude
      );
      
      // Combine both factors (weight immediate distance more heavily)
      const score = immediateDistance * 0.7 + potentialLastDistance * 0.3;
      
      if (score < bestScore) {
        bestScore = score;
        bestNextIndex = i;
      }
    }
    
    const nextCustomer = remaining.splice(bestNextIndex, 1)[0];
    optimized.push(nextCustomer);
    currentLat = nextCustomer.latitude;
    currentLng = nextCustomer.longitude;
  }
  
  // Add the last customer
  if (remaining.length === 1) {
    optimized.push(remaining[0]);
  }
  
  return optimized;
}

async function optimizeAcrossClustersWithEqualDistribution(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  targetOutletsPerBeat: number,
  minOutletsPerBeat: number,
  maxOutletsPerBeat: number
): Promise<SalesmanRoute[]> {
  // For equal distribution, we only optimize within routes, not across routes
  // This prevents any customer reassignment that could disrupt equal distribution
  
  routes.forEach(route => {
    if (route.stops.length >= 3) {
      optimizeRouteOrderForFirstToLast([route]);
    }
  });
  
  return optimizeBeatsForEqualDistribution(routes, distributor, config, targetOutletsPerBeat, minOutletsPerBeat, maxOutletsPerBeat);
}

function optimizeBeatsForEqualDistribution(
  routes: SalesmanRoute[], 
  distributor: { latitude: number; longitude: number }, 
  config: ClusteringConfig,
  targetOutletsPerBeat: number,
  minOutletsPerBeat: number,
  maxOutletsPerBeat: number
): SalesmanRoute[] {
  // Only merge/split routes if it improves equal distribution
  const optimizedRoutes = routes.reduce((acc, route) => {
    if (route.stops.length >= minOutletsPerBeat && route.stops.length <= maxOutletsPerBeat) {
      acc.push(route);
    } else if (route.stops.length < minOutletsPerBeat) {
      // Try to merge with another small route in the same cluster
      const mergeCandidate = acc.find(r => 
        r.clusterIds[0] === route.clusterIds[0] && 
        r.stops.length < targetOutletsPerBeat &&
        r.stops.length + route.stops.length <= maxOutletsPerBeat
      );
      
      if (mergeCandidate) {
        mergeCandidate.stops.push(...route.stops);
        updateRouteMetricsWithFirstToLastFocus(mergeCandidate, config);
      } else {
        acc.push(route);
      }
    } else {
      // Split oversized routes to maintain equal distribution
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
      
      updateRouteMetricsWithFirstToLastFocus(route1, config);
      updateRouteMetricsWithFirstToLastFocus(route2, config);
      
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

function updateRouteMetricsWithFirstToLastFocus(route: SalesmanRoute, config: ClusteringConfig): void {
  route.totalTime = 0;
  
  if (route.stops.length === 0) {
    route.totalDistance = 0;
    return;
  }
  
  // Calculate first-to-last distance (the primary metric we're optimizing)
  if (route.stops.length >= 2) {
    const firstStop = route.stops[0];
    const lastStop = route.stops[route.stops.length - 1];
    route.totalDistance = calculateHaversineDistance(
      firstStop.latitude, firstStop.longitude,
      lastStop.latitude, lastStop.longitude
    );
  } else {
    route.totalDistance = 0;
  }
  
  // Calculate time and distance metrics for each stop
  let prevLat = route.distributorLat;
  let prevLng = route.distributorLng;
  
  for (let i = 0; i < route.stops.length; i++) {
    const stop = route.stops[i];
    const distance = calculateHaversineDistance(
      prevLat, prevLng,
      stop.latitude, stop.longitude
    );
    
    const travelTime = calculateTravelTime(distance, config.travelSpeedKmh);
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