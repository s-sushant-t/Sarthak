import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

// Enhanced annealing parameters for proximity optimization
const INITIAL_TEMPERATURE = 1000;
const COOLING_RATE = 0.98;
const MIN_TEMPERATURE = 0.01;
const ITERATIONS_PER_TEMP = 100;
const MAX_DISTANCE_VARIANCE = 5;
const LINEARITY_WEIGHT = 0.3; // Weight for linearity in energy calculation

// Batch processing size
const BATCH_SIZE = 20;

export const simulatedAnnealing = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-optimized simulated annealing with ${customers.length} total customers`);
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
  
  // Process each cluster independently with proximity optimization
  const clusterResults: SalesmanRoute[][] = await Promise.all(
    Object.entries(customersByCluster).map(async ([clusterId, clusterCustomers]) => {
      const routes = await processClusterWithProximity(
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
          
          // Find best insertion point to maintain linearity
          const bestInsertionPoint = findBestLinearInsertionPoint(route, customer, distributor);
          
          route.stops.splice(bestInsertionPoint, 0, {
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
  
  routes = await optimizeAcrossClustersWithProximity(routes, distributor, config);
  
  // Final verification
  const finalCustomerCount = routes.reduce((count, route) => count + route.stops.length, 0);
  console.log(`Simulated annealing verification: ${finalCustomerCount}/${allCustomers.length} customers in final routes`);
  
  if (finalCustomerCount !== allCustomers.length) {
    console.error(`SIMULATED ANNEALING ERROR: Lost ${allCustomers.length - finalCustomerCount} customers!`);
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

async function processClusterWithProximity(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  console.log(`Processing cluster ${clusterId} with proximity optimization for ${customers.length} customers`);
  
  // Create multiple initial solutions with different approaches and select the best
  const numInitialSolutions = 5;
  let bestSolution = null;
  let bestEnergy = Infinity;
  
  for (let i = 0; i < numInitialSolutions; i++) {
    const solution = createLinearInitialSolution(clusterId, customers, distributor, config);
    const energy = calculateProximityEnergy(solution, config);
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
        const neighborSolution = createProximityNeighborSolution(currentSolution, config);
        const neighborEnergy = calculateProximityEnergy(neighborSolution, config);
        
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

function createLinearInitialSolution(
  clusterId: number, 
  customers: ClusteredCustomer[], 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Sort customers by angle from distributor to create directional sweeps
  const customersWithAngles = customers.map(customer => ({
    ...customer,
    angle: calculateAngle(distributor.latitude, distributor.longitude, customer.latitude, customer.longitude)
  }));
  
  customersWithAngles.sort((a, b) => a.angle - b.angle);
  
  const targetBeats = config.beatsPerCluster;
  const customersPerBeat = Math.ceil(customers.length / targetBeats);
  
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
    
    // Take customers in angular order for this beat
    const remainingCustomers = customersWithAngles.length;
    const remainingBeats = targetBeats - beatIndex;
    const customersForThisBeat = Math.min(
      Math.ceil(remainingCustomers / remainingBeats),
      config.maxOutletsPerBeat
    );
    
    const beatCustomers = customersWithAngles.splice(0, customersForThisBeat);
    
    // Optimize order within this directional sweep
    const optimizedOrder = optimizeLinearOrder(beatCustomers, distributor);
    
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
      updateRouteMetrics(route, config);
      routes.push(route);
    }
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

function optimizeLinearOrder(
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
    
    const nearestCustomer = remaining.splice(nearestIndex, 1)[0];
    optimized.push(nearestCustomer);
    
    currentLat = nearestCustomer.latitude;
    currentLng = nearestCustomer.longitude;
  }
  
  return optimized;
}

function calculateProximityEnergy(solution: SalesmanRoute[], config: ClusteringConfig): number {
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
  
  return totalEnergy;
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

function createProximityNeighborSolution(solution: SalesmanRoute[], config: ClusteringConfig): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  const operations = [
    () => swapAdjacentStops(newSolution, config),
    () => relocateToNearestPosition(newSolution, config),
    () => reverseSegmentForLinearity(newSolution, config),
    () => optimizeRouteOrder(newSolution, config)
  ];
  
  const numOperations = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapAdjacentStops(solution: SalesmanRoute[], config: ClusteringConfig): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 2) return;
  
  // Only swap adjacent stops to maintain some linearity
  const i = Math.floor(Math.random() * (route.stops.length - 1));
  [route.stops[i], route.stops[i + 1]] = [route.stops[i + 1], route.stops[i]];
  
  updateRouteMetrics(route, config);
}

function relocateToNearestPosition(solution: SalesmanRoute[], config: ClusteringConfig): void {
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
  
  // Find the best position to maintain linearity
  const bestPos = findBestLinearInsertionPoint(toRoute, customer, { latitude: toRoute.distributorLat, longitude: toRoute.distributorLng });
  
  toRoute.stops.splice(bestPos, 0, customer);
  updateRouteMetrics(fromRoute, config);
  updateRouteMetrics(toRoute, config);
}

function findBestLinearInsertionPoint(
  route: SalesmanRoute,
  customer: { latitude: number; longitude: number },
  distributor: { latitude: number; longitude: number }
): number {
  if (route.stops.length === 0) return 0;
  
  let bestPosition = route.stops.length;
  let minIncrease = Infinity;
  
  for (let i = 0; i <= route.stops.length; i++) {
    let increase = 0;
    
    if (i === 0) {
      const distToCustomer = calculateHaversineDistance(
        distributor.latitude, distributor.longitude,
        customer.latitude, customer.longitude
      );
      const distFromCustomer = route.stops.length > 0 ? 
        calculateHaversineDistance(
          customer.latitude, customer.longitude,
          route.stops[0].latitude, route.stops[0].longitude
        ) : 0;
      const originalDist = route.stops.length > 0 ?
        calculateHaversineDistance(
          distributor.latitude, distributor.longitude,
          route.stops[0].latitude, route.stops[0].longitude
        ) : 0;
      
      increase = distToCustomer + distFromCustomer - originalDist;
    } else if (i === route.stops.length) {
      const lastStop = route.stops[route.stops.length - 1];
      increase = calculateHaversineDistance(
        lastStop.latitude, lastStop.longitude,
        customer.latitude, customer.longitude
      );
    } else {
      const prevStop = route.stops[i - 1];
      const nextStop = route.stops[i];
      
      const distToPrev = calculateHaversineDistance(
        prevStop.latitude, prevStop.longitude,
        customer.latitude, customer.longitude
      );
      const distToNext = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        nextStop.latitude, nextStop.longitude
      );
      const originalDist = calculateHaversineDistance(
        prevStop.latitude, prevStop.longitude,
        nextStop.latitude, nextStop.longitude
      );
      
      increase = distToPrev + distToNext - originalDist;
    }
    
    if (increase < minIncrease) {
      minIncrease = increase;
      bestPosition = i;
    }
  }
  
  return bestPosition;
}

function reverseSegmentForLinearity(solution: SalesmanRoute[], config: ClusteringConfig): void {
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

function optimizeRouteOrder(solution: SalesmanRoute[], config: ClusteringConfig): void {
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

async function optimizeAcrossClustersWithProximity(
  routes: SalesmanRoute[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  let currentSolution = [...routes];
  let bestSolution = [...routes];
  let currentEnergy = calculateProximityEnergy(currentSolution, config);
  let bestEnergy = currentEnergy;
  
  let temperature = INITIAL_TEMPERATURE * 0.5;
  
  while (temperature > MIN_TEMPERATURE) {
    for (let i = 0; i < ITERATIONS_PER_TEMP / 2; i++) {
      const neighborSolution = createProximityNeighborSolution(currentSolution, config);
      const neighborEnergy = calculateProximityEnergy(neighborSolution, config);
      
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