import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Enhanced annealing parameters
const INITIAL_TEMPERATURE = 1000; // Increased for better exploration
const COOLING_RATE = 0.98; // Slower cooling
const MIN_TEMPERATURE = 0.01;
const ITERATIONS_PER_TEMP = 100; // More iterations per temperature
const MAX_DISTANCE_VARIANCE = 5;

// Batch processing size
const BATCH_SIZE = 20;

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Track all customers to ensure none are lost
  const allCustomers = [...customers];
  const assignedCustomerIds = new Set<string>();
  
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
  
  // Process each cluster independently
  const clusterResults: SalesmanRoute[][] = await Promise.all(
    Object.entries(customersByCluster).map(async ([clusterId, clusterCustomers]) => {
      const routes = await processCluster(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config
      );
      
      // Track assigned customers
      routes.forEach(route => {
        route.stops.forEach(stop => {
          assignedCustomerIds.add(stop.customerId);
        });
      });
      
      return routes;
    })
  );
  
  // Combine and optimize routes across clusters
  let routes = clusterResults.flat();
  
  // CRITICAL: Check for any unassigned customers
  const unassignedCustomers = allCustomers.filter(customer => !assignedCustomerIds.has(customer.id));
  
  if (unassignedCustomers.length > 0) {
    console.warn(`Found ${unassignedCustomers.length} unassigned customers in simulated annealing! Force-assigning them...`);
    
    // Force assign unassigned customers
    let currentSalesmanId = routes.length > 0 ? Math.max(...routes.map(r => r.salesmanId)) + 1 : 1;
    
    while (unassignedCustomers.length > 0) {
      // Try to add to existing routes first
      let assigned = false;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat && unassignedCustomers.length > 0) {
          const customer = unassignedCustomers.shift()!;
          
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
          
          assignedCustomerIds.add(customer.id);
          assigned = true;
          console.log(`Force-assigned customer ${customer.id} to route ${route.salesmanId}`);
        }
      }
      
      // If no existing route can accommodate, create a new route
      if (!assigned && unassignedCustomers.length > 0) {
        const newRoute: SalesmanRoute = {
          salesmanId: currentSalesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        
        // Add up to maxOutletsPerBeat customers to this new route
        const customersToAdd = Math.min(config.maxOutletsPerBeat, unassignedCustomers.length);
        const clusterIds = new Set<number>();
        
        for (let i = 0; i < customersToAdd; i++) {
          const customer = unassignedCustomers.shift()!;
          clusterIds.add(customer.clusterId);
          
          newRoute.stops.push({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          });
          
          assignedCustomerIds.add(customer.id);
        }
        
        newRoute.clusterIds = Array.from(clusterIds);
        routes.push(newRoute);
        console.log(`Created new route ${newRoute.salesmanId} for ${customersToAdd} unassigned customers`);
      }
    }
  }
  
  routes = await optimizeAcrossClusters(routes, distributor, config);
  
  // Final verification
  const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
  console.log(`Simulated annealing verification: ${finalCustomerCount}/${allCustomers.length} customers in final routes`);
  
  if (finalCustomerCount !== allCustomers.length) {
    console.error(`SIMULATED ANNEALING ERROR: Lost ${allCustomers.length - finalCustomerCount} customers!`);
  }
  
  // Calculate total distance
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
};

