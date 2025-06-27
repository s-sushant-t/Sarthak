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
  
  // Add timeout mechanism
  const startTime = Date.now();
  const TIMEOUT_MS = 30000; // 30 seconds timeout
  
  const checkTimeout = () => {
    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('DBSCAN algorithm timeout - falling back to simpler approach');
    }
  };
  
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
    
    // Process each cluster independently using DBSCAN
    for (const clusterId of Object.keys(customersByCluster)) {
      checkTimeout(); // Check timeout before processing each cluster
      
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers using DBSCAN`);
      
      // CRITICAL: Track assigned customers within this cluster only
      const clusterAssignedIds = new Set<string>();
      
      // Create DBSCAN-based beats within the cluster with timeout checking
      const clusterRoutes = await createDBSCANBasedBeatsWithMinimumSize(
        clusterCustomers,
        distributor,
        config,
        currentSalesmanId,
        Number(clusterId),
        clusterAssignedIds,
        checkTimeout
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
      processingTime: Date.now() - startTime,
      routes: finalRoutes
    };
    
  } catch (error) {
    console.error('DBSCAN algorithm failed:', error);
    // Fallback to simple nearest neighbor approach
    return createFallbackSolution(locationData, config);
  }
};

async function createDBSCANBasedBeatsWithMinimumSize(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  checkTimeout: () => void
): Promise<SalesmanRoute[]> {
  if (customers.length === 0) return [];
  
  console.log(`Creating DBSCAN-based beats for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`Minimum outlets per beat: ${config.minOutletsPerBeat}, Maximum: ${config.maxOutletsPerBeat}`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // DBSCAN parameters - optimized for performance
  const EPS = 0.2; // 200 meters in kilometers
  const MIN_PTS = Math.max(3, Math.floor(config.minOutletsPerBeat * 0.5)); // Reduced for performance
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  try {
    // Apply simplified DBSCAN clustering to find dense groups
    const dbscanClusters = performOptimizedDBSCAN(remainingCustomers, EPS, MIN_PTS, checkTimeout);
    
    console.log(`DBSCAN found ${dbscanClusters.length} dense clusters in cluster ${clusterId}`);
    
    // Process each DBSCAN cluster to create initial beats
    const initialBeats: SalesmanRoute[] = [];
    
    for (let index = 0; index < dbscanClusters.length; index++) {
      checkTimeout(); // Check timeout during processing
      
      const dbscanCluster = dbscanClusters[index];
      console.log(`Processing DBSCAN cluster ${index} with ${dbscanCluster.length} customers`);
      
      // If the DBSCAN cluster is too large, split it into multiple beats
      if (dbscanCluster.length > config.maxOutletsPerBeat) {
        const subBeats = splitLargeClusterOptimized(dbscanCluster, config.maxOutletsPerBeat, distributor);
        subBeats.forEach(subBeat => {
          const route = createRouteFromCustomers(subBeat, salesmanId++, clusterId, distributor, config, assignedIds);
          if (route) initialBeats.push(route);
        });
      } else {
        // Create a beat from this DBSCAN cluster (regardless of size for now)
        const route = createRouteFromCustomers(dbscanCluster, salesmanId++, clusterId, distributor, config, assignedIds);
        if (route) initialBeats.push(route);
      }
    }
    
    // Handle any remaining unassigned customers
    const unassignedCustomers = remainingCustomers.filter(c => !assignedIds.has(c.id));
    if (unassignedCustomers.length > 0) {
      console.log(`Handling ${unassignedCustomers.length} unassigned customers in cluster ${clusterId}`);
      
      // Group remaining customers into beats
      while (unassignedCustomers.length > 0) {
        checkTimeout();
        
        const batchSize = Math.min(config.maxOutletsPerBeat, unassignedCustomers.length);
        const batch = unassignedCustomers.splice(0, batchSize);
        
        const route = createRouteFromCustomers(batch, salesmanId++, clusterId, distributor, config, assignedIds);
        if (route) initialBeats.push(route);
      }
    }
    
    // CRITICAL: Apply minimum size constraint - merge undersized beats with nearest beats
    const finalBeats = enforceMinimumBeatSize(initialBeats, config, distributor);
    
    console.log(`Cluster ${clusterId}: Created ${initialBeats.length} initial beats, merged to ${finalBeats.length} final beats`);
    
    routes.push(...finalBeats);
    
  } catch (error) {
    console.warn('DBSCAN processing failed, using simple grouping:', error);
    
    // Fallback: Simple grouping by proximity
    while (remainingCustomers.length > 0) {
      const batchSize = Math.min(config.maxOutletsPerBeat, remainingCustomers.length);
      const batch = remainingCustomers.splice(0, batchSize);
      
      const route = createRouteFromCustomers(batch, salesmanId++, clusterId, distributor, config, assignedIds);
      if (route) routes.push(route);
    }
    
    // Apply minimum size constraint to fallback routes as well
    const finalRoutes = enforceMinimumBeatSize(routes, config, distributor);
    return finalRoutes;
  }
  
  return routes;
}

