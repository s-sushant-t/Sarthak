import { LocationData, Customer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const BATCH_SIZE = 50; // Process customers in batches of 50

export const antColony = async (locationData: LocationData): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  // Constants
  const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
  const MAX_WORKING_TIME = 360; // 6 hours in minutes
  const TRAVEL_SPEED = 30; // km/h
  
  // ACO parameters - adjusted for larger datasets
  const NUM_ANTS = Math.min(10, Math.ceil(customers.length / 20)); // Scale ants with dataset size
  const NUM_ITERATIONS = Math.min(20, Math.ceil(customers.length / 10)); // Scale iterations with dataset size
  const PHEROMONE_EVAPORATION_RATE = 0.5;
  const ALPHA = 1; // Pheromone importance
  const BETA = 2; // Distance importance
  const INITIAL_PHEROMONE = 1;
  
  // Process customers in batches
  const processCustomerBatch = async (batchCustomers: Customer[]): Promise<SalesmanRoute[]> => {
    const n = batchCustomers.length;
    const distances: number[][] = Array(n + 1).fill(0).map(() => Array(n + 1).fill(0));
    
    // Calculate distances between distributor and batch customers
    for (let i = 0; i < n; i++) {
      distances[0][i + 1] = calculateHaversineDistance(
        distributor.latitude, distributor.longitude,
        batchCustomers[i].latitude, batchCustomers[i].longitude
      );
      distances[i + 1][0] = distances[0][i + 1];
    }
    
    // Calculate distances between batch customers
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        distances[i + 1][j + 1] = calculateHaversineDistance(
          batchCustomers[i].latitude, batchCustomers[i].longitude,
          batchCustomers[j].latitude, batchCustomers[j].longitude
        );
        distances[j + 1][i + 1] = distances[i + 1][j + 1];
      }
    }
    
    // Initialize pheromone matrix for batch
    const pheromones: number[][] = Array(n + 1).fill(0).map(() => Array(n + 1).fill(INITIAL_PHEROMONE));
    
    let bestSolution: number[][] = [];
    let bestSolutionLength = Infinity;
    
    // Main ACO loop for batch
    for (let iter = 0; iter < NUM_ITERATIONS; iter++) {
      const antSolutions: number[][][] = [];
      const antSolutionLengths: number[] = [];
      
      // Each ant constructs a solution
      for (let ant = 0; ant < NUM_ANTS; ant++) {
        let currentCity = 0;
        const unvisitedCities = Array.from({ length: n }, (_, i) => i + 1);
        const solution: number[][] = [];
        let currentRoute: number[] = [0];
        let remainingTime = MAX_WORKING_TIME;
        let routeLength = 0;
        
        while (unvisitedCities.length > 0) {
          let nextCity = -1;
          const probabilities: { city: number; prob: number }[] = [];
          let totalProbability = 0;
          
          for (let i = 0; i < unvisitedCities.length; i++) {
            const city = unvisitedCities[i];
            const distance = distances[currentCity][city];
            const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
            
            if (travelTime + CUSTOMER_VISIT_TIME > remainingTime) continue;
            
            const pheromone = Math.pow(pheromones[currentCity][city], ALPHA);
            const visibility = Math.pow(1 / distance, BETA);
            const probability = pheromone * visibility;
            
            probabilities.push({ city, prob: probability });
            totalProbability += probability;
          }
          
          if (probabilities.length === 0) {
            if (currentRoute.length > 1) {
              solution.push(currentRoute);
              routeLength += calculateRouteLength(currentRoute, distances);
            }
            currentCity = 0;
            currentRoute = [0];
            remainingTime = MAX_WORKING_TIME;
            continue;
          }
          
          if (totalProbability > 0) {
            const rand = Math.random() * totalProbability;
            let cumulativeProbability = 0;
            
            for (const { city, prob } of probabilities) {
              cumulativeProbability += prob;
              if (cumulativeProbability >= rand) {
                nextCity = city;
                break;
              }
            }
          } else {
            const randomIndex = Math.floor(Math.random() * probabilities.length);
            nextCity = probabilities[randomIndex].city;
          }
          
          if (nextCity !== -1) {
            const distance = distances[currentCity][nextCity];
            const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
            
            currentRoute.push(nextCity);
            remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
            
            const index = unvisitedCities.indexOf(nextCity);
            if (index !== -1) {
              unvisitedCities.splice(index, 1);
            }
            
            currentCity = nextCity;
          }
        }
        
        if (currentRoute.length > 1) {
          solution.push(currentRoute);
          routeLength += calculateRouteLength(currentRoute, distances);
        }
        
        antSolutions.push(solution);
        antSolutionLengths.push(routeLength);
        
        if (routeLength < bestSolutionLength) {
          bestSolution = JSON.parse(JSON.stringify(solution));
          bestSolutionLength = routeLength;
        }
      }
      
      // Update pheromones with batch results
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
          pheromones[i][j] *= (1 - PHEROMONE_EVAPORATION_RATE);
        }
      }
      
      for (let ant = 0; ant < NUM_ANTS; ant++) {
        const solution = antSolutions[ant];
        const solutionLength = antSolutionLengths[ant];
        const pheromoneToAdd = 1 / solutionLength;
        
        for (const route of solution) {
          for (let i = 0; i < route.length - 1; i++) {
            const from = route[i];
            const to = route[i + 1];
            pheromones[from][to] += pheromoneToAdd;
            pheromones[to][from] += pheromoneToAdd;
          }
        }
      }
      
      // Yield to main thread occasionally to prevent blocking
      if (iter % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    // Convert batch solution to routes
    const batchRoutes: SalesmanRoute[] = [];
    let currentSalesmanId = batchRoutes.length + 1;
    
    for (const routeIndices of bestSolution) {
      const route: SalesmanRoute = {
        salesmanId: currentSalesmanId++,
        stops: [],
        totalDistance: 0,
        totalTime: 0
      };
      
      for (let j = 1; j < routeIndices.length; j++) {
        const customerIndex = routeIndices[j] - 1;
        const customer = batchCustomers[customerIndex];
        
        route.stops.push({
          customerId: customer.id,
          latitude: customer.latitude,
          longitude: customer.longitude,
          distanceToNext: 0,
          timeToNext: 0,
          visitTime: CUSTOMER_VISIT_TIME
        });
      }
      
      let prevLat = distributor.latitude;
      let prevLng = distributor.longitude;
      
      for (let j = 0; j < route.stops.length; j++) {
        const stop = route.stops[j];
        const distance = calculateHaversineDistance(prevLat, prevLng, stop.latitude, stop.longitude);
        const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
        
        route.totalDistance += distance;
        route.totalTime += travelTime + CUSTOMER_VISIT_TIME;
        
        prevLat = stop.latitude;
        prevLng = stop.longitude;
        
        if (j < route.stops.length - 1) {
          const nextStop = route.stops[j + 1];
          const distanceToNext = calculateHaversineDistance(
            stop.latitude, stop.longitude,
            nextStop.latitude, nextStop.longitude
          );
          const timeToNext = calculateTravelTime(distanceToNext, TRAVEL_SPEED);
          
          stop.distanceToNext = distanceToNext;
          stop.timeToNext = timeToNext;
        }
      }
      
      if (route.stops.length > 0) {
        batchRoutes.push(route);
      }
    }
    
    return batchRoutes;
  };
  
  // Process all customers in batches
  const allRoutes: SalesmanRoute[] = [];
  for (let i = 0; i < customers.length; i += BATCH_SIZE) {
    const batch = customers.slice(i, i + BATCH_SIZE);
    const batchRoutes = await processCustomerBatch(batch);
    allRoutes.push(...batchRoutes);
    
    // Yield to main thread between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  // Calculate total distance for all routes
  const totalDistance = allRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: 'Ant Colony Optimization',
    totalDistance,
    totalSalesmen: allRoutes.length,
    processingTime: 0,
    routes: allRoutes
  };
  
  function calculateRouteLength(route: number[], distances: number[][]): number {
    let length = 0;
    for (let i = 0; i < route.length - 1; i++) {
      length += distances[route[i]][route[i + 1]];
    }
    return length;
  }
};