async function processCluster(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with ${customers.length} customers`);
  
  // Create multiple initial solutions and select the best
  const numInitialSolutions = 5;
  let bestSolution = null;
  let bestEnergy = Infinity;
  
  for (let i = 0; i < numInitialSolutions; i++) {
    const solution = createInitialSolution(clusterId, customers, distributor, config);
    const energy = calculateEnergy(solution, config);
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
        const neighborSolution = createNeighborSolution(currentSolution, config);
        const neighborEnergy = calculateEnergy(neighborSolution, config);
        
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
  
  // Ensure all customers are assigned in the final solution
  const assignedCustomerIds = new Set<string>();
  bestSolution!.forEach((route: SalesmanRoute) => {
    route.stops.forEach(stop => {
      assignedCustomerIds.add(stop.customerId);
    });
  });
  
  const unassignedInCluster = customers.filter(customer => !assignedCustomerIds.has(customer.id));
  
  if (unassignedInCluster.length > 0) {
    console.warn(`Cluster ${clusterId}: ${unassignedInCluster.length} customers not assigned, force-assigning...`);
    
    // Add unassigned customers to routes
    unassignedInCluster.forEach(customer => {
      // Find route with space or create new one
      let targetRoute = bestSolution!.find((route: SalesmanRoute) => route.stops.length < config.maxOutletsPerBeat);
      
      if (!targetRoute) {
        targetRoute = {
          salesmanId: bestSolution!.length + 1,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [clusterId],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        bestSolution!.push(targetRoute);
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
      
      updateRouteMetrics(targetRoute, config);
    });
  }
  
  return bestSolution!;
}

async function optimizeAcrossClusters(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  let currentSolution = [...routes];
  let bestSolution = [...routes];
  let currentEnergy = calculateGlobalEnergy(currentSolution, config);
  let bestEnergy = currentEnergy;
  
  let temperature = INITIAL_TEMPERATURE * 0.5;
  
  while (temperature > MIN_TEMPERATURE) {
    for (let i = 0; i < ITERATIONS_PER_TEMP / 2; i++) {
      const neighborSolution = createGlobalNeighborSolution(currentSolution, config);
      const neighborEnergy = calculateGlobalEnergy(neighborSolution, config);
      
      const acceptanceProbability = Math.exp(-(neighborEnergy - currentEnergy) / temperature);
      
      if (neighborEnergy < currentEnergy || Math.random() < acceptanceProbability) {
        currentSolution = neighborSolution;
        currentEnergy = neighborEnergy;
        
        if (neighborEnergy < bestEnergy) {
          bestSolution = JSON.parse(JSON.stringify(neighborSolution));
          bestEnergy = neighborEnergy;
        }
      }
      
      if (i % BATCH_SIZE === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    temperature *= COOLING_RATE;
  }
  
  return optimizeBeats(bestSolution, distributor, config);
}

function createGlobalNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Apply multiple neighborhood operations
  const numOperations = 1 + Math.floor(Math.random() * 3);
  
  for (let i = 0; i < numOperations; i++) {
    const operation = Math.random();
    
    if (operation < 0.4) {
      // Swap stops between adjacent clusters
      swapBetweenAdjacentClusters(newSolution, config);
    } else if (operation < 0.7) {
      // Merge and split routes
      mergeAndSplitRoutes(newSolution, config);
    } else {
      // Relocate boundary customers
      relocateBoundaryCustomers(newSolution, config);
    }
  }
  
  return newSolution;
}

function swapBetweenAdjacentClusters(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const route1Index = Math.floor(Math.random() * solution.length);
  const route1 = solution[route1Index];
  
  // Find routes in adjacent clusters
  const adjacentRoutes = solution.filter((r, i) => 
    i !== route1Index && 
    Math.abs(r.clusterIds[0] - route1.clusterIds[0]) === 1
  );
  
  if (adjacentRoutes.length === 0) return;
  
  const route2 = adjacentRoutes[Math.floor(Math.random() * adjacentRoutes.length)];
  
  if (route1.stops.length === 0 || route2.stops.length === 0) return;
  
  // Find boundary customers (those closest to the other cluster)
  const stop1Index = findBoundaryCustomer(route1, route2);
  const stop2Index = findBoundaryCustomer(route2, route1);
  
  if (stop1Index !== -1 && stop2Index !== -1) {
    [route1.stops[stop1Index], route2.stops[stop2Index]] = 
    [route2.stops[stop2Index], route1.stops[stop1Index]];
    
    updateRouteMetrics(route1, config);
    updateRouteMetrics(route2, config);
  }
}

function findBoundaryCustomer(route1: SalesmanRoute, route2: SalesmanRoute): number {
  let minDistance = Infinity;
  let boundaryIndex = -1;
  
  route1.stops.forEach((stop1, index) => {
    route2.stops.forEach(stop2 => {
      const distance = calculateHaversineDistance(
        stop1.latitude, stop1.longitude,
        stop2.latitude, stop2.longitude
      );
      if (distance < minDistance) {
        minDistance = distance;
        boundaryIndex = index;
      }
    });
  });
  
  return boundaryIndex;
}

function mergeAndSplitRoutes(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const route1Index = Math.floor(Math.random() * solution.length);
  let route2Index = Math.floor(Math.random() * solution.length);
  
  while (route2Index === route1Index) {
    route2Index = Math.floor(Math.random() * solution.length);
  }
  
  const route1 = solution[route1Index];
  const route2 = solution[route2Index];
  
  // Merge stops
  const allStops = [...route1.stops, ...route2.stops];
  
  // Split at a random point
  const splitPoint = Math.floor(Math.random() * allStops.length);
  
  route1.stops = allStops.slice(0, splitPoint);
  route2.stops = allStops.slice(splitPoint);
  
  updateRouteMetrics(route1, config);
  updateRouteMetrics(route2, config);
}

function relocateBoundaryCustomers(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const route1Index = Math.floor(Math.random() * solution.length);
  const route1 = solution[route1Index];
  
  if (route1.stops.length <= config.minOutletsPerBeat) return;
  
  // Find routes in adjacent clusters
  const adjacentRoutes = solution.filter((r, i) => 
    i !== route1Index && 
    Math.abs(r.clusterIds[0] - route1.clusterIds[0]) === 1 &&
    r.stops.length < config.maxOutletsPerBeat
  );
  
  if (adjacentRoutes.length === 0) return;
  
  const route2 = adjacentRoutes[Math.floor(Math.random() * adjacentRoutes.length)];
  
  // Find and relocate a boundary customer
  const boundaryIndex = findBoundaryCustomer(route1, route2);
  
  if (boundaryIndex !== -1) {
    const [customer] = route1.stops.splice(boundaryIndex, 1);
    route2.stops.push(customer);
    
    updateRouteMetrics(route1, config);
    updateRouteMetrics(route2, config);
  }
}

function calculateGlobalEnergy(solution: SalesmanRoute[], config: ClusteringConfig): number {
  let energy = calculateEnergy(solution, config);
  
  // Add penalties for cluster boundary violations
  solution.forEach((route1, i) => {
    solution.forEach((route2, j) => {
      if (i < j && Math.abs(route1.clusterIds[0] - route2.clusterIds[0]) === 1) {
        route1.stops.forEach(stop1 => {
          route2.stops.forEach(stop2 => {
            const distance = calculateHaversineDistance(
              stop1.latitude, stop1.longitude,
              stop2.latitude, stop2.longitude
            );
            if (distance < 1) { // 1km threshold
              energy += 1000 * (1 - distance);
            }
          });
        });
      }
    });
  });
  
  return energy;
}

function createInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  const remainingCustomers = [...customers];
  
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
    
    const targetSize = Math.min(
      Math.floor(Math.random() * (config.maxOutletsPerBeat - config.minOutletsPerBeat + 1)) + config.minOutletsPerBeat,
      remainingCustomers.length
    );
    
    for (let i = 0; i < targetSize; i++) {
      const randomIndex = Math.floor(Math.random() * remainingCustomers.length);
      const customer = remainingCustomers.splice(randomIndex, 1)[0];
      
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
    }
  }
  
  return routes;
}

function createNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  const operations = [
    () => swapWithinRoute(newSolution, config),
    () => swapBetweenRoutes(newSolution, config),
    () => reverseSegment(newSolution, config),
    () => relocateCustomer(newSolution, config)
  ];
  
  const numOperations = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapWithinRoute(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  const i = Math.floor(Math.random() * route.stops.length);
  let j = Math.floor(Math.random() * route.stops.length);
  
  while (i === j) {
    j = Math.floor(Math.random() * route.stops.length);
  }
  
  [route.stops[i], route.stops[j]] = [route.stops[j], route.stops[i]];
  updateRouteMetrics(route, config);
}

function swapBetweenRoutes(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const route1Index = Math.floor(Math.random() * solution.length);
  let route2Index = Math.floor(Math.random() * solution.length);
  
  while (route1Index === route2Index) {
    route2Index = Math.floor(Math.random() * solution.length);
  }
  
  const route1 = solution[route1Index];
  const route2 = solution[route2Index];
  
  if (route1.stops.length === 0 || route2.stops.length === 0) return;
  
  const stop1Index = Math.floor(Math.random() * route1.stops.length);
  const stop2Index = Math.floor(Math.random() * route2.stops.length);
  
  if (route1.stops[stop1Index].clusterId === route2.stops[stop2Index].clusterId) {
    [route1.stops[stop1Index], route2.stops[stop2Index]] = 
    [route2.stops[stop2Index], route1.stops[stop1Index]];
    
    updateRouteMetrics(route1, config);
    updateRouteMetrics(route2, config);
  }
}

function reverseSegment(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2 + Math.floor(Math.random() * (route.stops.length - start - 1));
  
  const segment = route.stops.slice(start, start + length);
  segment.reverse();
  route.stops.splice(start, length, ...segment);
  
  updateRouteMetrics(route, config);
}

function relocateCustomer(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const fromRouteIndex = Math.floor(Math.random() * solution.length);
  const fromRoute = solution[fromRouteIndex];
  
  if (fromRoute.stops.length <= config.minOutletsPerBeat) return;
  
  const sameClusterRoutes = solution.filter((r, i) => 
    i !== fromRouteIndex && r.clusterIds[0] === fromRoute.clusterIds[0]
  );
  
  if (sameClusterRoutes.length === 0) return;
  
  const toRoute = sameClusterRoutes[Math.floor(Math.random() * sameClusterRoutes.length)];
  
  if (toRoute.stops.length >= config.maxOutletsPerBeat) return;
  
  const customerIndex = Math.floor(Math.random() * fromRoute.stops.length);
  const [customer] = fromRoute.stops.splice(customerIndex, 1);
  
  let bestPos = 0;
  let minIncrease = Infinity;
  
  for (let i = 0; i <= toRoute.stops.length; i++) {
    toRoute.stops.splice(i, 0, customer);
    updateRouteMetrics(toRoute, config);
    const increase = toRoute.totalDistance;
    
    if (increase < minIncrease) {
      minIncrease = increase;
      bestPos = i;
    }
    
    toRoute.stops.splice(i, 1);
  }
  
  toRoute.stops.splice(bestPos, 0, customer);
  updateRouteMetrics(fromRoute, config);
  updateRouteMetrics(toRoute, config);
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

function calculateEnergy(solution: SalesmanRoute[], config: ClusteringConfig): number {
  let totalEnergy = 0;
  
  totalEnergy += solution.reduce((sum, route) => sum + route.totalDistance, 0);
  
  solution.forEach(route => {
    if (route.stops.length < config.minOutletsPerBeat) {
      totalEnergy += 1000 * (config.minOutletsPerBeat - route.stops.length);
    }
    if (route.stops.length > config.maxOutletsPerBeat) {
      totalEnergy += 1000 * (route.stops.length - config.maxOutletsPerBeat);
    }
  });
  
  const routesByCluster = solution.reduce((acc, route) => {
    const clusterId = route.clusterIds[0];
    if (!acc[clusterId]) acc[clusterId] = [];
    acc[clusterId].push(route);
    return acc;
  }, {} as Record<number, SalesmanRoute[]>);
  
  Object.values(routesByCluster).forEach(clusterRoutes => {
    const avgDistance = clusterRoutes.reduce((sum, r) => sum + r.totalDistance, 0) / clusterRoutes.length;
    
    clusterRoutes.forEach(route => {
      const variance = Math.abs(route.totalDistance - avgDistance);
      if (variance > MAX_DISTANCE_VARIANCE) {
        totalEnergy += 500 * (variance - MAX_DISTANCE_VARIANCE);
      }
    });
  });
  
  return totalEnergy;
}

function optimizeBeats(routes: SalesmanRoute[], distributor: { latitude: number; longitude: number }, config: ClusteringConfig): SalesmanRoute[] {
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