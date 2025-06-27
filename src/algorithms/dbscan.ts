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
  console.log(`Target: exactly ${config.totalClusters * config.beatsPerCluster} beats`);
  
  const startTime = Date.now();
  
  try {
    // CRITICAL: Calculate exact target number of beats
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    
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
    
    // Process each cluster independently to ensure exactly beatsPerCluster beats
    for (const clusterId of Object.keys(customersByCluster)) {
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
      console.log(`Target: exactly ${config.beatsPerCluster} beats for this cluster`);
      
      // CRITICAL: Track assigned customers within this cluster only
      const clusterAssignedIds = new Set<string>();
      
      // Create exactly beatsPerCluster beats using DBSCAN-guided distribution
      const clusterRoutes = await createExactDBSCANBeats(
        clusterCustomers,
        distributor,
        config,
        currentSalesmanId,
        Number(clusterId),
        clusterAssignedIds,
        config.beatsPerCluster
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned in ${clusterRoutes.length} beats`);
      
      if (assignedInCluster !== clusterSize) {
        console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
        
        // Find and assign missing customers
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to existing beats
        missingCustomers.forEach(customer => {
          const targetRoute = clusterRoutes.reduce((min, route) => 
            route.stops.length < min.stops.length ? route : min
          );
          
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
            clusterAssignedIds.add(customer.id);
            console.log(`Force-assigned missing customer ${customer.id} to route ${targetRoute.salesmanId}`);
          }
        });
      }
      
      // Verify we have exactly the target number of beats
      if (clusterRoutes.length !== config.beatsPerCluster) {
        console.error(`CRITICAL: Cluster ${clusterId} has ${clusterRoutes.length} beats, expected ${config.beatsPerCluster}`);
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
    console.log(`BEAT COUNT VERIFICATION: ${routes.length}/${TARGET_TOTAL_BEATS} beats created`);
    
    if (finalAssignedCount !== totalCustomers) {
      console.error(`CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
      
      // Emergency assignment of missing customers
      const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
      console.error('Missing customers:', missingCustomers.map(c => c.id));
      
      missingCustomers.forEach(customer => {
        // Find a route in the same cluster with space
        const sameClusterRoutes = routes.filter(route => 
          route.clusterIds.includes(customer.clusterId)
        );
        
        let targetRoute = sameClusterRoutes.reduce((min, route) => 
          route.stops.length < min.stops.length ? route : min
        );
        
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
          
          globalAssignedCustomerIds.add(customer.id);
          console.log(`Emergency assigned customer ${customer.id} to route ${targetRoute.salesmanId}`);
        }
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
    console.log(`- Target beats: ${TARGET_TOTAL_BEATS}`);
    
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
    
    if (finalRoutes.length !== TARGET_TOTAL_BEATS) {
      console.error(`BEAT COUNT ERROR: Expected ${TARGET_TOTAL_BEATS} beats, got ${finalRoutes.length}`);
    }
    
    // Calculate total distance
    const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    return {
      name: `DBSCAN Beat Formation (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
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

async function createExactDBSCANBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  if (customers.length === 0) {
    // Create empty beats to maintain exact count
    const emptyRoutes: SalesmanRoute[] = [];
    for (let i = 0; i < targetBeats; i++) {
      emptyRoutes.push({
        salesmanId: startingSalesmanId + i,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [clusterId],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      });
    }
    return emptyRoutes;
  }
  
  console.log(`Creating exactly ${targetBeats} DBSCAN-based beats for cluster ${clusterId} with ${customers.length} customers`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  // Step 1: Apply DBSCAN to find natural dense groups
  const EPS = 0.5; // 500 meters in kilometers (changed from 0.2)
  const MIN_PTS = Math.max(2, Math.floor(config.minOutletsPerBeat * 0.4)); // Flexible minimum
  
  const dbscanClusters = await performOptimizedDBSCAN(remainingCustomers, EPS, MIN_PTS);
  console.log(`DBSCAN found ${dbscanClusters.length} natural clusters in cluster ${clusterId} (using 500m radius)`);
  
  // Step 2: Create exactly targetBeats number of beats
  for (let beatIndex = 0; beatIndex < targetBeats; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    routes.push(route);
  }
  
  // Step 3: Distribute DBSCAN clusters to beats intelligently
  let beatIndex = 0;
  
  for (const dbscanCluster of dbscanClusters) {
    if (dbscanCluster.length <= config.maxOutletsPerBeat) {
      // Assign entire DBSCAN cluster to one beat
      const targetRoute = routes[beatIndex % targetBeats];
      
      dbscanCluster.forEach(customer => {
        if (!assignedIds.has(customer.id)) {
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
          assignedIds.add(customer.id);
        }
      });
      
      beatIndex++;
    } else {
      // Split large DBSCAN cluster across multiple beats
      const chunks = splitClusterIntoChunks(dbscanCluster, config.maxOutletsPerBeat);
      
      chunks.forEach(chunk => {
        const targetRoute = routes[beatIndex % targetBeats];
        
        chunk.forEach(customer => {
          if (!assignedIds.has(customer.id)) {
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
            assignedIds.add(customer.id);
          }
        });
        
        beatIndex++;
      });
    }
  }
  
  // Step 4: Handle any remaining unassigned customers
  const stillUnassigned = remainingCustomers.filter(c => !assignedIds.has(c.id));
  if (stillUnassigned.length > 0) {
    console.log(`Distributing ${stillUnassigned.length} remaining customers across ${targetBeats} beats`);
    
    stillUnassigned.forEach((customer, index) => {
      const targetRoute = routes[index % targetBeats];
      
      if (targetRoute.stops.length < config.maxOutletsPerBeat) {
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
        assignedIds.add(customer.id);
      }
    });
  }
  
  // Step 5: Balance beats to ensure reasonable distribution
  balanceBeatsWithinCluster(routes, config);
  
  console.log(`Cluster ${clusterId}: Created exactly ${routes.length} beats as required`);
  console.log(`Beat sizes: ${routes.map(r => r.stops.length).join(', ')}`);
  
  return routes;
}

async function performOptimizedDBSCAN(
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number
): Promise<ClusteredCustomer[][]> {
  const clusters: ClusteredCustomer[][] = [];
  const visited = new Set<string>();
  const processed = new Set<string>();
  
  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    
    if (visited.has(customer.id) || processed.has(customer.id)) continue;
    
    visited.add(customer.id);
    const neighbors = getNeighborsEfficient(customer, customers, eps, processed);
    
    if (neighbors.length < minPts) {
      // Mark as noise but continue
      continue;
    } else {
      const cluster: ClusteredCustomer[] = [];
      expandClusterEfficient(customer, neighbors, cluster, visited, customers, eps, minPts, processed);
      if (cluster.length > 0) {
        clusters.push(cluster);
        // Mark all cluster members as processed
        cluster.forEach(c => processed.add(c.id));
      }
    }
    
    // Yield control every 25 customers
    if (i % 25 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Handle remaining unprocessed customers as individual clusters
  const unprocessedCustomers = customers.filter(c => !processed.has(c.id));
  if (unprocessedCustomers.length > 0) {
    // Group remaining customers by simple proximity
    const remainingClusters = groupRemainingByProximity(unprocessedCustomers, eps);
    clusters.push(...remainingClusters);
  }
  
  return clusters;
}

function getNeighborsEfficient(
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

function expandClusterEfficient(
  customer: ClusteredCustomer,
  neighbors: ClusteredCustomer[],
  cluster: ClusteredCustomer[],
  visited: Set<string>,
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number,
  processed: Set<string>
): void {
  cluster.push(customer);
  processed.add(customer.id);
  
  // Limit expansion to prevent excessive processing
  const maxExpansion = Math.min(neighbors.length, 100);
  
  for (let i = 0; i < maxExpansion; i++) {
    const neighbor = neighbors[i];
    
    if (!visited.has(neighbor.id)) {
      visited.add(neighbor.id);
      
      const neighborNeighbors = getNeighborsEfficient(neighbor, customers, eps, processed);
      
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

function groupRemainingByProximity(
  customers: ClusteredCustomer[],
  eps: number
): ClusteredCustomer[][] {
  const groups: ClusteredCustomer[][] = [];
  const remaining = [...customers];
  
  while (remaining.length > 0) {
    const group = [remaining.shift()!];
    
    // Find nearby customers to add to this group
    for (let i = remaining.length - 1; i >= 0; i--) {
      const customer = remaining[i];
      const isNearby = group.some(groupMember => {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          groupMember.latitude, groupMember.longitude
        );
        return distance <= eps * 1.2; // Allow some flexibility
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

function splitClusterIntoChunks(
  cluster: ClusteredCustomer[],
  maxSize: number
): ClusteredCustomer[][] {
  if (cluster.length <= maxSize) return [cluster];
  
  const chunks: ClusteredCustomer[][] = [];
  const remaining = [...cluster];
  
  while (remaining.length > 0) {
    const chunkSize = Math.min(maxSize, remaining.length);
    const chunk = remaining.splice(0, chunkSize);
    chunks.push(chunk);
  }
  
  return chunks;
}

function balanceBeatsWithinCluster(routes: SalesmanRoute[], config: ClusteringConfig): void {
  // Simple balancing: move customers from oversized beats to undersized beats
  let balanceIterations = 0;
  const maxBalanceIterations = 5;
  
  while (balanceIterations < maxBalanceIterations) {
    let balancesMade = false;
    
    // Find oversized and undersized beats
    const oversizedBeats = routes.filter(route => route.stops.length > config.maxOutletsPerBeat);
    const undersizedBeats = routes.filter(route => route.stops.length < config.minOutletsPerBeat);
    
    if (oversizedBeats.length === 0 || undersizedBeats.length === 0) break;
    
    // Move customers from oversized to undersized beats
    oversizedBeats.forEach(oversizedBeat => {
      while (oversizedBeat.stops.length > config.maxOutletsPerBeat && undersizedBeats.length > 0) {
        const targetBeat = undersizedBeats.find(beat => beat.stops.length < config.maxOutletsPerBeat);
        if (!targetBeat) break;
        
        // Move one customer
        const customerToMove = oversizedBeat.stops.pop();
        if (customerToMove) {
          targetBeat.stops.push(customerToMove);
          balancesMade = true;
          
          // Update undersized beats list
          if (targetBeat.stops.length >= config.minOutletsPerBeat) {
            const index = undersizedBeats.indexOf(targetBeat);
            if (index !== -1) undersizedBeats.splice(index, 1);
          }
        }
      }
    });
    
    if (!balancesMade) break;
    balanceIterations++;
  }
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