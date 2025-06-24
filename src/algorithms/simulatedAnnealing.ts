import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Enhanced annealing parameters for strict constraint enforcement
const INITIAL_TEMPERATURE = 1000;
const COOLING_RATE = 0.98;
const MIN_TEMPERATURE = 0.01;
const ITERATIONS_PER_TEMP = 100;
const CONSTRAINT_VIOLATION_WEIGHT = 1000; // Heavy penalty for constraint violations
const MEDIAN_DISTANCE_WEIGHT = 500; // Weight for median distance constraint violations

// Batch processing size
const BATCH_SIZE = 20;

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting constraint-enforced simulated annealing with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`Beat constraints: ${config.minOutletsPerBeat}-${config.maxOutletsPerBeat} outlets per beat`);
  
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
  
  // Process each cluster independently with strict constraint enforcement
  const clusterResults: SalesmanRoute[][] = await Promise.all(
    Object.entries(customersByCluster).map(async ([clusterId, clusterCustomers]) => {
      const clusterAssignedIds = new Set<string>();
      const routes = await processClusterWithStrictConstraints(
        Number(clusterId),
        clusterCustomers,
        distributor,
        config,
        clusterAssignedIds
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = routes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterCustomers.length} customers assigned in ${routes.length} beats`);
      
      if (assignedInCluster !== clusterCustomers.length) {
        console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterCustomers.length} customers, got ${assignedInCluster}`);
        
        // Find and assign missing customers
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers while respecting constraints
        missingCustomers.forEach(customer => {
          const targetRoute = routes.find(r => r.stops.length < config.maxOutletsPerBeat);
          
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
          } else {
            // Create emergency route if all routes are at max capacity
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
              clusterIds: [Number(clusterId)],
              distributorLat: distributor.latitude,
              distributorLng: distributor.longitude
            };
            routes.push(emergencyRoute);
            clusterAssignedIds.add(customer.id);
            console.log(`Created emergency route ${emergencyRoute.salesmanId} for customer ${customer.id}`);
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
  
  // Apply constraint enforcement to all routes
  routes = enforceAllConstraintsStrict(routes, distributor, config);
  
  // FINAL verification
  const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`SIMULATED ANNEALING VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  console.log(`- Total beats created: ${routes.length}`);
  
  // Report constraint adherence
  const constraintReport = analyzeConstraintAdherenceStrict(routes, config);
  console.log('Constraint adherence report:', constraintReport);
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`SIMULATED ANNEALING ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Constraint-Enforced Simulated Annealing (${config.totalClusters} Clusters, ${routes.length} Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
};

async function processClusterWithStrictConstraints(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with strict constraint enforcement for ${customers.length} customers`);
  
  // Create multiple initial solutions with strict constraints and select the best
  const numInitialSolutions = 5;
  let bestSolution = null;
  let bestEnergy = Infinity;
  
  for (let i = 0; i < numInitialSolutions; i++) {
    const solution = createStrictConstraintInitialSolution(clusterId, customers, distributor, config, new Set(assignedIds));
    const energy = calculateConstraintEnforcedEnergy(solution, config);
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
        const neighborSolution = createConstraintRespectingNeighborSolution(currentSolution, config);
        const neighborEnergy = calculateConstraintEnforcedEnergy(neighborSolution, config);
        
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

function createStrictConstraintInitialSolution(
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
  
  // Calculate optimal number of beats for this cluster
  const optimalBeats = Math.max(
    1,
    Math.min(
      config.beatsPerCluster,
      Math.ceil(remainingCustomers.length / config.maxOutletsPerBeat)
    )
  );
  
  console.log(`Cluster ${clusterId}: Creating ${optimalBeats} beats for ${remainingCustomers.length} customers`);
  
  // Create beats with strict size constraints
  for (let beatIndex = 0; beatIndex < optimalBeats && remainingCustomers.length > 0; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Calculate target size for this beat with strict constraints
    const remainingBeats = optimalBeats - beatIndex;
    const remainingCustomersCount = remainingCustomers.length;
    
    let targetSize = Math.ceil(remainingCustomersCount / remainingBeats);
    
    // Enforce minimum constraint
    targetSize = Math.max(targetSize, config.minOutletsPerBeat);
    
    // Enforce maximum constraint
    targetSize = Math.min(targetSize, config.maxOutletsPerBeat);
    
    // Ensure we don't exceed remaining customers
    targetSize = Math.min(targetSize, remainingCustomersCount);
    
    console.log(`Beat ${route.salesmanId}: targeting ${targetSize} outlets (${remainingCustomersCount} remaining, ${remainingBeats} beats left)`);
    
    // Select customers for this beat using constraint-aware selection
    const beatCustomers = selectCustomersWithStrictConstraints(
      remainingCustomers,
      distributor,
      targetSize,
      config
    );
    
    // Remove selected customers from remaining pool
    beatCustomers.forEach(customer => {
      const index = remainingCustomers.findIndex(c => c.id === customer.id);
      if (index !== -1) {
        remainingCustomers.splice(index, 1);
        assignedIds.add(customer.id);
      }
    });
    
    // Add customers to route in optimized order
    const optimizedOrder = optimizeCustomerOrderWithConstraints(beatCustomers, distributor, config);
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
    });
    
    if (route.stops.length > 0) {
      updateRouteMetricsStrict(route, config);
      routes.push(route);
    }
  }
  
  // CRITICAL: Handle any remaining unassigned customers
  if (remainingCustomers.length > 0) {
    console.log(`Cluster ${clusterId}: ${remainingCustomers.length} customers remaining after initial beat creation`);
    
    // Assign remaining customers to existing routes or create new ones
    remainingCustomers.forEach(customer => {
      // Try to find an existing route with space that won't violate constraints
      let bestRoute = null;
      let minConstraintViolation = Infinity;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat) {
          const violation = calculateConstraintViolationForAdditionStrict(route, customer, config);
          if (violation < minConstraintViolation) {
            minConstraintViolation = violation;
            bestRoute = route;
          }
        }
      }
      
      if (bestRoute) {
        // Add customer to the best route
        bestRoute.stops.push({
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
        updateRouteMetricsStrict(bestRoute, config);
      } else {
        // Create new route if no existing route can accommodate
        const newRoute: SalesmanRoute = {
          salesmanId: salesmanId++,
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
          clusterIds: [clusterId],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        
        routes.push(newRoute);
        assignedIds.add(customer.id);
        updateRouteMetricsStrict(newRoute, config);
      }
    });
    
    console.log(`Cluster ${clusterId}: All remaining customers assigned. Total routes: ${routes.length}`);
  }
  
  return routes;
}

function selectCustomersWithStrictConstraints(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  targetSize: number,
  config: ClusteringConfig
): ClusteredCustomer[] {
  if (customers.length === 0 || targetSize === 0) return [];
  
  const selected: ClusteredCustomer[] = [];
  const remaining = [...customers];
  
  // Start from the customer closest to distributor
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
  selected.push(firstCustomer);
  currentLat = firstCustomer.latitude;
  currentLng = firstCustomer.longitude;
  
  // Select remaining customers with strict constraint enforcement
  while (selected.length < targetSize && remaining.length > 0) {
    let bestCustomer = null;
    let bestIndex = -1;
    let minConstraintViolation = Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      
      // Calculate constraint violation if we add this customer
      const tempSelected = [...selected, candidate];
      const medianDistance = calculateMedianDistanceWithinGroupStrict(tempSelected);
      
      let violation = 0;
      
      // Check median distance constraint violations
      if (medianDistance < 50 && medianDistance > 0) { // Only apply if reasonable
        for (const existingCustomer of selected) {
          const distance = calculateHaversineDistance(
            existingCustomer.latitude, existingCustomer.longitude,
            candidate.latitude, candidate.longitude
          );
          
          if (distance > medianDistance) {
            violation += (distance - medianDistance) * 10;
          }
        }
      }
      
      // Add proximity bonus (prefer closer customers)
      const proximityDistance = calculateHaversineDistance(
        currentLat, currentLng,
        candidate.latitude, candidate.longitude
      );
      
      const totalScore = violation + (proximityDistance * 0.1);
      
      if (totalScore < minConstraintViolation) {
        minConstraintViolation = totalScore;
        bestCustomer = candidate;
        bestIndex = i;
      }
    }
    
    if (bestCustomer && bestIndex !== -1) {
      remaining.splice(bestIndex, 1);
      selected.push(bestCustomer);
      currentLat = bestCustomer.latitude;
      currentLng = bestCustomer.longitude;
    } else {
      // If no good candidate found, take the nearest one
      nearestIndex = 0;
      shortestDistance = Infinity;
      
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
      selected.push(nearestCustomer);
      currentLat = nearestCustomer.latitude;
      currentLng = nearestCustomer.longitude;
    }
  }
  
  return selected;
}

function calculateMedianDistanceWithinGroupStrict(customers: ClusteredCustomer[]): number {
  if (customers.length < 2) return Infinity;
  
  const distances: number[] = [];
  
  for (let i = 0; i < customers.length; i++) {
    for (let j = i + 1; j < customers.length; j++) {
      const distance = calculateHaversineDistance(
        customers[i].latitude, customers[i].longitude,
        customers[j].latitude, customers[j].longitude
      );
      distances.push(distance);
    }
  }
  
  if (distances.length === 0) return Infinity;
  
  distances.sort((a, b) => a - b);
  const midIndex = Math.floor(distances.length / 2);
  
  if (distances.length % 2 === 0) {
    return (distances[midIndex - 1] + distances[midIndex]) / 2;
  } else {
    return distances[midIndex];
  }
}

function optimizeCustomerOrderWithConstraints(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): ClusteredCustomer[] {
  if (customers.length <= 2) return customers;
  
  // Use nearest neighbor with constraint awareness
  const optimized: ClusteredCustomer[] = [];
  const remaining = [...customers];
  
  let currentLat = distributor.latitude;
  let currentLng = distributor.longitude;
  
  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = Infinity;
    
    // Find the best customer considering both distance and constraints
    for (let i = 0; i < remaining.length; i++) {
      const distance = calculateHaversineDistance(
        currentLat, currentLng,
        remaining[i].latitude, remaining[i].longitude
      );
      
      // Calculate constraint violation if we add this customer next
      const tempOptimized = [...optimized, remaining[i]];
      const constraintViolation = calculateMedianDistanceViolationsForGroup(tempOptimized);
      
      const score = distance + (constraintViolation * 10);
      
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    
    const bestCustomer = remaining.splice(bestIndex, 1)[0];
    optimized.push(bestCustomer);
    
    currentLat = bestCustomer.latitude;
    currentLng = bestCustomer.longitude;
  }
  
  return optimized;
}

function calculateMedianDistanceViolationsForGroup(customers: ClusteredCustomer[]): number {
  if (customers.length < 3) return 0;
  
  const medianDistance = calculateMedianDistanceWithinGroupStrict(customers);
  
  if (medianDistance === Infinity || medianDistance > 50) return 0;
  
  let violations = 0;
  
  for (let i = 0; i < customers.length; i++) {
    for (let j = i + 1; j < customers.length; j++) {
      const distance = calculateHaversineDistance(
        customers[i].latitude, customers[i].longitude,
        customers[j].latitude, customers[j].longitude
      );
      
      if (distance > medianDistance) {
        violations += (distance - medianDistance);
      }
    }
  }
  
  return violations;
}

function calculateConstraintViolationForAdditionStrict(
  route: SalesmanRoute,
  customer: ClusteredCustomer,
  config: ClusteringConfig
): number {
  let violation = 0;
  
  // Size constraint violation
  if (route.stops.length >= config.maxOutletsPerBeat) {
    violation += 10000; // Very heavy penalty for exceeding max size
  }
  
  // Median distance constraint violation
  const allCustomers = route.stops.map(stop => ({
    latitude: stop.latitude,
    longitude: stop.longitude
  })).concat([{ latitude: customer.latitude, longitude: customer.longitude }]);
  
  if (allCustomers.length >= 2) {
    const medianDistance = calculateMedianDistanceWithinGroupStrict(allCustomers as ClusteredCustomer[]);
    
    if (medianDistance < 50 && medianDistance > 0) { // Only apply if reasonable
      for (const stop of route.stops) {
        const distance = calculateHaversineDistance(
          stop.latitude, stop.longitude,
          customer.latitude, customer.longitude
        );
        
        if (distance > medianDistance) {
          violation += (distance - medianDistance) * 100;
        }
      }
    }
  }
  
  return violation;
}

function calculateConstraintEnforcedEnergy(solution: SalesmanRoute[], config: ClusteringConfig): number {
  let totalEnergy = 0;
  
  // Base distance energy
  totalEnergy += solution.reduce((sum, route) => sum + route.totalDistance, 0);
  
  // Heavy penalties for constraint violations
  solution.forEach(route => {
    // Size constraint violations
    if (route.stops.length < config.minOutletsPerBeat) {
      totalEnergy += CONSTRAINT_VIOLATION_WEIGHT * (config.minOutletsPerBeat - route.stops.length);
    }
    if (route.stops.length > config.maxOutletsPerBeat) {
      totalEnergy += CONSTRAINT_VIOLATION_WEIGHT * (route.stops.length - config.maxOutletsPerBeat);
    }
    
    // Median distance constraint violations
    const medianDistancePenalty = calculateMedianDistanceViolationsForRoute(route);
    totalEnergy += MEDIAN_DISTANCE_WEIGHT * medianDistancePenalty;
  });
  
  return totalEnergy;
}

function calculateMedianDistanceViolationsForRoute(route: SalesmanRoute): number {
  if (route.stops.length < 3) return 0;
  
  const medianDistance = calculateMedianDistanceWithinBeatStrict(route.stops);
  
  if (medianDistance === Infinity || medianDistance > 50) return 0;
  
  let violations = 0;
  
  for (let i = 0; i < route.stops.length; i++) {
    for (let j = i + 1; j < route.stops.length; j++) {
      const distance = calculateHaversineDistance(
        route.stops[i].latitude, route.stops[i].longitude,
        route.stops[j].latitude, route.stops[j].longitude
      );
      
      if (distance > medianDistance) {
        violations += (distance - medianDistance);
      }
    }
  }
  
  return violations;
}

function calculateMedianDistanceWithinBeatStrict(stops: RouteStop[]): number {
  if (stops.length < 2) return Infinity;
  
  const distances: number[] = [];
  
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
  
  distances.sort((a, b) => a - b);
  const midIndex = Math.floor(distances.length / 2);
  
  if (distances.length % 2 === 0) {
    return (distances[midIndex - 1] + distances[midIndex]) / 2;
  } else {
    return distances[midIndex];
  }
}

function createConstraintRespectingNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Only allow operations that maintain strict constraints
  const operations = [
    () => swapAdjacentStopsWithConstraints(newSolution, config),
    () => reverseSegmentWithConstraints(newSolution, config),
    () => optimizeRouteOrderWithConstraintsStrict(newSolution, config)
  ];
  
  const numOperations = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapAdjacentStopsWithConstraints(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  // Only swap adjacent stops to maintain constraint adherence
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  
  // Check if swap would violate constraints
  const originalViolations = calculateMedianDistanceViolationsForRoute(route);
  
  // Temporarily swap
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  
  const newViolations = calculateMedianDistanceViolationsForRoute(route);
  
  // Only keep swap if it doesn't increase violations
  if (newViolations > originalViolations) {
    // Revert swap
    [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  } else {
    updateRouteMetricsStrict(route, config);
  }
}

function reverseSegmentWithConstraints(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2 + Math.floor(Math.random() * Math.min(4, route.stops.length - start - 1));
  
  // Check if reversal would violate constraints
  const originalViolations = calculateMedianDistanceViolationsForRoute(route);
  
  // Temporarily reverse
  const segment = route.stops.slice(start, start + length);
  segment.reverse();
  const originalSegment = route.stops.slice(start, start + length);
  route.stops.splice(start, length, ...segment);
  
  const newViolations = calculateMedianDistanceViolationsForRoute(route);
  
  // Only keep reversal if it doesn't increase violations
  if (newViolations > originalViolations) {
    // Revert reversal
    route.stops.splice(start, length, ...originalSegment);
  } else {
    updateRouteMetricsStrict(route, config);
  }
}

function optimizeRouteOrderWithConstraintsStrict(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 4) return;
  
  // Apply 2-opt improvement that respects constraints
  const originalViolations = calculateMedianDistanceViolationsForRoute(route);
  const originalDistance = route.totalDistance;
  
  for (let i = 1; i < route.stops.length - 2; i++) {
    for (let j = i + 2; j < route.stops.length; j++) {
      // Try 2-opt swap
      const newStops = [
        ...route.stops.slice(0, i),
        ...route.stops.slice(i, j).reverse(),
        ...route.stops.slice(j)
      ];
      
      const originalStops = [...route.stops];
      route.stops = newStops;
      
      const newViolations = calculateMedianDistanceViolationsForRoute(route);
      updateRouteMetricsStrict(route, config);
      const newDistance = route.totalDistance;
      
      // Only keep improvement if it doesn't increase constraint violations
      if (newViolations > originalViolations || 
          (newViolations === originalViolations && newDistance >= originalDistance)) {
        // Revert change
        route.stops = originalStops;
        updateRouteMetricsStrict(route, config);
      } else {
        return; // Keep the improvement and exit
      }
    }
  }
}

function enforceAllConstraintsStrict(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): SalesmanRoute[] {
  console.log('Enforcing all constraints strictly on routes...');
  
  let constraintEnforcedRoutes = [...routes];
  
  // Step 1: Handle undersized routes
  const undersizedRoutes = constraintEnforcedRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
  const normalRoutes = constraintEnforcedRoutes.filter(route => 
    route.stops.length >= config.minOutletsPerBeat && route.stops.length <= config.maxOutletsPerBeat
  );
  const oversizedRoutes = constraintEnforcedRoutes.filter(route => route.stops.length > config.maxOutletsPerBeat);
  
  console.log(`Found ${undersizedRoutes.length} undersized routes (< ${config.minOutletsPerBeat} outlets)`);
  console.log(`Found ${oversizedRoutes.length} oversized routes (> ${config.maxOutletsPerBeat} outlets)`);
  
  // Try to merge undersized routes
  undersizedRoutes.forEach(undersizedRoute => {
    // Find a route in the same cluster that can accommodate the merge
    const sameClusterRoute = normalRoutes.find(route => 
      route.clusterIds[0] === undersizedRoute.clusterIds[0] &&
      route.stops.length + undersizedRoute.stops.length <= config.maxOutletsPerBeat
    );
    
    if (sameClusterRoute) {
      // Merge the undersized route into the same cluster route
      sameClusterRoute.stops.push(...undersizedRoute.stops);
      updateRouteMetricsStrict(sameClusterRoute, config);
      console.log(`Merged undersized route ${undersizedRoute.salesmanId} into route ${sameClusterRoute.salesmanId}`);
    } else {
      // If can't merge, keep the undersized route but mark it
      normalRoutes.push(undersizedRoute);
      console.log(`Keeping undersized route ${undersizedRoute.salesmanId} (no suitable merge target found)`);
    }
  });
  
  // Handle oversized routes by splitting them
  oversizedRoutes.forEach(oversizedRoute => {
    // Split the oversized route
    const midPoint = Math.ceil(oversizedRoute.stops.length / 2);
    
    const route1: SalesmanRoute = {
      ...oversizedRoute,
      stops: oversizedRoute.stops.slice(0, midPoint),
      totalDistance: 0,
      totalTime: 0
    };
    
    const route2: SalesmanRoute = {
      ...oversizedRoute,
      salesmanId: oversizedRoute.salesmanId + 1000, // Temporary ID
      stops: oversizedRoute.stops.slice(midPoint),
      totalDistance: 0,
      totalTime: 0
    };
    
    updateRouteMetricsStrict(route1, config);
    updateRouteMetricsStrict(route2, config);
    
    normalRoutes.push(route1);
    if (route2.stops.length > 0) {
      normalRoutes.push(route2);
    }
    
    console.log(`Split oversized route ${oversizedRoute.salesmanId} into routes ${route1.salesmanId} and ${route2.salesmanId}`);
  });
  
  constraintEnforcedRoutes = normalRoutes;
  
  // Step 2: Apply median distance constraint optimization to all routes
  constraintEnforcedRoutes.forEach(route => {
    if (route.stops.length > 2) {
      optimizeRouteForMedianDistanceConstraintStrict(route, config);
      updateRouteMetricsStrict(route, config);
    }
  });
  
  return constraintEnforcedRoutes;
}

function optimizeRouteForMedianDistanceConstraintStrict(route: SalesmanRoute, config: ClusteringConfig): void {
  if (route.stops.length < 4) return;
  
  let improved = true;
  let iterations = 0;
  const maxIterations = 20;
  
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    
    const originalViolations = calculateMedianDistanceViolationsForRoute(route);
    
    // Try 2-opt improvements that reduce constraint violations
    for (let i = 1; i < route.stops.length - 2; i++) {
      for (let j = i + 2; j < route.stops.length; j++) {
        // Create new route order with 2-opt swap
        const newStops = [
          ...route.stops.slice(0, i),
          ...route.stops.slice(i, j).reverse(),
          ...route.stops.slice(j)
        ];
        
        const originalStops = [...route.stops];
        route.stops = newStops;
        
        const newViolations = calculateMedianDistanceViolationsForRoute(route);
        
        // If new order has fewer violations, keep it
        if (newViolations < originalViolations) {
          improved = true;
          break;
        } else {
          // Revert change
          route.stops = originalStops;
        }
      }
      if (improved) break;
    }
  }
}

function analyzeConstraintAdherenceStrict(routes: SalesmanRoute[], config: ClusteringConfig): any {
  const report = {
    totalRoutes: routes.length,
    undersizedRoutes: 0,
    oversizedRoutes: 0,
    properSizedRoutes: 0,
    medianDistanceViolations: 0,
    averageOutletsPerRoute: 0,
    routeSizeDistribution: {} as Record<number, number>,
    totalConstraintViolations: 0
  };
  
  let totalOutlets = 0;
  
  routes.forEach(route => {
    const size = route.stops.length;
    totalOutlets += size;
    
    // Count size violations
    if (size < config.minOutletsPerBeat) {
      report.undersizedRoutes++;
      report.totalConstraintViolations += (config.minOutletsPerBeat - size);
    } else if (size > config.maxOutletsPerBeat) {
      report.oversizedRoutes++;
      report.totalConstraintViolations += (size - config.maxOutletsPerBeat);
    } else {
      report.properSizedRoutes++;
    }
    
    // Track size distribution
    report.routeSizeDistribution[size] = (report.routeSizeDistribution[size] || 0) + 1;
    
    // Count median distance violations
    const violations = calculateMedianDistanceViolationsForRoute(route);
    if (violations > 0) {
      report.medianDistanceViolations++;
    }
  });
  
  report.averageOutletsPerRoute = totalOutlets / routes.length;
  
  return report;
}

function updateRouteMetricsStrict(route: SalesmanRoute, config: ClusteringConfig): void {
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