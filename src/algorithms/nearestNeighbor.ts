import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting nearest neighbor algorithm with ${customers.length} total customers`);
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
    
    // Calculate optimal outlets per beat for this cluster
    const outletsPerBeat = Math.ceil(clusterSize / config.beatsPerCluster);
    console.log(`Target outlets per beat in cluster ${clusterId}: ${outletsPerBeat}`);
    
    let beatsCreatedInCluster = 0;
    
    while (clusterCustomers.length > 0 && beatsCreatedInCluster < config.beatsPerCluster) {
      const currentRoute: SalesmanRoute = {
        salesmanId: currentSalesmanId++,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [Number(clusterId)],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      };
      
      let currentLat = distributor.latitude;
      let currentLng = distributor.longitude;
      let remainingTime = config.maxWorkingTimeMinutes;
      
      // Calculate target outlets for this specific beat
      const remainingOutlets = clusterCustomers.length;
      const remainingBeats = config.beatsPerCluster - beatsCreatedInCluster;
      let targetOutlets = Math.ceil(remainingOutlets / remainingBeats);
      
      // Ensure we don't exceed max outlets per beat
      targetOutlets = Math.min(targetOutlets, config.maxOutletsPerBeat);
      
      console.log(`Beat ${currentRoute.salesmanId}: targeting ${targetOutlets} outlets (${remainingOutlets} remaining, ${remainingBeats} beats left)`);
      
      while (clusterCustomers.length > 0 && 
             remainingTime > 0 && 
             currentRoute.stops.length < targetOutlets) {
        let nearestIndex = -1;
        let shortestDistance = Infinity;
        
        for (let i = 0; i < clusterCustomers.length; i++) {
          const customer = clusterCustomers[i];
          const distance = calculateHaversineDistance(
            currentLat, currentLng,
            customer.latitude, customer.longitude
          );
          
          const travelTime = calculateTravelTime(distance, config.travelSpeedKmh);
          if (travelTime + config.customerVisitTimeMinutes > remainingTime) continue;
          
          if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestIndex = i;
          }
        }
        
        if (nearestIndex === -1) break;
        
        const nearestCustomer = clusterCustomers.splice(nearestIndex, 1)[0];
        const travelTime = calculateTravelTime(shortestDistance, config.travelSpeedKmh);
        
        // Track that this customer has been assigned
        assignedCustomerIds.add(nearestCustomer.id);
        
        currentRoute.stops.push({
          customerId: nearestCustomer.id,
          latitude: nearestCustomer.latitude,
          longitude: nearestCustomer.longitude,
          distanceToNext: 0,
          timeToNext: 0,
          visitTime: config.customerVisitTimeMinutes,
          clusterId: nearestCustomer.clusterId,
          outletName: nearestCustomer.outletName
        });
        
        currentRoute.totalDistance += shortestDistance;
        currentRoute.totalTime += travelTime + config.customerVisitTimeMinutes;
        remainingTime -= (travelTime + config.customerVisitTimeMinutes);
        
        currentLat = nearestCustomer.latitude;
        currentLng = nearestCustomer.longitude;
      }
      
      if (currentRoute.stops.length > 0) {
        routes.push(currentRoute);
        beatsCreatedInCluster++;
        console.log(`Created beat ${currentRoute.salesmanId} in cluster ${clusterId} with ${currentRoute.stops.length} stops`);
      }
    }
    
    // If we have remaining customers in this cluster and haven't reached target beats
    if (clusterCustomers.length > 0) {
      console.log(`Cluster ${clusterId}: ${clusterCustomers.length} customers remaining, distributing to existing beats...`);
      
      // Distribute remaining customers to existing beats in this cluster
      const clusterRoutes = routes.filter(route => route.clusterIds.includes(Number(clusterId)));
      
      clusterCustomers.forEach(customer => {
        // Find the beat with the least customers that can accommodate one more
        const targetRoute = clusterRoutes
          .filter(route => route.stops.length < config.maxOutletsPerBeat)
          .sort((a, b) => a.stops.length - b.stops.length)[0];
        
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
          
          assignedCustomerIds.add(customer.id);
          console.log(`Added remaining customer ${customer.id} to beat ${targetRoute.salesmanId}`);
        }
      });
    }
    
    console.log(`Cluster ${clusterId} complete: ${beatsCreatedInCluster} beats created`);
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
  
  // Final verification: ensure all customers are assigned
  const finalAssignedCount = assignedCustomerIds.size;
  const totalCustomers = allCustomers.length;
  
  console.log(`Assignment verification: ${finalAssignedCount}/${totalCustomers} customers assigned`);
  
  if (finalAssignedCount !== totalCustomers) {
    console.error(`CRITICAL: Missing ${totalCustomers - finalAssignedCount} customers in route assignment!`);
    
    // Emergency fallback: find missing customers and force assign them
    const missingCustomers = allCustomers.filter(customer => !assignedCustomerIds.has(customer.id));
    console.error('Missing customers:', missingCustomers.map(c => c.id));
    
    // Add missing customers to the last route or create a new one
    if (missingCustomers.length > 0) {
      let targetRoute = routes[routes.length - 1];
      
      if (!targetRoute || targetRoute.stops.length >= config.maxOutletsPerBeat) {
        targetRoute = {
          salesmanId: currentSalesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        routes.push(targetRoute);
      }
      
      missingCustomers.forEach(customer => {
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
        
        if (!targetRoute.clusterIds.includes(customer.clusterId)) {
          targetRoute.clusterIds.push(customer.clusterId);
        }
      });
      
      console.log(`Emergency assignment: Added ${missingCustomers.length} missing customers to route ${targetRoute.salesmanId}`);
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
  console.log(`Final verification: ${finalCustomerCount}/${totalCustomers} customers in final routes`);
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
  
  if (finalCustomerCount !== totalCustomers) {
    console.error(`FINAL ERROR: Route generation lost ${totalCustomers - finalCustomerCount} customers!`);
  }
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

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