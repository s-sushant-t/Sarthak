import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const dbscan = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting DBSCAN-based beat formation with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`DBSCAN parameters: 200m radius, minimum ${config.minOutletsPerBeat} outlets per beat`);
  
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
  
  const routes: SalesmanRoute[] = [];
  let currentSalesmanId = 1;
  
  // Process each cluster independently using DBSCAN
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers using DBSCAN`);
    console.log(`Target: ${config.beatsPerCluster} beats for this cluster`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create DBSCAN-based beats within the cluster
    const clusterRoutes = createDBSCANBasedBeats(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned`);
    
    if (assignedInCluster !== clusterSize) {
      console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
      
      // Find and assign missing customers
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
      
      // Force assign missing customers to the route with the least customers
      missingCustomers.forEach(customer => {
        const targetRoute = clusterRoutes.reduce((min, route) => 
          route.stops.length < min.stops.length ? route : min
        );
        
        if (targetRoute && targetRoute.stops.length < config.maxOutletsPerBeat) {
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
        }
      });
    }
    
    // Add cluster customers to global tracking
    clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
    
    routes.push(...clusterRoutes);
    currentSalesmanId += clusterRoutes.length;
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} DBSCAN-based beats created`);
  }
  
  // CRITICAL: Final verification - ensure ALL customers are assigned exactly once
  const finalAssignedCount = globalAssignedCustomerIds.size;
  const totalCustomers = allCustomers.length;
  
  console.log(`GLOBAL VERIFICATION: ${finalAssignedCount}/${totalCustomers} customers assigned`);
  
  if (finalAssignedCount !== totalCustomers) {
    console.error(`CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
    
    // Emergency assignment of missing customers
    const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
    console.error('Missing customers:', missingCustomers.map(c => c.id));
    
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
  
  // Update route metrics for all routes
  routes.forEach(route => {
    updateRouteMetrics(route, distributor, config);
  });
  
  // Reassign beat IDs sequentially
  const finalRoutes = routes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
  
  // FINAL verification
  const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(finalRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`FINAL VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  console.log(`- Total beats created: ${finalRoutes.length}`);
  
  // Report beats per cluster
  const beatsByCluster = finalRoutes.reduce((acc, route) => {
    route.clusterIds.forEach(clusterId => {
      if (!acc[clusterId]) acc[clusterId] = 0;
      acc[clusterId]++;
    });
    return acc;
  }, {} as Record<number, number>);
  
  console.log('Beats per cluster:', beatsByCluster);
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`FINAL ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `DBSCAN-Based Beat Formation (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function createDBSCANBasedBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating DBSCAN-based beats for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`DBSCAN parameters: eps=0.2km (200m), minPts=${config.minOutletsPerBeat}`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // DBSCAN parameters
  const EPS = 0.2; // 200 meters in kilometers
  const MIN_PTS = Math.max(3, Math.floor(config.minOutletsPerBeat * 0.7)); // Minimum points for a cluster
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Apply DBSCAN clustering to find dense groups
  const dbscanClusters = performDBSCAN(remainingCustomers, EPS, MIN_PTS);
  
  console.log(`DBSCAN found ${dbscanClusters.length} dense clusters in cluster ${clusterId}`);
  
  // Process each DBSCAN cluster to create beats
  dbscanClusters.forEach((dbscanCluster, index) => {
    console.log(`Processing DBSCAN cluster ${index} with ${dbscanCluster.length} customers`);
    
    // If the DBSCAN cluster is too large, split it into multiple beats
    if (dbscanCluster.length > config.maxOutletsPerBeat) {
      const subBeats = splitLargeCluster(dbscanCluster, config.maxOutletsPerBeat, distributor);
      subBeats.forEach(subBeat => {
        const route = createRouteFromCustomers(subBeat, salesmanId++, clusterId, distributor, config, assignedIds);
        if (route) routes.push(route);
      });
    } else if (dbscanCluster.length >= config.minOutletsPerBeat) {
      // Create a single beat from this DBSCAN cluster
      const route = createRouteFromCustomers(dbscanCluster, salesmanId++, clusterId, distributor, config, assignedIds);
      if (route) routes.push(route);
    } else {
      // Small cluster - try to merge with nearby clusters or create a separate beat
      const route = createRouteFromCustomers(dbscanCluster, salesmanId++, clusterId, distributor, config, assignedIds);
      if (route) routes.push(route);
    }
  });
  
  // Handle any remaining unassigned customers
  const unassignedCustomers = remainingCustomers.filter(c => !assignedIds.has(c.id));
  if (unassignedCustomers.length > 0) {
    console.log(`Handling ${unassignedCustomers.length} unassigned customers in cluster ${clusterId}`);
    
    // Try to assign to existing routes first
    unassignedCustomers.forEach(customer => {
      if (assignedIds.has(customer.id)) return;
      
      // Find the nearest route with space
      let bestRoute = null;
      let minDistance = Infinity;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat) {
          // Calculate average distance to this route's customers
          const avgDistance = route.stops.reduce((sum, stop) => {
            return sum + calculateHaversineDistance(
              customer.latitude, customer.longitude,
              stop.latitude, stop.longitude
            );
          }, 0) / route.stops.length;
          
          if (avgDistance < minDistance && avgDistance <= EPS * 2) { // Allow some flexibility
            minDistance = avgDistance;
            bestRoute = route;
          }
        }
      }
      
      if (bestRoute) {
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
        console.log(`Assigned unassigned customer ${customer.id} to existing route ${bestRoute.salesmanId}`);
      } else {
        // Create a new route for remaining customers
        const newRoute = createRouteFromCustomers([customer], salesmanId++, clusterId, distributor, config, assignedIds);
        if (newRoute) routes.push(newRoute);
      }
    });
  }
  
  return routes;
}

function performDBSCAN(
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number
): ClusteredCustomer[][] {
  const clusters: ClusteredCustomer[][] = [];
  const visited = new Set<string>();
  const noise = new Set<string>();
  
  for (const customer of customers) {
    if (visited.has(customer.id)) continue;
    
    visited.add(customer.id);
    const neighbors = getNeighbors(customer, customers, eps);
    
    if (neighbors.length < minPts) {
      noise.add(customer.id);
    } else {
      const cluster: ClusteredCustomer[] = [];
      expandCluster(customer, neighbors, cluster, visited, customers, eps, minPts);
      if (cluster.length > 0) {
        clusters.push(cluster);
      }
    }
  }
  
  // Handle noise points by creating small clusters or assigning to nearest cluster
  const noiseCustomers = customers.filter(c => noise.has(c.id));
  if (noiseCustomers.length > 0) {
    // Group noise points that are close to each other
    const noiseGroups = groupNoisePoints(noiseCustomers, eps);
    clusters.push(...noiseGroups);
  }
  
  return clusters;
}

function getNeighbors(
  customer: ClusteredCustomer,
  customers: ClusteredCustomer[],
  eps: number
): ClusteredCustomer[] {
  const neighbors: ClusteredCustomer[] = [];
  
  for (const other of customers) {
    if (customer.id !== other.id) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        other.latitude, other.longitude
      );
      
      if (distance <= eps) {
        neighbors.push(other);
      }
    }
  }
  
  return neighbors;
}

function expandCluster(
  customer: ClusteredCustomer,
  neighbors: ClusteredCustomer[],
  cluster: ClusteredCustomer[],
  visited: Set<string>,
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number
): void {
  cluster.push(customer);
  
  for (let i = 0; i < neighbors.length; i++) {
    const neighbor = neighbors[i];
    
    if (!visited.has(neighbor.id)) {
      visited.add(neighbor.id);
      const neighborNeighbors = getNeighbors(neighbor, customers, eps);
      
      if (neighborNeighbors.length >= minPts) {
        neighbors.push(...neighborNeighbors.filter(n => !neighbors.some(existing => existing.id === n.id)));
      }
    }
    
    if (!cluster.some(c => c.id === neighbor.id)) {
      cluster.push(neighbor);
    }
  }
}

function groupNoisePoints(
  noiseCustomers: ClusteredCustomer[],
  eps: number
): ClusteredCustomer[][] {
  const groups: ClusteredCustomer[][] = [];
  const processed = new Set<string>();
  
  for (const customer of noiseCustomers) {
    if (processed.has(customer.id)) continue;
    
    const group = [customer];
    processed.add(customer.id);
    
    // Find other noise points within eps distance
    for (const other of noiseCustomers) {
      if (processed.has(other.id)) continue;
      
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        other.latitude, other.longitude
      );
      
      if (distance <= eps) {
        group.push(other);
        processed.add(other.id);
      }
    }
    
    groups.push(group);
  }
  
  return groups;
}

function splitLargeCluster(
  cluster: ClusteredCustomer[],
  maxSize: number,
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[][] {
  if (cluster.length <= maxSize) return [cluster];
  
  const subClusters: ClusteredCustomer[][] = [];
  const remaining = [...cluster];
  
  while (remaining.length > 0) {
    const subCluster: ClusteredCustomer[] = [];
    
    // Start with the customer closest to distributor
    let startCustomer = remaining.reduce((closest, customer) => {
      const distToDistributor = calculateHaversineDistance(
        distributor.latitude, distributor.longitude,
        customer.latitude, customer.longitude
      );
      const closestDistToDistributor = calculateHaversineDistance(
        distributor.latitude, distributor.longitude,
        closest.latitude, closest.longitude
      );
      
      return distToDistributor < closestDistToDistributor ? customer : closest;
    });
    
    subCluster.push(startCustomer);
    remaining.splice(remaining.indexOf(startCustomer), 1);
    
    // Add nearest customers to this sub-cluster
    while (subCluster.length < maxSize && remaining.length > 0) {
      let nearestCustomer = null;
      let minDistance = Infinity;
      
      for (const customer of remaining) {
        // Find minimum distance to any customer in the current sub-cluster
        const minDistToCluster = Math.min(...subCluster.map(sc => 
          calculateHaversineDistance(
            customer.latitude, customer.longitude,
            sc.latitude, sc.longitude
          )
        ));
        
        if (minDistToCluster < minDistance) {
          minDistance = minDistToCluster;
          nearestCustomer = customer;
        }
      }
      
      if (nearestCustomer) {
        subCluster.push(nearestCustomer);
        remaining.splice(remaining.indexOf(nearestCustomer), 1);
      } else {
        break;
      }
    }
    
    subClusters.push(subCluster);
  }
  
  return subClusters;
}

function createRouteFromCustomers(
  customers: ClusteredCustomer[],
  salesmanId: number,
  clusterId: number,
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>
): SalesmanRoute | null {
  if (customers.length === 0) return null;
  
  const route: SalesmanRoute = {
    salesmanId,
    stops: [],
    totalDistance: 0,
    totalTime: 0,
    clusterIds: [clusterId],
    distributorLat: distributor.latitude,
    distributorLng: distributor.longitude
  };
  
  // Optimize the order of customers using nearest neighbor from distributor
  const optimizedOrder = optimizeCustomerOrder(customers, distributor);
  
  optimizedOrder.forEach(customer => {
    if (!assignedIds.has(customer.id)) {
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
      assignedIds.add(customer.id);
    }
  });
  
  return route.stops.length > 0 ? route : null;
}

function optimizeCustomerOrder(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[] {
  if (customers.length <= 1) return customers;
  
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