function enforceMinimumBeatSize(
  beats: SalesmanRoute[],
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number }
): SalesmanRoute[] {
  console.log(`Enforcing minimum beat size of ${config.minOutletsPerBeat} outlets per beat`);
  console.log(`Input: ${beats.length} beats with sizes: [${beats.map(b => b.stops.length).join(', ')}]`);
  
  if (beats.length === 0) return beats;
  
  // Separate beats into undersized and properly sized
  const undersizedBeats = beats.filter(beat => beat.stops.length < config.minOutletsPerBeat);
  const properSizedBeats = beats.filter(beat => beat.stops.length >= config.minOutletsPerBeat);
  
  console.log(`Found ${undersizedBeats.length} undersized beats and ${properSizedBeats.length} properly sized beats`);
  
  if (undersizedBeats.length === 0) {
    console.log('No undersized beats found, returning original beats');
    return beats;
  }
  
  // If all beats are undersized, merge them intelligently
  if (properSizedBeats.length === 0) {
    console.log('All beats are undersized, merging them intelligently');
    return mergeAllUndersizedBeats(undersizedBeats, config, distributor);
  }
  
  // Merge each undersized beat with the nearest properly sized beat
  const finalBeats = [...properSizedBeats];
  
  undersizedBeats.forEach(undersizedBeat => {
    console.log(`Processing undersized beat ${undersizedBeat.salesmanId} with ${undersizedBeat.stops.length} outlets`);
    
    // Find the nearest properly sized beat that can accommodate the undersized beat
    let bestTargetBeat: SalesmanRoute | null = null;
    let minDistance = Infinity;
    
    for (const targetBeat of finalBeats) {
      // Check if target beat can accommodate the undersized beat without exceeding max size
      if (targetBeat.stops.length + undersizedBeat.stops.length <= config.maxOutletsPerBeat) {
        // Calculate distance between beat centroids
        const undersizedCentroid = calculateBeatCentroid(undersizedBeat);
        const targetCentroid = calculateBeatCentroid(targetBeat);
        
        const distance = calculateHaversineDistance(
          undersizedCentroid.latitude, undersizedCentroid.longitude,
          targetCentroid.latitude, targetCentroid.longitude
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          bestTargetBeat = targetBeat;
        }
      }
    }
    
    if (bestTargetBeat) {
      console.log(`Merging undersized beat ${undersizedBeat.salesmanId} (${undersizedBeat.stops.length} outlets) with beat ${bestTargetBeat.salesmanId} (${bestTargetBeat.stops.length} outlets)`);
      console.log(`Distance between beats: ${minDistance.toFixed(2)} km`);
      
      // Merge the undersized beat into the target beat
      bestTargetBeat.stops.push(...undersizedBeat.stops);
      
      // Update the target beat's cluster IDs to include all clusters
      const allClusterIds = new Set([...bestTargetBeat.clusterIds, ...undersizedBeat.clusterIds]);
      bestTargetBeat.clusterIds = Array.from(allClusterIds);
      
      console.log(`After merge: beat ${bestTargetBeat.salesmanId} now has ${bestTargetBeat.stops.length} outlets`);
    } else {
      // If no suitable target beat found, try to merge with the smallest beat that won't exceed max size
      const smallestCompatibleBeat = finalBeats
        .filter(beat => beat.stops.length + undersizedBeat.stops.length <= config.maxOutletsPerBeat)
        .sort((a, b) => a.stops.length - b.stops.length)[0];
      
      if (smallestCompatibleBeat) {
        console.log(`No nearby beat found, merging undersized beat ${undersizedBeat.salesmanId} with smallest compatible beat ${smallestCompatibleBeat.salesmanId}`);
        
        smallestCompatibleBeat.stops.push(...undersizedBeat.stops);
        const allClusterIds = new Set([...smallestCompatibleBeat.clusterIds, ...undersizedBeat.clusterIds]);
        smallestCompatibleBeat.clusterIds = Array.from(allClusterIds);
      } else {
        // If still no suitable beat, keep the undersized beat as is (emergency case)
        console.warn(`Could not merge undersized beat ${undersizedBeat.salesmanId}, keeping as separate beat`);
        finalBeats.push(undersizedBeat);
      }
    }
  });
  
  // Update route metrics for all final beats
  finalBeats.forEach(beat => {
    updateRouteMetrics(beat, distributor, config);
  });
  
  // Reassign beat IDs sequentially
  const reindexedBeats = finalBeats.map((beat, index) => ({
    ...beat,
    salesmanId: index + 1
  }));
  
  console.log(`Final result: ${reindexedBeats.length} beats with sizes: [${reindexedBeats.map(b => b.stops.length).join(', ')}]`);
  
  // Verify no beat is below minimum size (except if unavoidable)
  const stillUndersized = reindexedBeats.filter(beat => beat.stops.length < config.minOutletsPerBeat);
  if (stillUndersized.length > 0) {
    console.warn(`Warning: ${stillUndersized.length} beats still below minimum size after merging`);
    stillUndersized.forEach(beat => {
      console.warn(`Beat ${beat.salesmanId}: ${beat.stops.length} outlets (minimum: ${config.minOutletsPerBeat})`);
    });
  }
  
  return reindexedBeats;
}

