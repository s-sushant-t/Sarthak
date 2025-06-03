import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 28;
const MAX_OUTLETS_PER_BEAT = 35;
const CUSTOMER_VISIT_TIME = 6;
const MAX_WORKING_TIME = 360;
const TRAVEL_SPEED = 30;

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
  
  // Parameters for simulated annealing - adjusted for better optimization
  const INITIAL_TEMPERATURE = 100;
  const COOLING_RATE = 0.995;
  const MIN_TEMPERATURE = 0.01;
  const ITERATIONS_PER_TEMP = 100;
  
  // Create initial solution using greedy approach
  const initialSolution = createInitialSolution(distributor, customersByCluster);
  let currentSolution = JSON.parse(JSON.stringify(initialSolution));
  let bestSolution = JSON.parse(JSON.stringify(initialSolution));
  
  let currentEnergy = calculateTotalDistance(currentSolution);
  let bestEnergy = currentEnergy;
  
  // Simulated annealing process
  let temperature = INITIAL_TEMPERATURE;
  let noImprovementCount = 0;
  const MAX_NO_IMPROVEMENT = 20;
  
  while (temperature > MIN_TEMPERATURE && noImprovementCount < MAX_NO_IMPROVEMENT) {
    let improvementFound = false;
    
    for (let i = 0; i < ITERATIONS_PER_TEMP; i++) {
      const neighborSolution = createNeighborSolution(currentSolution, temperature / INITIAL_TEMPERATURE);
      const neighborEnergy = calculateTotalDistance(neighborSolution);
      
      // Calculate acceptance probability with modified formula for better selection
      const acceptanceProbability = calculateAcceptanceProbability(
        currentEnergy,
        neighborEnergy,
        temperature,
        INITIAL_TEMPERATURE
      );
      
      if (Math.random() < acceptanceProbability) {
        currentSolution = neighborSolution;
        currentEnergy = neighborEnergy;
        
        if (currentEnergy < bestEnergy) {
          bestSolution = JSON.parse(JSON.stringify(currentSolution));
          bestEnergy = currentEnergy;
          improvementFound = true;
          noImprovementCount = 0;
        }
      }
      
      // Allow UI to update
      if (i % 50 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    if (!improvementFound) {
      noImprovementCount++;
    }
    
    temperature *= COOLING_RATE;
  }
  
  // Final optimization pass
  const optimizedRoutes = optimizeBeats(bestSolution, distributor);
  
  // Calculate total distance
  const totalDistance = optimizedRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: 'Simulated Annealing (Clustered)',
    totalDistance,
    totalSalesmen: optimizedRoutes.length,
    processingTime: 0,
    routes: optimizedRoutes
  };
};

function createInitialSolution(
  distributor: { latitude: number; longitude: number },
  customersByCluster: Record<number, ClusteredCustomer[]>
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    
    while (clusterCustomers.length > 0) {
      const route: SalesmanRoute = {
        salesmanId: salesmanId++,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [Number(clusterId)],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      };
      
      let currentLat = distributor.latitude;
      let currentLng = distributor.longitude;
      let remainingTime = MAX_WORKING_TIME;
      
      // Use nearest neighbor for initial solution
      while (clusterCustomers.length > 0 && 
             remainingTime > 0 && 
             route.stops.length < MAX_OUTLETS_PER_BEAT) {
        let nearestIndex = -1;
        let shortestDistance = Infinity;
        
        for (let i = 0; i < clusterCustomers.length; i++) {
          const customer = clusterCustomers[i];
          const distance = calculateHaversineDistance(
            currentLat, currentLng,
            customer.latitude, customer.longitude
          );
          
          const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
          if (travelTime + CUSTOMER_VISIT_TIME > remainingTime) continue;
          
          if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestIndex = i;
          }
        }
        
        if (nearestIndex === -1) break;
        
        const customer = clusterCustomers.splice(nearestIndex, 1)[0];
        const travelTime = calculateTravelTime(shortestDistance, TRAVEL_SPEED);
        
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
        
        currentLat = customer.latitude;
        currentLng = customer.longitude;
        remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
      }
      
      if (route.stops.length > 0) {
        updateRouteMetrics(route);
        routes.push(route);
      }
    }
  }
  
  return routes;
}

function createNeighborSolution(solution: SalesmanRoute[], temperatureRatio: number): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Number of modifications decreases as temperature drops
  const numModifications = 1 + Math.floor(Math.random() * Math.max(2, 3 * temperatureRatio));
  
  for (let m = 0; m < numModifications; m++) {
    // Weight operations based on temperature
    const operations = [
      { type: 'swap', weight: 0.4 },
      { type: 'reverse', weight: 0.3 },
      { type: 'relocate', weight: 0.2 + (0.3 * (1 - temperatureRatio)) },
      { type: 'cross', weight: 0.1 + (0.2 * temperatureRatio) }
    ];
    
    const totalWeight = operations.reduce((sum, op) => sum + op.weight, 0);
    let random = Math.random() * totalWeight;
    let selectedOp = operations[0].type;
    
    for (const op of operations) {
      if (random <= op.weight) {
        selectedOp = op.type;
        break;
      }
      random -= op.weight;
    }
    
    switch (selectedOp) {
      case 'swap':
        performSwapOperation(newSolution);
        break;
      case 'reverse':
        performReverseOperation(newSolution);
        break;
      case 'relocate':
        performRelocateOperation(newSolution);
        break;
      case 'cross':
        performCrossOperation(newSolution);
        break;
    }
  }
  
  return newSolution;
}

