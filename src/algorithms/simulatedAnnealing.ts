import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Enhanced annealing parameters for proximity optimization
const INITIAL_TEMPERATURE = 1000;
const COOLING_RATE = 0.98;
const MIN_TEMPERATURE = 0.01;
const ITERATIONS_PER_TEMP = 100;
const LINEARITY_WEIGHT = 0.3; // Weight for linearity in energy calculation
const WITHIN_BEAT_MEDIAN_DISTANCE_WEIGHT = 0.5; // Weight for within-beat median distance constraint violations

// Batch processing size
const BATCH_SIZE = 20;

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-optimized simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
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
      const routes = await processClusterWithStrictProximity(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds
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
  routes = await optimizeAcrossClustersWithStrictTracking(routes, distributor, config);
  
  // Apply within-beat median distance constraint optimization to all routes
  routes.forEach(route => {
    if (route.stops.length > 2) {
      applyWithinBeatMedianDistanceConstraint(route, distributor, config);
    }
  });
  
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
    name: `Proximity-Optimized Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
};

function calculateMedianDistanceWithinBeat(stops: RouteStop[]): number {
  if (stops.length < 2) return Infinity; // No constraint for single-stop beats
  
  const distances: number[] = [];
  
  // Calculate distances between all pairs of stops within this beat
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      distances.push(distance);
    }
  }
  
  if (distances.length === 0) return Infinity;
  
  // Sort distances and find median
  distances.sort((a, b) => a - b);
  const midIndex = Math.floor(distances.length / 2);
  
  if (distances.length % 2 === 0) {
    return (distances[midIndex - 1] + distances[midIndex]) / 2;
  } else {
    return distances[midIndex];
  }
}

function applyWithinBeatMedianDistanceConstraint(
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): void {
  if (route.stops.length < 3) return;
  
  console.log(`Applying within-beat median distance constraint to beat ${route.salesmanId} with ${route.stops.length} stops`);
  
  // Calculate the current median distance within this beat
  const currentMedianDistance = calculateMedianDistanceWithinBeat(route.stops);
  console.log(`Beat ${route.salesmanId} current median distance: ${currentMedianDistance.toFixed(2)} km`);
  
  // If the median distance is reasonable (not too large), apply constraint
  if (currentMedianDistance > 0 && currentMedianDistance < 50) { // 50km is a reasonable upper limit
    
    // Check if any pair of stops violates the median distance constraint
    let hasViolations = false;
    const violations: { i: number; j: number; distance: number }[] = [];
    
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        
        if (distance > currentMedianDistance) {
          hasViolations = true;
          violations.push({ i, j, distance });
        }
      }
    }
    
    if (hasViolations) {
      console.log(`Beat ${route.salesmanId}: Found ${violations.length} median distance violations, optimizing...`);
      
      // Try to optimize the route order to minimize violations
      optimizeRouteOrderForMedianDistanceConstraint(route, distributor, currentMedianDistance);
      
      // Recalculate violations after optimization
      const remainingViolations = [];
      for (let i = 0; i < route.stops.length; i++) {
        for (let j = i + 1; j < route.stops.length; j++) {
          const distance = calculateHaversineDistance(
            route.stops[i].latitude, route.stops[i].longitude,
            route.stops[j].latitude, route.stops[j].longitude
          );
          
          if (distance > currentMedianDistance) {
            remainingViolations.push({ i, j, distance });
          }
        }
      }
      
      console.log(`Beat ${route.salesmanId}: After optimization, ${remainingViolations.length} violations remain`);
    } else {
      console.log(`Beat ${route.salesmanId}: No median distance violations found`);
    }
  } else {
    console.log(`Beat ${route.salesmanId}: Median distance ${currentMedianDistance.toFixed(2)} km is outside reasonable range, skipping constraint`);
  }
}

function optimizeRouteOrderForMedianDistanceConstraint(
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number },
  medianDistance: number
): void {
  if (route.stops.length < 4) return;
  
  let improved = true;
  let iterations = 0;
  const maxIterations = 10;
  
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    
    // Try 2-opt improvements that reduce median distance violations
    for (let i = 1; i < route.stops.length - 2; i++) {
      for (let j = i + 2; j < route.stops.length; j++) {
        // Create new route order with 2-opt swap
        const newStops = [
          ...route.stops.slice(0, i),
          ...route.stops.slice(i, j).reverse(),
          ...route.stops.slice(j)
        ];
        
        // Count violations in current order
        const currentViolations = countMedianDistanceViolations(route.stops, medianDistance);
        
        // Count violations in new order
        const newViolations = countMedianDistanceViolations(newStops, medianDistance);
        
        // If new order has fewer violations, apply the swap
        if (newViolations < currentViolations) {
          route.stops = newStops;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
}

function countMedianDistanceViolations(stops: RouteStop[], medianDistance: number): number {
  let violations = 0;
  
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      
      if (distance > medianDistance) {
        violations++;
      }
    }
  }
  
  return violations;
}

async function processClusterWithStrictProximity(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with strict proximity optimization for ${customers.length} customers`);
  
  // Create multiple initial solutions with different approaches and select the best
  const numInitialSolutions = 5;
  let bestSolution = null;
  let bestEnergy = Infinity;
  
  for (let i = 0; i < numInitialSolutions; i++) {
    const solution = createStrictLinearInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds));
    const energy = calculateProximityEnergyWithWithinBeatMedianConstraint(solution, config);
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
        const neighborSolution = createStrictProximityNeighborSolution(currentSolution, config);
        const neighborEnergy = calculateProximityEnergyWithWithinBeatMedianConstraint(neighborSolution, config);
        
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