function mergeAllUndersizedBeats(
  undersizedBeats: SalesmanRoute[],
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number }
): SalesmanRoute[] {
  console.log(`Merging ${undersizedBeats.length} undersized beats intelligently`);
  
  if (undersizedBeats.length === 0) return [];
  if (undersizedBeats.length === 1) return undersizedBeats;
  
  const finalBeats: SalesmanRoute[] = [];
  const remainingBeats = [...undersizedBeats];
  
  while (remainingBeats.length > 0) {
    const currentBeat = remainingBeats.shift()!;
    
    // Try to merge with other beats until we reach minimum size or max size
    while (currentBeat.stops.length < config.minOutletsPerBeat && remainingBeats.length > 0) {
      // Find the nearest beat that can be merged without exceeding max size
      let nearestBeatIndex = -1;
      let minDistance = Infinity;
      
      const currentCentroid = calculateBeatCentroid(currentBeat);
      
      for (let i = 0; i < remainingBeats.length; i++) {
        const candidateBeat = remainingBeats[i];
        
        // Check if merging would exceed max size
        if (currentBeat.stops.length + candidateBeat.stops.length <= config.maxOutletsPerBeat) {
          const candidateCentroid = calculateBeatCentroid(candidateBeat);
          const distance = calculateHaversineDistance(
            currentCentroid.latitude, currentCentroid.longitude,
            candidateCentroid.latitude, candidateCentroid.longitude
          );
          
          if (distance < minDistance) {
            minDistance = distance;
            nearestBeatIndex = i;
          }
        }
      }
      
      if (nearestBeatIndex !== -1) {
        const beatToMerge = remainingBeats.splice(nearestBeatIndex, 1)[0];
        console.log(`Merging beat ${currentBeat.salesmanId} (${currentBeat.stops.length}) with beat ${beatToMerge.salesmanId} (${beatToMerge.stops.length})`);
        
        currentBeat.stops.push(...beatToMerge.stops);
        const allClusterIds = new Set([...currentBeat.clusterIds, ...beatToMerge.clusterIds]);
        currentBeat.clusterIds = Array.from(allClusterIds);
      } else {
        // No more beats can be merged without exceeding max size
        break;
      }
    }
    
    finalBeats.push(currentBeat);
  }
  
  console.log(`Merged ${undersizedBeats.length} undersized beats into ${finalBeats.length} final beats`);
  
  return finalBeats;
}

function calculateBeatCentroid(beat: SalesmanRoute): { latitude: number; longitude: number } {
  if (beat.stops.length === 0) {
    return { latitude: beat.distributorLat, longitude: beat.distributorLng };
  }
  
  const totalLat = beat.stops.reduce((sum, stop) => sum + stop.latitude, 0);
  const totalLng = beat.stops.reduce((sum, stop) => sum + stop.longitude, 0);
  
  return {
    latitude: totalLat / beat.stops.length,
    longitude: totalLng / beat.stops.length
  };
}

