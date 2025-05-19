import { LocationData, Customer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

export const christofides = async (locationData: LocationData): Promise<AlgorithmResult> => {
  // This is a simplified implementation that adapts the nearest neighbor algorithm
  // A full Christofides implementation would be much more complex
  
  const { distributor, customers } = locationData;
  
  // Constants for time calculation
  const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
  const MAX_WORKING_TIME = 360; // 6 hours in minutes
  const TRAVEL_SPEED = 30; // km/h
  
  // Create a copy of customers to work with
  const unvisitedCustomers = [...customers];
  const routes: SalesmanRoute[] = [];
  
  let currentSalesmanId = 1;
  
  // Create distance matrix
  const createDistanceMatrix = (customers: Customer[], distributorLat: number, distributorLng: number) => {
    const n = customers.length;
    const distMatrix: number[][] = Array(n + 1).fill(0).map(() => Array(n + 1).fill(0));
    
    // Calculate distances between distributor and all customers
    for (let i = 0; i < n; i++) {
      distMatrix[0][i + 1] = calculateHaversineDistance(
        distributorLat, distributorLng,
        customers[i].latitude, customers[i].longitude
      );
      distMatrix[i + 1][0] = distMatrix[0][i + 1];
    }
    
    // Calculate distances between all customers
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        distMatrix[i + 1][j + 1] = calculateHaversineDistance(
          customers[i].latitude, customers[i].longitude,
          customers[j].latitude, customers[j].longitude
        );
        distMatrix[j + 1][i + 1] = distMatrix[i + 1][j + 1];
      }
    }
    
    return distMatrix;
  };
  
  // Function to find the minimum spanning tree using Prim's algorithm
  const findMST = (distMatrix: number[][]): number[][] => {
    const n = distMatrix.length;
    const visited: boolean[] = Array(n).fill(false);
    const mst: number[][] = [];
    
    // Start with vertex 0 (distributor)
    visited[0] = true;
    
    // We need n-1 edges for MST
    for (let e = 0; e < n - 1; e++) {
      let minDist = Infinity;
      let u = -1;
      let v = -1;
      
      // Find the smallest edge connecting a visited and an unvisited vertex
      for (let i = 0; i < n; i++) {
        if (visited[i]) {
          for (let j = 0; j < n; j++) {
            if (!visited[j] && distMatrix[i][j] < minDist) {
              minDist = distMatrix[i][j];
              u = i;
              v = j;
            }
          }
        }
      }
      
      if (u !== -1 && v !== -1) {
        mst.push([u, v]);
        visited[v] = true;
      }
    }
    
    return mst;
  };
  
  // Function to split customers into clusters for multiple salesmen
  const createClusters = (distMatrix: number[][], mst: number[][]): number[][] => {
    // This is a simplified approach - we're just going to split the tree into roughly equal parts
    // based on the number of salesmen we estimate we need
    
    // Estimate the number of salesmen needed based on working time constraints
    const totalCustomers = distMatrix.length - 1; // Subtract one for the distributor
    const estimatedTimePerCustomer = CUSTOMER_VISIT_TIME + 10; // Average travel time between customers
    const customersPerSalesman = Math.ceil(MAX_WORKING_TIME / estimatedTimePerCustomer);
    const estimatedSalesmen = Math.ceil(totalCustomers / customersPerSalesman);
    
    // Create clusters by dividing the customer list
    const clusters: number[][] = [];
    let customersPerCluster = Math.ceil(totalCustomers / estimatedSalesmen);
    
    for (let i = 0; i < estimatedSalesmen; i++) {
      const start = i * customersPerCluster + 1; // +1 to skip distributor
      const end = Math.min(start + customersPerCluster, distMatrix.length);
      
      if (start < end) {
        const cluster = Array.from({ length: end - start }, (_, j) => start + j);
        clusters.push([0, ...cluster]); // Add distributor (0) as the first point
      }
    }
    
    return clusters;
  };
  
  // Main algorithm
  try {
    // If there are customers to visit
    if (unvisitedCustomers.length > 0) {
      // Create distance matrix
      const distMatrix = createDistanceMatrix(unvisitedCustomers, distributor.latitude, distributor.longitude);
      
      // Find Minimum Spanning Tree
      const mst = findMST(distMatrix);
      
      // Create clusters for multiple salesmen
      const clusters = createClusters(distMatrix, mst);
      
      // Create routes for each cluster
      for (const cluster of clusters) {
        const currentRoute: SalesmanRoute = {
          salesmanId: currentSalesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0
        };
        
        let currentLat = distributor.latitude;
        let currentLng = distributor.longitude;
        let remainingTime = MAX_WORKING_TIME;
        
        // Add customers in this cluster to the route
        // We'll use nearest neighbor within the cluster for simplicity
        const clusterCustomers = cluster.slice(1).map(idx => unvisitedCustomers[idx - 1]);
        const usedIndices = new Set<number>();
        
        while (clusterCustomers.length > usedIndices.size && remainingTime > 0) {
          let nearestIdx = -1;
          let shortestDist = Infinity;
          
          for (let i = 0; i < clusterCustomers.length; i++) {
            if (usedIndices.has(i)) continue;
            
            const customer = clusterCustomers[i];
            if (!customer) continue;
            
            const distance = calculateHaversineDistance(
              currentLat, currentLng,
              customer.latitude, customer.longitude
            );
            
            const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
            if (travelTime + CUSTOMER_VISIT_TIME > remainingTime) continue;
            
            if (distance < shortestDist) {
              shortestDist = distance;
              nearestIdx = i;
            }
          }
          
          if (nearestIdx === -1) break;
          
          const customer = clusterCustomers[nearestIdx];
          if (!customer) continue;
          
          usedIndices.add(nearestIdx);
          
          const travelTime = calculateTravelTime(shortestDist, TRAVEL_SPEED);
          
          currentRoute.stops.push({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: CUSTOMER_VISIT_TIME
          });
          
          currentRoute.totalDistance += shortestDist;
          currentRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
          remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
          
          currentLat = customer.latitude;
          currentLng = customer.longitude;
          
          // Remove this customer from the unvisited list
          const globalIndex = unvisitedCustomers.findIndex(c => c.id === customer.id);
          if (globalIndex !== -1) {
            unvisitedCustomers.splice(globalIndex, 1);
          }
        }
        
        // Update distanceToNext and timeToNext
        for (let i = 0; i < currentRoute.stops.length - 1; i++) {
          const currentStop = currentRoute.stops[i];
          const nextStop = currentRoute.stops[i + 1];
          
          const distance = calculateHaversineDistance(
            currentStop.latitude, currentStop.longitude,
            nextStop.latitude, nextStop.longitude
          );
          
          const time = calculateTravelTime(distance, TRAVEL_SPEED);
          
          currentRoute.stops[i].distanceToNext = distance;
          currentRoute.stops[i].timeToNext = time;
        }
        
        // Add route if it has any stops
        if (currentRoute.stops.length > 0) {
          routes.push(currentRoute);
        }
      }
      
      // If there are still unvisited customers, use nearest neighbor for them
      while (unvisitedCustomers.length > 0) {
        const currentRoute: SalesmanRoute = {
          salesmanId: currentSalesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0
        };
        
        let currentLat = distributor.latitude;
        let currentLng = distributor.longitude;
        let remainingTime = MAX_WORKING_TIME;
        
        while (unvisitedCustomers.length > 0 && remainingTime > 0) {
          let nearestIndex = -1;
          let shortestDistance = Infinity;
          
          for (let i = 0; i < unvisitedCustomers.length; i++) {
            const customer = unvisitedCustomers[i];
            if (!customer) continue;
            
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
          
          const customer = unvisitedCustomers.splice(nearestIndex, 1)[0];
          if (!customer) continue;
          
          const travelTime = calculateTravelTime(shortestDistance, TRAVEL_SPEED);
          
          currentRoute.stops.push({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: CUSTOMER_VISIT_TIME
          });
          
          currentRoute.totalDistance += shortestDistance;
          currentRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
          remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
          
          currentLat = customer.latitude;
          currentLng = customer.longitude;
        }
        
        // Update distanceToNext and timeToNext
        for (let i = 0; i < currentRoute.stops.length - 1; i++) {
          const currentStop = currentRoute.stops[i];
          const nextStop = currentRoute.stops[i + 1];
          
          const distance = calculateHaversineDistance(
            currentStop.latitude, currentStop.longitude,
            nextStop.latitude, nextStop.longitude
          );
          
          const time = calculateTravelTime(distance, TRAVEL_SPEED);
          
          currentStop.distanceToNext = distance;
          currentStop.timeToNext = time;
        }
        
        // Add route if it has any stops
        if (currentRoute.stops.length > 0) {
          routes.push(currentRoute);
        }
      }
    }
  } catch (error) {
    console.error("Error in Christofides algorithm:", error);
  }
  
  // Calculate total distance
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: 'Christofides Algorithm',
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0, // Will be updated by caller
    routes
  };
};