function createStrictLinearInitialSolution(
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
  
  // Sort customers by angle from distributor to create directional sweeps
  const customersWithAngles = remainingCustomers.map(customer => ({
    ...customer,
    angle: calculateAngle(distributor.latitude, distributor.longitude, customer.latitude, customer.longitude)
  }));
  
  customersWithAngles.sort((a, b) => a.angle - b.angle);
  
  const targetBeats = config.beatsPerCluster;
  
  for (let beatIndex = 0; beatIndex < targetBeats && customersWithAngles.length > 0; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Calculate customers for this beat
    const remainingCustomersCount = customersWithAngles.length;
    const remainingBeats = targetBeats - beatIndex;
    const customersForThisBeat = Math.min(
      Math.ceil(remainingCustomersCount / remainingBeats),
      config.maxOutletsPerBeat
    );
    
    // Build route with proximity optimization
    const beatCustomers = [];
    let attempts = 0;
    const maxAttempts = customersForThisBeat * 2; // Allow some flexibility
    
    while (beatCustomers.length < customersForThisBeat && customersWithAngles.length > 0 && attempts < maxAttempts) {
      attempts++;
      
      // Take the next customer in angular order
      const selectedCustomer = customersWithAngles.shift()!;
      beatCustomers.push(selectedCustomer);
    }
    
    // Optimize order within this directional sweep using nearest neighbor
    const optimizedOrder = optimizeLinearOrderStrict(beatCustomers, distributor);
    
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
      updateRouteMetrics(route, config);
      routes.push(route);
    }
  }
  
  // CRITICAL FIX: Handle any remaining unassigned customers
  if (customersWithAngles.length > 0) {
    console.log(`Cluster ${clusterId}: ${customersWithAngles.length} customers remaining after initial beat creation`);
    
    // Assign remaining customers to existing routes or create new ones
    customersWithAngles.forEach(customer => {
      // Try to find an existing route with space
      let targetRoute = routes.find(route => route.stops.length < config.maxOutletsPerBeat);
      
      // If no route has space, create a new one
      if (!targetRoute) {
        targetRoute = {
          salesmanId: salesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [clusterId],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        routes.push(targetRoute);
      }
      
      // Add customer to the target route
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
    
    console.log(`Cluster ${clusterId}: All remaining customers assigned. Total routes: ${routes.length}`);
  }
  
  return routes;
}

function calculateAngle(centerLat: number, centerLng: number, pointLat: number, pointLng: number): number {
  const dLng = (pointLng - centerLng) * Math.PI / 180;
  const dLat = (pointLat - centerLat) * Math.PI / 180;
  
  let angle = Math.atan2(dLng, dLat);
  
  // Normalize to [0, 2π]
  if (angle < 0) {
    angle += 2 * Math.PI;
  }
  
  return angle;
}

function optimizeLinearOrderStrict(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[] {
  if (customers.length <= 2) return customers;
  
  // Use nearest neighbor starting from distributor
  const optimized: ClusteredCustomer[] = [];
  const remaining = [...customers];
  
  let currentLat = distributor.latitude;
  let currentLng = distributor.longitude;
  
  while (remaining.length > 0) {
    let nearestIndex = -1;
    let shortestDistance = Infinity;
    
    // Find the nearest customer
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
    
    const nearestCustomer = remaining.splice(nearestIndex, 1)[0];
    optimized.push(nearestCustomer);
    
    currentLat = nearestCustomer.latitude;
    currentLng = nearestCustomer.longitude;
  }
  
  return optimized;
}

function calculateProximityEnergyWithWithinBeatMedianConstraint(solution: SalesmanRoute[], config: ClusteringConfig): number {
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
  
  // Linearity penalty - penalize routes that have many direction changes
  solution.forEach(route => {
    if (route.stops.length >= 3) {
      const linearityPenalty = calculateLinearityPenalty(route);
      totalEnergy += LINEARITY_WEIGHT * linearityPenalty;
    }
  });
  
  // Within-beat median distance constraint penalty
  solution.forEach(route => {
    const withinBeatMedianDistancePenalty = calculateWithinBeatMedianDistancePenalty(route);
    totalEnergy += WITHIN_BEAT_MEDIAN_DISTANCE_WEIGHT * withinBeatMedianDistancePenalty;
  });
  
  return totalEnergy;
}

function calculateWithinBeatMedianDistancePenalty(route: SalesmanRoute): number {
  if (route.stops.length < 3) return 0; // No penalty for small beats
  
  // Calculate the median distance within this beat
  const medianDistance = calculateMedianDistanceWithinBeat(route.stops);
  
  if (medianDistance === Infinity || medianDistance > 50) return 0; // Skip unreasonable constraints
  
  let penalty = 0;
  
  // Count violations of the within-beat median distance constraint
  for (let i = 0; i < route.stops.length; i++) {
    for (let j = i + 1; j < route.stops.length; j++) {
      const distance = calculateHaversineDistance(
        route.stops[i].latitude, route.stops[i].longitude,
        route.stops[j].latitude, route.stops[j].longitude
      );
      
      if (distance > medianDistance) {
        penalty += (distance - medianDistance) * 1000; // Heavy penalty for violations
      }
    }
  }
  
  return penalty;
}

function calculateLinearityPenalty(route: SalesmanRoute): number {
  if (route.stops.length < 3) return 0;
  
  let penalty = 0;
  let prevLat = route.distributorLat;
  let prevLng = route.distributorLng;
  
  for (let i = 1; i < route.stops.length - 1; i++) {
    const prev = { lat: prevLat, lng: prevLng };
    const current = { lat: route.stops[i].latitude, lng: route.stops[i].longitude };
    const next = { lat: route.stops[i + 1].latitude, lng: route.stops[i + 1].longitude };
    
    // Calculate the angle change at this point
    const angle1 = Math.atan2(current.lat - prev.lat, current.lng - prev.lng);
    const angle2 = Math.atan2(next.lat - current.lat, next.lng - current.lng);
    
    let angleDiff = Math.abs(angle2 - angle1);
    if (angleDiff > Math.PI) {
      angleDiff = 2 * Math.PI - angleDiff;
    }
    
    // Penalize sharp turns (angles close to π indicate backtracking)
    penalty += angleDiff * 100;
    
    prevLat = current.lat;
    prevLng = current.lng;
  }
  
  return penalty;
}

function createStrictProximityNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Only allow operations that maintain strict assignment
  const operations = [
    () => swapAdjacentStopsStrict(newSolution, config),
    () => reverseSegmentForLinearityStrict(newSolution, config),
    () => optimizeRouteOrderStrict(newSolution, config)
  ];
  
  const numOperations = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapAdjacentStopsStrict(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  // Only swap adjacent stops to maintain linearity
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  updateRouteMetrics(route, config);
}

function reverseSegmentForLinearityStrict(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2 + Math.floor(Math.random() * Math.min(4, route.stops.length - start - 1));
  
  const segment = route.stops.slice(start, start + length);
  segment.reverse();
  route.stops.splice(start, length, ...segment);
  
  updateRouteMetrics(route, config);
}

function optimizeRouteOrderStrict(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 4) return;
  
  // Apply simple 2-opt improvement
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
        // Apply 2-opt swap
        const newStops = [
          ...route.stops.slice(0, i),
          ...route.stops.slice(i, j).reverse(),
          ...route.stops.slice(j)
        ];
        route.stops = newStops;
        updateRouteMetrics(route, config);
        return; // Only one improvement per call
      }
    }
  }
}

async function optimizeAcrossClustersWithStrictTracking(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  // For strict tracking, we only optimize within routes, not across routes
  // This prevents any customer reassignment that could cause duplicates
  
  routes.forEach(route => {
    if (route.stops.length >= 4) {
      optimizeRouteOrderStrict([route], config);
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