function performOptimizedDBSCAN(
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number,
  checkTimeout: () => void
): ClusteredCustomer[][] {
  const clusters: ClusteredCustomer[][] = [];
  const visited = new Set<string>();
  const processed = new Set<string>();
  
  // Limit processing to prevent infinite loops
  const maxIterations = Math.min(customers.length, 1000);
  let iterations = 0;
  
  for (const customer of customers) {
    if (iterations++ > maxIterations) {
      console.warn('DBSCAN iteration limit reached, stopping early');
      break;
    }
    
    checkTimeout(); // Check timeout during processing
    
    if (visited.has(customer.id) || processed.has(customer.id)) continue;
    
    visited.add(customer.id);
    const neighbors = getNeighborsOptimized(customer, customers, eps, processed);
    
    if (neighbors.length < minPts) {
      // Mark as noise but still process later
      continue;
    } else {
      const cluster: ClusteredCustomer[] = [];
      expandClusterOptimized(customer, neighbors, cluster, visited, customers, eps, minPts, processed, checkTimeout);
      if (cluster.length > 0) {
        clusters.push(cluster);
        // Mark all cluster members as processed
        cluster.forEach(c => processed.add(c.id));
      }
    }
  }
  
  // Handle remaining unprocessed customers
  const unprocessedCustomers = customers.filter(c => !processed.has(c.id));
  if (unprocessedCustomers.length > 0) {
    // Group remaining customers into small clusters
    const remainingClusters = groupRemainingCustomers(unprocessedCustomers, eps);
    clusters.push(...remainingClusters);
  }
  
  return clusters;
}

function getNeighborsOptimized(
  customer: ClusteredCustomer,
  customers: ClusteredCustomer[],
  eps: number,
  processed: Set<string>
): ClusteredCustomer[] {
  const neighbors: ClusteredCustomer[] = [];
  
  // Limit neighbor search for performance
  const maxNeighbors = 50;
  let neighborCount = 0;
  
  for (const other of customers) {
    if (neighborCount >= maxNeighbors) break;
    if (customer.id !== other.id && !processed.has(other.id)) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        other.latitude, other.longitude
      );
      
      if (distance <= eps) {
        neighbors.push(other);
        neighborCount++;
      }
    }
  }
  
  return neighbors;
}

function expandClusterOptimized(
  customer: ClusteredCustomer,
  neighbors: ClusteredCustomer[],
  cluster: ClusteredCustomer[],
  visited: Set<string>,
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number,
  processed: Set<string>,
  checkTimeout: () => void
): void {
  cluster.push(customer);
  processed.add(customer.id);
  
  // Limit expansion to prevent infinite loops
  const maxExpansion = 100;
  let expansionCount = 0;
  
  for (let i = 0; i < neighbors.length && expansionCount < maxExpansion; i++) {
    checkTimeout(); // Check timeout during expansion
    expansionCount++;
    
    const neighbor = neighbors[i];
    
    if (!visited.has(neighbor.id)) {
      visited.add(neighbor.id);
      const neighborNeighbors = getNeighborsOptimized(neighbor, customers, eps, processed);
      
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

function groupRemainingCustomers(
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
        return distance <= eps * 2; // Allow some flexibility
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

function splitLargeClusterOptimized(
  cluster: ClusteredCustomer[],
  maxSize: number,
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[][] {
  if (cluster.length <= maxSize) return [cluster];
  
  const subClusters: ClusteredCustomer[][] = [];
  const remaining = [...cluster];
  
  // Simple chunking approach for performance
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
  
  // Simple ordering for performance - just use the order provided
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

function createFallbackSolution(
  locationData: LocationData,
  config: ClusteringConfig
): AlgorithmResult {
  console.log('Creating fallback solution for DBSCAN');
  
  const { distributor, customers } = locationData;
  const routes: SalesmanRoute[] = [];
  
  // Simple grouping by cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  let salesmanId = 1;
  
  Object.entries(customersByCluster).forEach(([clusterId, clusterCustomers]) => {
    // Split cluster customers into beats
    const beatsPerCluster = Math.ceil(clusterCustomers.length / config.maxOutletsPerBeat);
    const customersPerBeat = Math.ceil(clusterCustomers.length / beatsPerCluster);
    
    for (let i = 0; i < beatsPerCluster; i++) {
      const startIndex = i * customersPerBeat;
      const endIndex = Math.min(startIndex + customersPerBeat, clusterCustomers.length);
      const beatCustomers = clusterCustomers.slice(startIndex, endIndex);
      
      if (beatCustomers.length > 0) {
        const route: SalesmanRoute = {
          salesmanId: salesmanId++,
          stops: beatCustomers.map(customer => ({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          })),
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [Number(clusterId)],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        
        updateRouteMetrics(route, distributor, config);
        routes.push(route);
      }
    }
  });
  
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `DBSCAN-Based Beat Formation (Fallback) (${config.totalClusters} Clusters, ${routes.length} Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
}