import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Highly optimized annealing parameters for fast processing
const INITIAL_TEMPERATURE = 50; // Reduced for faster convergence
const COOLING_RATE = 0.92; // Faster cooling
const MIN_TEMPERATURE = 0.5; // Higher minimum
const ITERATIONS_PER_TEMP = 15; // Reduced iterations
const MAX_TOTAL_ITERATIONS = 300; // Hard limit on total iterations

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`Target: ${config.totalClusters * config.beatsPerCluster} total beats`);
  
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
    
    // Process each cluster independently with optimized annealing
    const clusterResults: SalesmanRoute[][] = [];
    
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithStrictBeatCount(
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
        
        // Force assign missing customers
        missingCustomers.forEach(customer => {
          const targetRoute = routes.reduce((min, route) => 
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
    
    // Apply final lightweight optimization
    routes = await applyFinalOptimization(routes, distributor, config);
    
    // FINAL verification
    const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
    const uniqueCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
    
    console.log(`SIMULATED ANNEALING VERIFICATION:`);
    console.log(`- Total customers in routes: ${finalCustomerCount}`);
    console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
    console.log(`- Expected customers: ${totalCustomers}`);
    console.log(`- Total beats created: ${routes.length}`);
    console.log(`- Target beats: ${TARGET_TOTAL_BEATS}`);
    
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

async function processClusterWithStrictBeatCount(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with strict beat count: ${targetBeats} beats for ${customers.length} customers`);
  
  // Create initial solution with exact beat count
  let bestSolution = createStrictBeatCountInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds), targetBeats);
  let bestEnergy = calculateVerySimpleEnergy(bestSolution);
  
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
      
      // Create neighbor solution with very simple operations
      const neighborSolution = createVerySimpleNeighborSolution(currentSolution, config);
      const neighborEnergy = calculateVerySimpleEnergy(neighborSolution);
      
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

function createStrictBeatCountInitialSolution(
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
  
  console.log(`Creating exactly ${targetBeats} beats with ~${customersPerBeat} customers each`);
  
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
    
    // Take customers for this beat using simple chunking for speed
    const beatCustomers = remainingCustomers.splice(0, customersForThisBeat);
    
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
    }
    
    routes.push(route); // Add route even if empty to maintain exact beat count
  }
  
  // Handle any remaining customers by distributing to existing beats
  if (remainingCustomers.length > 0) {
    remainingCustomers.forEach(customer => {
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
      updateRouteMetrics(targetRoute, config);
    });
  }
  
  return routes;
}

function calculateVerySimpleEnergy(solution: SalesmanRoute[]): number {
  // Very simple energy calculation for speed
  const totalDistance = solution.reduce((sum, route) => sum + route.totalDistance, 0);
  const routeCountPenalty = solution.length * 5; // Light penalty for route count
  
  // Add penalty for unbalanced routes
  const avgRouteSize = solution.reduce((sum, route) => sum + route.stops.length, 0) / solution.length;
  const balancePenalty = solution.reduce((penalty, route) => {
    const deviation = Math.abs(route.stops.length - avgRouteSize);
    return penalty + deviation * 2;
  }, 0);
  
  return totalDistance + routeCountPenalty + balancePenalty;
}

function createVerySimpleNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Very simple operations only - choose one randomly
  const operations = [
    () => swapAdjacentStopsVerySimple(newSolution),
    () => reverseSmallSegment(newSolution),
    () => moveCustomerToNearbyRoute(newSolution, config)
  ];
  
  // Apply one random operation
  const operation = operations[Math.floor(Math.random() * operations.length)];
  operation();
  
  return newSolution;
}

function swapAdjacentStopsVerySimple(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
}

function reverseSmallSegment(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2; // Always reverse just 2 elements for simplicity
  
  const segment = route.stops.slice(start, start + length);
  segment.reverse();
  route.stops.splice(start, length, ...segment);
}

function moveCustomerToNearbyRoute(solution: SalesmanRoute[], config: ClusteringConfig): void {
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
  const customer = sourceRoute.stops.splice(customerIndex, 1)[0];
  targetRoute.stops.push(customer);
}

async function applyFinalOptimization(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  // Very lightweight final optimization
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