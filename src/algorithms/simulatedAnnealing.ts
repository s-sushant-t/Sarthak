import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 30;
const MAX_OUTLETS_PER_BEAT = 45;
const CUSTOMER_VISIT_TIME = 6;
const MAX_WORKING_TIME = 360;
const TRAVEL_SPEED = 30;

// Optimized parameters for faster convergence
const INITIAL_TEMPERATURE = 100;
const COOLING_RATE = 0.95;
const MIN_TEMPERATURE = 1;
const ITERATIONS_PER_TEMP = 50;
const MAX_DISTANCE_VARIANCE = 5;

// Batch processing size
const BATCH_SIZE = 10;

export const simulatedAnnealing = async (locationData: LocationData): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  // Group customers by cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  // Process each cluster independently
  const clusterResults: SalesmanRoute[][] = await Promise.all(
    Object.entries(customersByCluster).map(async ([clusterId, clusterCustomers]) => {
      return processCluster(
        Number(clusterId),
        clusterCustomers,
        distributor
      );
    })
  );
  
  // Combine results from all clusters
  const routes = clusterResults.flat();
  
  // Optimize and balance the final routes
  const optimizedRoutes = optimizeBeats(routes, distributor);
  
  // Calculate total distance
  const totalDistance = optimizedRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: 'Simulated Annealing (Optimized)',
    totalDistance,
    totalSalesmen: optimizedRoutes.length,
    processingTime: 0,
    routes: optimizedRoutes
  };
};

async function processCluster(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number }
): Promise<SalesmanRoute[]> {
  let currentSolution = createInitialSolution(clusterId, customers, distributor);
  let bestSolution = JSON.parse(JSON.stringify(currentSolution));
  
  let currentEnergy = calculateEnergy(currentSolution);
  let bestEnergy = currentEnergy;
  
  let temperature = INITIAL_TEMPERATURE;
  let iteration = 0;
  
  while (temperature > MIN_TEMPERATURE) {
    // Process in batches to allow yielding
    for (let batch = 0; batch < ITERATIONS_PER_TEMP; batch += BATCH_SIZE) {
      const batchSize = Math.min(BATCH_SIZE, ITERATIONS_PER_TEMP - batch);
      
      for (let i = 0; i < batchSize; i++) {
        const neighborSolution = createNeighborSolution(currentSolution);
        const neighborEnergy = calculateEnergy(neighborSolution);
        
        const acceptanceProbability = Math.exp(-(neighborEnergy - currentEnergy) / temperature);
        
        if (Math.random() < acceptanceProbability) {
          currentSolution = neighborSolution;
          currentEnergy = neighborEnergy;
          
          if (currentEnergy < bestEnergy) {
            bestSolution = JSON.parse(JSON.stringify(currentSolution));
            bestEnergy = currentEnergy;
          }
        }
        
        iteration++;
      }
      
      // Yield to main thread after each batch
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    temperature *= COOLING_RATE;
  }
  
  return bestSolution;
}

function createInitialSolution(
  clusterId: number,
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number }
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
      Math.floor(Math.random() * (MAX_OUTLETS_PER_BEAT - MIN_OUTLETS_PER_BEAT + 1)) + MIN_OUTLETS_PER_BEAT,
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
        visitTime: CUSTOMER_VISIT_TIME,
        clusterId: customer.clusterId,
        outletName: customer.outletName
      });
    }
    
    if (route.stops.length > 0) {
      updateRouteMetrics(route);
      routes.push(route);
    }
  }
  
  return routes;
}

function createNeighborSolution(solution: SalesmanRoute[]): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  const operations = [
    () => swapWithinRoute(newSolution),
    () => swapBetweenRoutes(newSolution),
    () => reverseSegment(newSolution),
    () => relocateCustomer(newSolution)
  ];
  
  const numOperations = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < numOperations; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    operation();
  }
  
  return newSolution;
}

function swapWithinRoute(solution: SalesmanRoute[]): void {
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
  updateRouteMetrics(route);
}

