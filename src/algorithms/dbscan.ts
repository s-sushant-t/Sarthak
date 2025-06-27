import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const dbscan = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting optimized DBSCAN-based beat formation with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`DBSCAN parameters: 200m radius, minimum ${config.minOutletsPerBeat} outlets per beat`);
  
  const startTime = Date.now();
  
  try {
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
    
    // Process each cluster independently using optimized DBSCAN
    for (const clusterId of Object.keys(customersByCluster)) {
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers using optimized DBSCAN`);
      
      // CRITICAL: Track assigned customers within this cluster only
      const clusterAssignedIds = new Set<string>();
      
      // Create DBSCAN-based beats within the cluster
      const clusterRoutes = await createOptimizedDBSCANBeats(
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
      
      // Yield control to prevent blocking
      await new Promise(resolve => setTimeout(resolve, 0));
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
      processingTime: Date.now() - startTime,
      routes: finalRoutes
    };
    
  } catch (error) {
    console.error('DBSCAN algorithm failed:', error);
    throw error; // Re-throw to let the caller handle fallback
  }
};

async function createOptimizedDBSCANBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>
): Promise<SalesmanRoute[]> {
  if (customers.length === 0) return [];
  
  console.log(`Creating optimized DBSCAN-based beats for cluster ${clusterId} with ${customers.length} customers`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Optimized DBSCAN parameters
  const EPS = 0.2; // 200 meters in kilometers
  const MIN_PTS = Math.max(2, Math.floor(config.minOutletsPerBeat * 0.3)); // More flexible minimum
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Apply fast DBSCAN clustering to find dense groups
  const dbscanClusters = performFastDBSCAN(remainingCustomers, EPS, MIN_PTS);
  
  console.log(`Fast DBSCAN found ${dbscanClusters.length} dense clusters in cluster ${clusterId}`);
  
  // Process each DBSCAN cluster to create beats
  for (let index = 0; index < dbscanClusters.length; index++) {
    const dbscanCluster = dbscanClusters[index];
    console.log(`Processing DBSCAN cluster ${index} with ${dbscanCluster.length} customers`);
    
    // If the DBSCAN cluster is too large, split it into multiple beats
    if (dbscanCluster.length > config.maxOutletsPerBeat) {
      const subBeats = splitLargeClusterEfficiently(dbscanCluster, config.maxOutletsPerBeat);
      subBeats.forEach(subBeat => {
        const route = createRouteFromCustomers(subBeat, salesmanId++, clusterId, distributor, config, assignedIds);
        if (route) routes.push(route);
      });
    } else if (dbscanCluster.length >= 1) { // Accept any size cluster
      // Create a single beat from this DBSCAN cluster
      const route = createRouteFromCustomers(dbscanCluster, salesmanId++, clusterId, distributor, config, assignedIds);
      if (route) routes.push(route);
    }
    
    // Yield control periodically
    if (index % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Handle any remaining unassigned customers efficiently
  const unassignedCustomers = remainingCustomers.filter(c => !assignedIds.has(c.id));
  if (unassignedCustomers.length > 0) {
    console.log(`Handling ${unassignedCustomers.length} unassigned customers in cluster ${clusterId}`);
    
    // Group remaining customers into beats efficiently
    while (unassignedCustomers.length > 0) {
      const batchSize = Math.min(config.maxOutletsPerBeat, unassignedCustomers.length);
      const batch = unassignedCustomers.splice(0, batchSize);
      
      const route = createRouteFromCustomers(batch, salesmanId++, clusterId, distributor, config, assignedIds);
      if (route) routes.push(route);
      
      // Yield control
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  return routes;
}

function performFastDBSCAN(
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number
): ClusteredCustomer[][] {
  const clusters: ClusteredCustomer[][] = [];
  const visited = new Set<string>();
  const processed = new Set<string>();
  
  // Pre-compute distance matrix for small datasets, use spatial indexing for large ones
  const useDistanceMatrix = customers.length <= 100;
  let distanceMatrix: number[][] = [];
  
  if (useDistanceMatrix) {
    distanceMatrix = precomputeDistanceMatrix(customers);
  }
  
  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    
    if (visited.has(customer.id) || processed.has(customer.id)) continue;
    
    visited.add(customer.id);
    const neighbors = useDistanceMatrix 
      ? getNeighborsFromMatrix(i, customers, distanceMatrix, eps, processed)
      : getNeighborsFast(customer, customers, eps, processed);
    
    if (neighbors.length < minPts) {
      // Mark as noise but continue
      continue;
    } else {
      const cluster: ClusteredCustomer[] = [];
      expandClusterFast(customer, neighbors, cluster, visited, customers, eps, minPts, processed, useDistanceMatrix, distanceMatrix);
      if (cluster.length > 0) {
        clusters.push(cluster);
        // Mark all cluster members as processed
        cluster.forEach(c => processed.add(c.id));
      }
    }
    
    // Yield control every 50 customers
    if (i % 50 === 0) {
      // Use setTimeout with 0 delay to yield control
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Handle remaining unprocessed customers efficiently
  const unprocessedCustomers = customers.filter(c => !processed.has(c.id));
  if (unprocessedCustomers.length > 0) {
    // Group remaining customers by proximity
    const remainingClusters = groupRemainingCustomersEfficiently(unprocessedCustomers, eps);
    clusters.push(...remainingClusters);
  }
  
  return clusters;
}

function precomputeDistanceMatrix(customers: ClusteredCustomer[]): number[][] {
  const n = customers.length;
  const matrix: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
  
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const distance = calculateHaversineDistance(
        customers[i].latitude, customers[i].longitude,
        customers[j].latitude, customers[j].longitude
      );
      matrix[i][j] = distance;
      matrix[j][i] = distance;
    }
  }
  
  return matrix;
}

function getNeighborsFromMatrix(
  customerIndex: number,
  customers: ClusteredCustomer[],
  distanceMatrix: number[][],
  eps: number,
  processed: Set<string>
): ClusteredCustomer[] {
  const neighbors: ClusteredCustomer[] = [];
  
  for (let i = 0; i < customers.length; i++) {
    if (i !== customerIndex && !processed.has(customers[i].id)) {
      if (distanceMatrix[customerIndex][i] <= eps) {
        neighbors.push(customers[i]);
      }
    }
  }
  
  return neighbors;
}

function getNeighborsFast(
  customer: ClusteredCustomer,
  customers: ClusteredCustomer[],
  eps: number,
  processed: Set<string>
): ClusteredCustomer[] {
  const neighbors: ClusteredCustomer[] = [];
  
  // Use spatial filtering to reduce distance calculations
  const latRange = eps / 111; // Approximate degrees per km for latitude
  const lngRange = eps / (111 * Math.cos(customer.latitude * Math.PI / 180)); // Adjust for longitude
  
  for (const other of customers) {
    if (customer.id !== other.id && !processed.has(other.id)) {
      // Quick spatial filter
      if (Math.abs(other.latitude - customer.latitude) <= latRange &&
          Math.abs(other.longitude - customer.longitude) <= lngRange) {
        
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          other.latitude, other.longitude
        );
        
        if (distance <= eps) {
          neighbors.push(other);
        }
      }
    }
  }
  
  return neighbors;
}

function expandClusterFast(
  customer: ClusteredCustomer,
  neighbors: ClusteredCustomer[],
  cluster: ClusteredCustomer[],
  visited: Set<string>,
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number,
  processed: Set<string>,
  useDistanceMatrix: boolean,
  distanceMatrix: number[][]
): void {
  cluster.push(customer);
  processed.add(customer.id);
  
  // Limit expansion to prevent excessive processing
  const maxExpansion = Math.min(neighbors.length, 200);
  
  for (let i = 0; i < Math.min(neighbors.length, maxExpansion); i++) {
    const neighbor = neighbors[i];
    
    if (!visited.has(neighbor.id)) {
      visited.add(neighbor.id);
      
      const neighborIndex = customers.findIndex(c => c.id === neighbor.id);
      const neighborNeighbors = useDistanceMatrix && neighborIndex !== -1
        ? getNeighborsFromMatrix(neighborIndex, customers, distanceMatrix, eps, processed)
        : getNeighborsFast(neighbor, customers, eps, processed);
      
      if (neighborNeighbors.length >= minPts) {
        // Add only new neighbors to prevent duplicates
        neighborNeighbors.forEach(nn => {
          if (!neighbors.some(existing => existing.id === nn.id)) {
            neighbors.push(nn);
          }
        });
      }
    }
    
    if (!cluster.some(c => c.id === neighbor.id) && !processed.has(neighbor.id)) {
      cluster.push(neighbor);
      processed.add(neighbor.id);
    }
  }
}

function groupRemainingCustomersEfficiently(
  customers: ClusteredCustomer[],
  eps: number
): ClusteredCustomer[][] {
  const groups: ClusteredCustomer[][] = [];
  const remaining = [...customers];
  
  while (remaining.length > 0) {
    const group = [remaining.shift()!];
    
    // Find nearby customers to add to this group (limited search)
    for (let i = remaining.length - 1; i >= 0 && group.length < 50; i--) {
      const customer = remaining[i];
      const isNearby = group.some(groupMember => {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          groupMember.latitude, groupMember.longitude
        );
        return distance <= eps * 1.5; // Allow some flexibility
      });
      
      if (isNearby) {
        group.push(customer);
        remaining.splice(i, 1);
      }
    }
    
    groups.push(group);
  }
  
  return groups;
}

function splitLargeClusterEfficiently(
  cluster: ClusteredCustomer[],
  maxSize: number
): ClusteredCustomer[][] {
  if (cluster.length <= maxSize) return [cluster];
  
  const subClusters: ClusteredCustomer[][] = [];
  const remaining = [...cluster];
  
  // Simple but effective chunking
  while (remaining.length > 0) {
    const chunkSize = Math.min(maxSize, remaining.length);
    const chunk = remaining.splice(0, chunkSize);
    subClusters.push(chunk);
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
  
  // Add customers to route
  customers.forEach(customer => {
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