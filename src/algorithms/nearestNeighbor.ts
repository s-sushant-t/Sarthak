import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-optimized nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Create a copy of all customers to track which ones have been assigned
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
  
  const routes: SalesmanRoute[] = [];
  let currentSalesmanId = 1;
  
  // Process each cluster to create the specified number of beats per cluster
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    console.log(`Target: ${config.beatsPerCluster} beats for this cluster`);
    
    // Create linear routes within the cluster using directional sweeping
    const clusterRoutes = createLinearRoutesInCluster(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId)
    );
    
    // Track assigned customers
    clusterRoutes.forEach(route => {
      route.stops.forEach(stop => {
        assignedCustomerIds.add(stop.customerId);
      });
    });
    
    routes.push(...clusterRoutes);
    currentSalesmanId += clusterRoutes.length;
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} linear beats created`);
  }
  
  // CRITICAL: Check for any unassigned customers and force them into routes
  const unassignedCustomers = allCustomers.filter(customer => !assignedCustomerIds.has(customer.id));
  
  if (unassignedCustomers.length > 0) {
    console.warn(`Found ${unassignedCustomers.length} unassigned customers! Force-assigning them...`);
    
    // Force assign unassigned customers to existing routes or create new ones
    while (unassignedCustomers.length > 0) {
      // Try to add to existing routes first
      let assigned = false;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat && unassignedCustomers.length > 0) {
          const customer = unassignedCustomers.shift()!;
          
          // Find the best insertion point to maintain linearity
          const bestInsertionPoint = findBestInsertionPoint(route, customer, distributor, config);
          
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
  
  // Update route metrics for all routes
  routes.forEach(route => {
    updateRouteMetrics(route, distributor, config);
  });
  
  // Reassign beat IDs sequentially
  const finalRoutes = routes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
  
  // Final verification of customer assignment
  const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
  console.log(`Final verification: ${finalCustomerCount}/${allCustomers.length} customers in final routes`);
  console.log(`Total beats created: ${finalRoutes.length} (target was ${config.totalClusters * config.beatsPerCluster})`);
  
  // Report beats per cluster
  const beatsByCluster = finalRoutes.reduce((acc, route) => {
    route.clusterIds.forEach(clusterId => {
      if (!acc[clusterId]) acc[clusterId] = 0;
      acc[clusterId]++;
    });
    return acc;
  }, {} as Record<number, number>);
  
  console.log('Beats per cluster:', beatsByCluster);
  
  if (finalCustomerCount !== allCustomers.length) {
    console.error(`FINAL ERROR: Route generation lost ${allCustomers.length - finalCustomerCount} customers!`);
  }
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Proximity-Optimized Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function createLinearRoutesInCluster(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating linear routes for cluster ${clusterId} with ${customers.length} customers`);
  
  // Step 1: Find the cluster center
  const clusterCenter = findClusterCenter(customers);
  
  // Step 2: Sort customers by angle from cluster center to create directional sweeps
  const customersWithAngles = customers.map(customer => ({
    ...customer,
    angle: calculateAngle(clusterCenter.lat, clusterCenter.lng, customer.latitude, customer.longitude),
    distanceFromCenter: calculateHaversineDistance(
      clusterCenter.lat, clusterCenter.lng,
      customer.latitude, customer.longitude
    )
  }));
  
  // Sort by angle to enable directional sweeping
  customersWithAngles.sort((a, b) => a.angle - b.angle);
  
  // Step 3: Create routes using directional sweeping
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
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
    
    // Calculate how many customers to take for this beat
    const remainingCustomers = customersWithAngles.length;
    const remainingBeats = targetBeats - beatIndex;
    const customersForThisBeat = Math.min(
      Math.ceil(remainingCustomers / remainingBeats),
      config.maxOutletsPerBeat
    );
    
    // Take customers in angular order to create a directional sweep
    const beatCustomers = customersWithAngles.splice(0, customersForThisBeat);
    
    if (beatCustomers.length === 0) continue;
    
    // Step 4: Optimize the order within this directional sweep for minimum distance
    const optimizedOrder = optimizeLinearOrder(beatCustomers, distributor, config);
    
    // Add customers to route in optimized order
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
      routes.push(route);
      console.log(`Created linear beat ${route.salesmanId} with ${route.stops.length} stops in directional sweep`);
    }
  }
  
  return routes;
}