function performSwapOperation(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length >= 2) {
    const i = Math.floor(Math.random() * route.stops.length);
    let j = Math.floor(Math.random() * route.stops.length);
    
    while (i === j) {
      j = Math.floor(Math.random() * route.stops.length);
    }
    
    [route.stops[i], route.stops[j]] = [route.stops[j], route.stops[i]];
    updateRouteMetrics(route);
  }
}

function performReverseOperation(solution: SalesmanRoute[]): void {
  if (solution.length === 0) return;
  
  const routeIndex = Math.floor(Math.random() * solution.length);
  const route = solution[routeIndex];
  
  if (route.stops.length >= 3) {
    const start = Math.floor(Math.random() * (route.stops.length - 2));
    const length = 2 + Math.floor(Math.random() * (route.stops.length - start - 1));
    
    const segment = route.stops.slice(start, start + length);
    segment.reverse();
    route.stops.splice(start, length, ...segment);
    
    updateRouteMetrics(route);
  }
}

function performRelocateOperation(solution: SalesmanRoute[]): void {
  if (solution.length < 2) return;
  
  const fromRouteIndex = Math.floor(Math.random() * solution.length);
  const fromRoute = solution[fromRouteIndex];
  
  if (fromRoute.stops.length <= MIN_OUTLETS_PER_BEAT) return;
  
  const toRouteIndex = Math.floor(Math.random() * solution.length);
  const toRoute = solution[toRouteIndex];
  
  if (toRoute.stops.length >= MAX_OUTLETS_PER_BEAT) return;
  
  const stopIndex = Math.floor(Math.random() * fromRoute.stops.length);
  const stop = fromRoute.stops.splice(stopIndex, 1)[0];
  
  const insertIndex = Math.floor(Math.random() * (toRoute.stops.length + 1));
  toRoute.stops.splice(insertIndex, 0, stop);
  
  updateRouteMetrics(fromRoute);
  updateRouteMetrics(toRoute);
}

function performCrossOperation(solution: SalesmanRoute[]): void {
  if (solution.length < 2) return;
  
  const route1Index = Math.floor(Math.random() * solution.length);
  let route2Index = Math.floor(Math.random() * solution.length);
  
  while (route2Index === route1Index) {
    route2Index = Math.floor(Math.random() * solution.length);
  }
  
  const route1 = solution[route1Index];
  const route2 = solution[route2Index];
  
  if (route1.stops.length < 2 || route2.stops.length < 2) return;
  
  const point1 = Math.floor(Math.random() * route1.stops.length);
  const point2 = Math.floor(Math.random() * route2.stops.length);
  
  const temp = route1.stops.slice(point1);
  route1.stops.splice(point1, temp.length, ...route2.stops.slice(point2));
  route2.stops.splice(point2, route2.stops.length - point2, ...temp);
  
  updateRouteMetrics(route1);
  updateRouteMetrics(route2);
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

function optimizeBeats(routes: SalesmanRoute[], distributor: { latitude: number; longitude: number }): SalesmanRoute[] {
  let optimizedRoutes = [...routes];
  let improved = true;
  
  while (improved) {
    improved = false;
    
    // Try to balance routes within clusters
    for (let i = 0; i < optimizedRoutes.length; i++) {
      for (let j = i + 1; j < optimizedRoutes.length; j++) {
        if (optimizedRoutes[i].clusterIds[0] !== optimizedRoutes[j].clusterIds[0]) continue;
        
        const diff = optimizedRoutes[i].stops.length - optimizedRoutes[j].stops.length;
        
        if (Math.abs(diff) >= 2) {
          const fromRoute = diff > 0 ? optimizedRoutes[i] : optimizedRoutes[j];
          const toRoute = diff > 0 ? optimizedRoutes[j] : optimizedRoutes[i];
          
          if (fromRoute.stops.length > MIN_OUTLETS_PER_BEAT && 
              toRoute.stops.length < MAX_OUTLETS_PER_BEAT) {
            const numToMove = Math.floor(Math.abs(diff) / 2);
            const stopsToMove = fromRoute.stops.splice(-numToMove);
            toRoute.stops.push(...stopsToMove);
            
            updateRouteMetrics(fromRoute);
            updateRouteMetrics(toRoute);
            improved = true;
          }
        }
      }
    }
  }
  
  // Reassign beat IDs sequentially
  return optimizedRoutes.map((route, index) => ({
    ...route,
    salesmanId: index + 1,
    distributorLat: distributor.latitude,
    distributorLng: distributor.longitude
  }));
}

function calculateTotalDistance(solution: SalesmanRoute[]): number {
  return solution.reduce((total, route) => {
    let routeDistance = 0;
    let prevLat = route.distributorLat;
    let prevLng = route.distributorLng;
    
    for (const stop of route.stops) {
      const distance = calculateHaversineDistance(
        prevLat, prevLng,
        stop.latitude, stop.longitude
      );
      routeDistance += distance;
      prevLat = stop.latitude;
      prevLng = stop.longitude;
    }
    
    // Add return distance to distributor
    if (route.stops.length > 0) {
      const lastStop = route.stops[route.stops.length - 1];
      routeDistance += calculateHaversineDistance(
        lastStop.latitude, lastStop.longitude,
        route.distributorLat, route.distributorLng
      );
    }
    
    return total + routeDistance;
  }, 0);
}

function calculateAcceptanceProbability(
  currentEnergy: number,
  newEnergy: number,
  temperature: number,
  initialTemperature: number
): number {
  if (newEnergy < currentEnergy) return 1;
  
  // Modified acceptance probability that becomes more selective as temperature drops
  const delta = newEnergy - currentEnergy;
  const tempRatio = temperature / initialTemperature;
  return Math.exp(-delta / (temperature * (1 + tempRatio)));
}