import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Optimized annealing parameters for faster processing
const INITIAL_TEMPERATURE = 100; // Reduced from 1000
const COOLING_RATE = 0.95; // Faster cooling
const MIN_TEMPERATURE = 0.1; // Higher minimum
const ITERATIONS_PER_TEMP = 20; // Reduced from 100
const MAX_TOTAL_ITERATIONS = 500; // Hard limit on total iterations

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting optimized simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Add timeout mechanism
  const startTime = Date.now();
  const TIMEOUT_MS = 25000; // 25 seconds timeout
  
  const checkTimeout = () => {
    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('Simulated annealing timeout - falling back to nearest neighbor');
    }
  };
  
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
    
    // Process each cluster independently with timeout checking
    const clusterResults: SalesmanRoute[][] = [];
    
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      checkTimeout(); // Check timeout before processing each cluster
      
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithOptimizedAnnealing(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds,
        checkTimeout
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
      
      clusterResults.push(routes);
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
    
    // Apply lightweight optimization while maintaining strict assignment
    routes = await optimizeRoutesLightweight(routes, distributor, config, checkTimeout);
    
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
      name: `Optimized Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats)`,
      totalDistance,
      totalSalesmen: routes.length,
      processingTime: Date.now() - startTime,
      routes
    };
    
  } catch (error) {
    console.error('Simulated annealing failed:', error);
    // Fallback to nearest neighbor approach
    return createFallbackSolution(locationData, config);
  }
};

async function processClusterWithOptimizedAnnealing(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  checkTimeout: () => void
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with optimized annealing for ${customers.length} customers`);
  
  // Create initial solution quickly
  let bestSolution = createFastInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds));
  let bestEnergy = calculateSimpleEnergy(bestSolution);
  
  let currentSolution = JSON.parse(JSON.stringify(bestSolution));
  let currentEnergy = bestEnergy;
  
  let temperature = INITIAL_TEMPERATURE;
  let totalIterations = 0;
  
  while (temperature > MIN_TEMPERATURE && totalIterations < MAX_TOTAL_ITERATIONS) {
    checkTimeout(); // Check timeout during annealing
    
    for (let i = 0; i < ITERATIONS_PER_TEMP && totalIterations < MAX_TOTAL_ITERATIONS; i++) {
      totalIterations++;
      
      // Create neighbor solution with simple operations
      const neighborSolution = createSimpleNeighborSolution(currentSolution, config);
      const neighborEnergy = calculateSimpleEnergy(neighborSolution);
      
      const acceptanceProbability = Math.exp(-(neighborEnergy - currentEnergy) / temperature);
      
      if (neighborEnergy < currentEnergy || Math.random() < acceptanceProbability) {
        currentSolution = neighborSolution;
        currentEnergy = neighborEnergy;
        
        if (neighborEnergy < bestEnergy) {
          bestSolution = JSON.parse(JSON.stringify(neighborSolution));
          bestEnergy = neighborEnergy;
        }
      }
      
      // Yield control occasionally
      if (totalIterations % 50 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    temperature *= COOLING_RATE;
  }
  
  // Update assigned IDs tracking
  bestSolution.forEach((route: SalesmanRoute) => {
    route.stops.forEach(stop => {
      assignedIds.add(stop.customerId);
    });
  });
  
  console.log(`Cluster ${clusterId} annealing completed in ${totalIterations} iterations`);
  
  return bestSolution;
}

function createFastInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Create a working copy to avoid modifying the original
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  const targetBeats = Math.min(config.beatsPerCluster, Math.ceil(remainingCustomers.length / config.minOutletsPerBeat));
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
    
    // Take customers for this beat
    const beatSize = Math.min(customersPerBeat, remainingCustomers.length, config.maxOutletsPerBeat);
    const beatCustomers = remainingCustomers.splice(0, beatSize);
    
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
      assignedIds.add(customer.id);
    });
    
    if (route.stops.length > 0) {
      updateRouteMetrics(route, config);
      routes.push(route);
    }
  }
  
  // Handle any remaining customers
  if (remainingCustomers.length > 0) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    remainingCustomers.forEach(customer => {
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
    
    updateRouteMetrics(route, config);
    routes.push(route);
  }
  
  return routes;
}

function calculateSimpleEnergy(solution: SalesmanRoute[]): number {
  // Simple energy calculation based on total distance and route count
  const totalDistance = solution.reduce((sum, route) => sum + route.totalDistance, 0);
  const routeCountPenalty = solution.length * 10; // Prefer fewer routes
  
  return totalDistance + routeCountPenalty;
}

function createSimpleNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Simple operations only
  const operations = [
    () => swapAdjacentStopsSimple(newSolution),
    () => reverseSegmentSimple(newSolution),
    () => moveCustomerBetweenRoutes(newSolution, config)
  ];
  
  // Apply one random operation
  const operation = operations[Math.floor(Math.random() * operations.length)];
  operation();
  
  return newSolution;
}

function swapAdjacentStopsSimple(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
}

function reverseSegmentSimple(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2 + Math.floor(Math.random() * Math.min(3, route.stops.length - start - 1));
  
  const segment = route.stops.slice(start, start + length);
  segment.reverse();
  route.stops.splice(start, length, ...segment);
}

function moveCustomerBetweenRoutes(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length < 2) return;
  
  const sourceRouteIndex = Math.floor(Math.random() * solution.length);
  const targetRouteIndex = Math.floor(Math.random() * solution.length);
  
  if (sourceRouteIndex === targetRouteIndex) return;
  
  const sourceRoute = solution[sourceRouteIndex];
  const targetRoute = solution[targetRouteIndex];
  
  if (sourceRoute.stops.length <= 1 || targetRoute.stops.length >= config.maxOutletsPerBeat) return;
  
  // Move a random customer
  const customerIndex = Math.floor(Math.random() * sourceRoute.stops.length);
  const customer = sourceRoute.stops.splice(customerIndex, 1)[0];
  targetRoute.stops.push(customer);
}

async function optimizeRoutesLightweight(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  checkTimeout: () => void
): Promise<SalesmanRoute[]> {
  // Lightweight optimization - just update metrics and do basic improvements
  routes.forEach(route => {
    checkTimeout();
    updateRouteMetrics(route, config);
  });
  
  return routes;
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

function createFallbackSolution(
  locationData: LocationData,
  config: ClusteringConfig
): AlgorithmResult {
  console.log('Creating fallback solution for simulated annealing');
  
  const { distributor, customers } = locationData;
  const routes: SalesmanRoute[] = [];
  
  // Simple grouping by cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  let salesmanId = 1;
  
  Object.entries(customersByCluster).forEach(([clusterId, clusterCustomers]) => {
    // Split cluster customers into beats
    const beatsPerCluster = Math.ceil(clusterCustomers.length / config.maxOutletsPerBeat);
    const customersPerBeat = Math.ceil(clusterCustomers.length / beatsPerCluster);
    
    for (let i = 0; i < beatsPerCluster; i++) {
      const startIndex = i * customersPerBeat;
      const endIndex = Math.min(startIndex + customersPerBeat, clusterCustomers.length);
      const beatCustomers = clusterCustomers.slice(startIndex, endIndex);
      
      if (beatCustomers.length > 0) {
        const route: SalesmanRoute = {
          salesmanId: salesmanId++,
          stops: beatCustomers.map(customer => ({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          })),
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [Number(clusterId)],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        
        updateRouteMetrics(route, config);
        routes.push(route);
      }
    }
  });
  
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Simulated Annealing (Fallback) (${config.totalClusters} Clusters, ${routes.length} Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
}