function findClusterCenter(customers: ClusteredCustomer[]): { lat: number; lng: number } {
  const totalLat = customers.reduce((sum, customer) => sum + customer.latitude, 0);
  const totalLng = customers.reduce((sum, customer) => sum + customer.longitude, 0);
  
  return {
    lat: totalLat / customers.length,
    lng: totalLng / customers.length
  };
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
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): ClusteredCustomer[] {
  if (customers.length <= 2) return customers;
  
  // Use a simple nearest neighbor approach starting from the distributor
  const optimized: ClusteredCustomer[] = [];
  const remaining = [...customers];
  
  let currentLat = distributor.latitude;
  let currentLng = distributor.longitude;
  
  while (remaining.length > 0) {
    let nearestIndex = 0;
    let shortestDistance = Infinity;
    
    // Find the nearest unvisited customer
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
    
    // Add the nearest customer to the optimized route
    const nearestCustomer = remaining.splice(nearestIndex, 1)[0];
    optimized.push(nearestCustomer);
    
    // Update current position
    currentLat = nearestCustomer.latitude;
    currentLng = nearestCustomer.longitude;
  }
  
  // Apply 2-opt improvement to reduce crossings and improve linearity
  return apply2OptImprovement(optimized, distributor);
}

function apply2OptImprovement(
  route: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[] {
  if (route.length < 4) return route;
  
  let improved = true;
  let currentRoute = [...route];
  
  while (improved) {
    improved = false;
    
    for (let i = 1; i < currentRoute.length - 2; i++) {
      for (let j = i + 1; j < currentRoute.length; j++) {
        if (j - i === 1) continue; // Skip adjacent edges
        
        // Calculate current distance
        const currentDistance = 
          calculateHaversineDistance(
            i === 1 ? distributor.latitude : currentRoute[i - 1].latitude,
            i === 1 ? distributor.longitude : currentRoute[i - 1].longitude,
            currentRoute[i].latitude, currentRoute[i].longitude
          ) +
          calculateHaversineDistance(
            currentRoute[j - 1].latitude, currentRoute[j - 1].longitude,
            currentRoute[j].latitude, currentRoute[j].longitude
          );
        
        // Calculate distance after 2-opt swap
        const newDistance = 
          calculateHaversineDistance(
            i === 1 ? distributor.latitude : currentRoute[i - 1].latitude,
            i === 1 ? distributor.longitude : currentRoute[i - 1].longitude,
            currentRoute[j - 1].latitude, currentRoute[j - 1].longitude
          ) +
          calculateHaversineDistance(
            currentRoute[i].latitude, currentRoute[i].longitude,
            currentRoute[j].latitude, currentRoute[j].longitude
          );
        
        // If improvement found, apply 2-opt swap
        if (newDistance < currentDistance) {
          // Reverse the segment between i and j-1
          const newRoute = [
            ...currentRoute.slice(0, i),
            ...currentRoute.slice(i, j).reverse(),
            ...currentRoute.slice(j)
          ];
          currentRoute = newRoute;
          improved = true;
        }
      }
    }
  }
  
  return currentRoute;
}

function findBestInsertionPoint(
  route: SalesmanRoute,
  customer: ClusteredCustomer,
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): number {
  if (route.stops.length === 0) return 0;
  
  let bestPosition = route.stops.length;
  let minIncrease = Infinity;
  
  for (let i = 0; i <= route.stops.length; i++) {
    // Calculate the distance increase if we insert at position i
    let increase = 0;
    
    if (i === 0) {
      // Inserting at the beginning
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
      // Inserting at the end
      const lastStop = route.stops[route.stops.length - 1];
      increase = calculateHaversineDistance(
        lastStop.latitude, lastStop.longitude,
        customer.latitude, customer.longitude
      );
    } else {
      // Inserting in the middle
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

function updateRouteMetrics(
  route: SalesmanRoute, 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): void {
  route.totalDistance = 0;
  route.totalTime = 0;
  
  if (route.stops.length === 0) return;
  
  let prevLat = distributor.latitude;
  let prevLng = distributor.longitude;
  
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