function swapBetweenRoutes(solution: SalesmanRoute[]): void {
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
    
    updateRouteMetrics(route1);
    updateRouteMetrics(route2);
  }
}

function reverseSegment(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length < 3) return;
  
  const start = Math.floor(Math.random() * (route.stops.length - 2));
  const length = 2 + Math.floor(Math.random() * (route.stops.length - start - 1));
  
  const segment = route.stops.slice(start, start + length);
  segment.reverse();
  route.stops.splice(start, length, ...segment);
  
  updateRouteMetrics(route);
}

function relocateCustomer(solution: SalesmanRoute[]): void {
  if (solution.length < 2) return;
  
  const fromRouteIndex = Math.floor(Math.random() * solution.length);
  const fromRoute = solution[fromRouteIndex];
  
  if (fromRoute.stops.length <= MIN_OUTLETS_PER_BEAT) return;
  
  const sameClusterRoutes = solution.filter((r, i) => 
    i !== fromRouteIndex && r.clusterIds[0] === fromRoute.clusterIds[0]
  );
  
  if (sameClusterRoutes.length === 0) return;
  
  const toRoute = sameClusterRoutes[Math.floor(Math.random() * sameClusterRoutes.length)];
  
  if (toRoute.stops.length >= MAX_OUTLETS_PER_BEAT) return;
  
  const customerIndex = Math.floor(Math.random() * fromRoute.stops.length);
  const [customer] = fromRoute.stops.splice(customerIndex, 1);
  
  let bestPos = 0;
  let minIncrease = Infinity;
  
  for (let i = 0; i <= toRoute.stops.length; i++) {
    toRoute.stops.splice(i, 0, customer);
    updateRouteMetrics(toRoute);
    const increase = toRoute.totalDistance;
    
    if (increase < minIncrease) {
      minIncrease = increase;
      bestPos = i;
    }
    
    toRoute.stops.splice(i, 1);
  }
  
  toRoute.stops.splice(bestPos, 0, customer);
  updateRouteMetrics(fromRoute);
  updateRouteMetrics(toRoute);
}

function updateRouteMetrics(route: SalesmanRoute): void {
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
    
    const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
    
    route.totalDistance += distance;
    route.totalTime += travelTime + CUSTOMER_VISIT_TIME;
    
    if (i < route.stops.length - 1) {
      const nextStop = route.stops[i + 1];
      const nextDistance = calculateHaversineDistance(
        stop.latitude, stop.longitude,
        nextStop.latitude, nextStop.longitude
      );
      
      const nextTime = calculateTravelTime(nextDistance, TRAVEL_SPEED);
      
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

function calculateEnergy(solution: SalesmanRoute[]): number {
  let totalEnergy = 0;
  
  totalEnergy += solution.reduce((sum, route) => sum + route.totalDistance, 0);
  
  solution.forEach(route => {
    if (route.stops.length < MIN_OUTLETS_PER_BEAT) {
      totalEnergy += 1000 * (MIN_OUTLETS_PER_BEAT - route.stops.length);
    }
    if (route.stops.length > MAX_OUTLETS_PER_BEAT) {
      totalEnergy += 1000 * (route.stops.length - MAX_OUTLETS_PER_BEAT);
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

function optimizeBeats(routes: SalesmanRoute[], distributor: { latitude: number; longitude: number }): SalesmanRoute[] {
  const optimizedRoutes = routes.reduce((acc, route) => {
    if (route.stops.length >= MIN_OUTLETS_PER_BEAT && route.stops.length <= MAX_OUTLETS_PER_BEAT) {
      acc.push(route);
    } else if (route.stops.length < MIN_OUTLETS_PER_BEAT) {
      const mergeCandidate = acc.find(r => 
        r.clusterIds[0] === route.clusterIds[0] && 
        r.stops.length + route.stops.length <= MAX_OUTLETS_PER_BEAT
      );
      
      if (mergeCandidate) {
        mergeCandidate.stops.push(...route.stops);
        updateRouteMetrics(mergeCandidate);
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
      
      updateRouteMetrics(route1);
      updateRouteMetrics(route2);
      
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