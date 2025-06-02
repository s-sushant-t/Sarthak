import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 30;
const MAX_OUTLETS_PER_BEAT = 40;
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
  
  // Parameters for simulated annealing
  const INITIAL_TEMPERATURE = 100;
  const COOLING_RATE = 0.95;
  const MIN_TEMPERATURE = 0.1;
  const ITERATIONS_PER_TEMP = 100;
  
  // Create initial solution using nearest neighbor approach
  const initialSolution = createInitialSolution(distributor, customersByCluster);
  let currentSolution = JSON.parse(JSON.stringify(initialSolution));
  let bestSolution = JSON.parse(JSON.stringify(initialSolution));
  
  let currentEnergy = calculateTotalDistance(currentSolution);
  let bestEnergy = currentEnergy;
  
  // Simulated annealing process
  let temperature = INITIAL_TEMPERATURE;
  
  while (temperature > MIN_TEMPERATURE) {
    for (let i = 0; i < ITERATIONS_PER_TEMP; i++) {
      const neighborSolution = createNeighborSolution(currentSolution);
      
      // Only accept solutions where all routes meet the minimum requirement
      if (neighborSolution.every(route => route.stops.length >= MIN_OUTLETS_PER_BEAT)) {
        const neighborEnergy = calculateTotalDistance(neighborSolution);
        
        const acceptanceProbability = calculateAcceptanceProbability(
          currentEnergy,
          neighborEnergy,
          temperature
        );
        
        if (Math.random() < acceptanceProbability) {
          currentSolution = neighborSolution;
          currentEnergy = neighborEnergy;
          
          if (currentEnergy < bestEnergy) {
            bestSolution = JSON.parse(JSON.stringify(currentSolution));
            bestEnergy = currentEnergy;
          }
        }
      }
    }
    
    temperature *= COOLING_RATE;
  }
  
  // Ensure all routes in the best solution meet minimum requirements
  const validRoutes = bestSolution.filter(route => route.stops.length >= MIN_OUTLETS_PER_BEAT);
  
  return {
    name: 'Simulated Annealing (Clustered)',
    totalDistance: calculateTotalDistance(validRoutes),
    totalSalesmen: validRoutes.length,
    processingTime: 0,
    routes: validRoutes
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
        clusterIds: [Number(clusterId)]
      };
      
      let currentLat = distributor.latitude;
      let currentLng = distributor.longitude;
      let remainingTime = MAX_WORKING_TIME;
      
      // Calculate target outlets for this route
      const remainingOutlets = clusterCustomers.length;
      const targetOutlets = Math.max(
        MIN_OUTLETS_PER_BEAT,
        Math.min(MAX_OUTLETS_PER_BEAT, remainingOutlets)
      );
      
      while (clusterCustomers.length > 0 && 
             remainingTime > 0 && 
             route.stops.length < targetOutlets) {
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
          clusterId: customer.clusterId
        });
        
        route.totalDistance += shortestDistance;
        route.totalTime += travelTime + CUSTOMER_VISIT_TIME;
        remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
        
        currentLat = customer.latitude;
        currentLng = customer.longitude;
      }
      
      // If route doesn't meet minimum requirements, return customers to pool
      if (route.stops.length < MIN_OUTLETS_PER_BEAT) {
        clusterCustomers.push(...route.stops.map(stop => ({
          id: stop.customerId,
          latitude: stop.latitude,
          longitude: stop.longitude,
          clusterId: stop.clusterId
        })));
        continue;
      }
      
      updateRouteMetrics(route, distributor);
      routes.push(route);
    }
  }
  
  return routes;
}

function createNeighborSolution(solution: SalesmanRoute[]): SalesmanRoute[] {
  const newSolution = JSON.parse(JSON.stringify(solution));
  
  // Apply one of several possible modifications
  const operation = Math.floor(Math.random() * 3);
  
  switch (operation) {
    case 0: // Swap two stops within a route
      if (newSolution.length > 0) {
        const routeIndex = Math.floor(Math.random() * newSolution.length);
        const route = newSolution[routeIndex];
        
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
      break;
      
    case 1: // Reverse a segment within a route
      if (newSolution.length > 0) {
        const routeIndex = Math.floor(Math.random() * newSolution.length);
        const route = newSolution[routeIndex];
        
        if (route.stops.length >= 3) {
          const start = Math.floor(Math.random() * (route.stops.length - 2));
          const end = start + 1 + Math.floor(Math.random() * (route.stops.length - start - 1));
          
          const segment = route.stops.slice(start, end + 1);
          segment.reverse();
          route.stops.splice(start, segment.length, ...segment);
          
          updateRouteMetrics(route);
        }
      }
      break;
      
    case 2: // Move stops between routes while maintaining minimum requirements
      if (newSolution.length >= 2) {
        const sourceIndex = Math.floor(Math.random() * newSolution.length);
        let targetIndex = Math.floor(Math.random() * newSolution.length);
        
        while (targetIndex === sourceIndex) {
          targetIndex = Math.floor(Math.random() * newSolution.length);
        }
        
        const sourceRoute = newSolution[sourceIndex];
        const targetRoute = newSolution[targetIndex];
        
        // Only move stops if both routes will maintain minimum requirements
        if (sourceRoute.stops.length > MIN_OUTLETS_PER_BEAT + 1 &&
            targetRoute.stops.length < MAX_OUTLETS_PER_BEAT) {
          const stopIndex = Math.floor(Math.random() * sourceRoute.stops.length);
          const [stop] = sourceRoute.stops.splice(stopIndex, 1);
          targetRoute.stops.push(stop);
          
          updateRouteMetrics(sourceRoute);
          updateRouteMetrics(targetRoute);
        }
      }
      break;
  }
  
  return newSolution;
}

function updateRouteMetrics(
  route: SalesmanRoute,
  distributor?: { latitude: number; longitude: number }
): void {
  route.totalDistance = 0;
  route.totalTime = 0;
  
  if (route.stops.length === 0) return;
  
  let prevLat = distributor ? distributor.latitude : route.stops[0].latitude;
  let prevLng = distributor ? distributor.longitude : route.stops[0].longitude;
  
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

function calculateTotalDistance(solution: SalesmanRoute[]): number {
  return solution.reduce((total, route) => total + route.totalDistance, 0);
}

function calculateAcceptanceProbability(
  currentEnergy: number,
  newEnergy: number,
  temperature: number
): number {
  if (newEnergy < currentEnergy) return 1;
  return Math.exp((currentEnergy - newEnergy) / temperature);
}