import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';

const MIN_OUTLETS_PER_BEAT = 30;
const MAX_OUTLETS_PER_BEAT = 50;
const CUSTOMER_VISIT_TIME = 6; // 6 minutes per customer
const MAX_WORKING_TIME = 360; // 6 hours in minutes
const TRAVEL_SPEED = 30; // km/h

export const nearestNeighbor = async (locationData: LocationData): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  // Group customers by cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  const routes: SalesmanRoute[] = [];
  let currentSalesmanId = 1;
  
  // Process each cluster
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = customersByCluster[Number(clusterId)];
    let unassignedCustomers = [...clusterCustomers];
    
    while (unassignedCustomers.length > 0) {
      const currentRoute: SalesmanRoute = {
        salesmanId: currentSalesmanId++,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [Number(clusterId)]
      };
      
      let currentLat = distributor.latitude;
      let currentLng = distributor.longitude;
      let remainingTime = MAX_WORKING_TIME;
      let assignedOutlets = 0;
      
      while (unassignedCustomers.length > 0 && 
             remainingTime > 0 && 
             assignedOutlets < MAX_OUTLETS_PER_BEAT) {
        let nearestIndex = -1;
        let shortestDistance = Infinity;
        
        // Find the nearest customer within reasonable distance
        for (let i = 0; i < unassignedCustomers.length; i++) {
          const customer = unassignedCustomers[i];
          const distance = calculateHaversineDistance(
            currentLat, currentLng,
            customer.latitude, customer.longitude
          );
          
          const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
          if (travelTime + CUSTOMER_VISIT_TIME > remainingTime) continue;
          
          // Skip if adding this customer would exceed max outlets
          if (assignedOutlets >= MAX_OUTLETS_PER_BEAT) continue;
          
          if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestIndex = i;
          }
        }
        
        // If no suitable customer found and we have minimum required outlets, break
        if (nearestIndex === -1 && assignedOutlets >= MIN_OUTLETS_PER_BEAT) break;
        
        // If no suitable customer found and we don't have minimum outlets, 
        // try to find any customer within reasonable distance
        if (nearestIndex === -1 && assignedOutlets < MIN_OUTLETS_PER_BEAT) {
          for (let i = 0; i < unassignedCustomers.length; i++) {
            const customer = unassignedCustomers[i];
            const distance = calculateHaversineDistance(
              currentLat, currentLng,
              customer.latitude, customer.longitude
            );
            
            // For minimum outlet requirement, be more lenient with time constraints
            const travelTime = calculateTravelTime(distance, TRAVEL_SPEED);
            if (travelTime + CUSTOMER_VISIT_TIME <= MAX_WORKING_TIME * 1.2) { // Allow 20% overtime for minimum requirement
              if (distance < shortestDistance) {
                shortestDistance = distance;
                nearestIndex = i;
              }
            }
          }
        }
        
        if (nearestIndex === -1) break;
        
        const nearestCustomer = unassignedCustomers.splice(nearestIndex, 1)[0];
        const travelTime = calculateTravelTime(shortestDistance, TRAVEL_SPEED);
        
        currentRoute.stops.push({
          customerId: nearestCustomer.id,
          latitude: nearestCustomer.latitude,
          longitude: nearestCustomer.longitude,
          distanceToNext: 0,
          timeToNext: 0,
          visitTime: CUSTOMER_VISIT_TIME,
          clusterId: nearestCustomer.clusterId
        });
        
        currentRoute.totalDistance += shortestDistance;
        currentRoute.totalTime += travelTime + CUSTOMER_VISIT_TIME;
        remainingTime -= (travelTime + CUSTOMER_VISIT_TIME);
        
        currentLat = nearestCustomer.latitude;
        currentLng = nearestCustomer.longitude;
        assignedOutlets++;
      }
      
      // Update distanceToNext and timeToNext for each stop
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
      
      // Only add routes that meet the minimum outlet requirement
      if (currentRoute.stops.length >= MIN_OUTLETS_PER_BEAT) {
        routes.push(currentRoute);
      } else {
        // If route doesn't meet minimum, put customers back in unassigned pool
        unassignedCustomers.push(...currentRoute.stops.map(stop => ({
          id: stop.customerId,
          latitude: stop.latitude,
          longitude: stop.longitude,
          clusterId: stop.clusterId
        })));
      }
    }
  }
  
  // Calculate total distance
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: 'Nearest Neighbor (Clustered)',
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
};