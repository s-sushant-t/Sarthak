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
  console.log(`REQUIRED TOTAL BEATS: ${config.totalClusters * config.beatsPerCluster}`);
  console.log(`DBSCAN parameters: 200m radius, minimum ${config.minOutletsPerBeat} outlets per beat`);
  
  // CRITICAL: Calculate exact number of beats required
  const REQUIRED_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
  
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
    
    // Process each cluster independently using DBSCAN with exact beat count enforcement
    for (const clusterId of Object.keys(customersByCluster)) {
      checkTimeout(); // Check timeout before processing each cluster
      
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers using DBSCAN`);
      console.log(`Target beats for this cluster: ${config.beatsPerCluster}`);
      
      // CRITICAL: Track assigned customers within this cluster only
      const clusterAssignedIds = new Set<string>();
      
      // Create DBSCAN-based beats within the cluster with EXACT beat count enforcement
      const clusterRoutes = await createDBSCANBasedBeatsWithExactCount(
        clusterCustomers,
        distributor,
        config,
        currentSalesmanId,
        Number(clusterId),
        clusterAssignedIds,
        config.beatsPerCluster, // EXACT number of beats required for this cluster
        checkTimeout
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned in ${clusterRoutes.length} beats`);
      
      // CRITICAL: Verify exact beat count for this cluster
      if (clusterRoutes.length !== config.beatsPerCluster) {
        console.warn(`CLUSTER ${clusterId} BEAT COUNT WARNING: Expected ${config.beatsPerCluster} beats, got ${clusterRoutes.length} - will be force-adjusted`);
      }
      
      if (assignedInCluster !== clusterSize) {
        console.warn(`CLUSTER ${clusterId} WARNING: Expected ${clusterSize} customers, got ${assignedInCluster} - will be force-assigned`);
        
        // Find and assign missing customers
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to routes
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
      
      // Add cluster customers to global tracking
      clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
      
      routes.push(...clusterRoutes);
      currentSalesmanId += clusterRoutes.length;
      
      console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} DBSCAN-based beats created`);
    }
    
    // CRITICAL: Force exact beat count if needed
    if (routes.length !== REQUIRED_TOTAL_BEATS) {
      console.warn(`BEAT COUNT ADJUSTMENT: Expected ${REQUIRED_TOTAL_BEATS} total beats, got ${routes.length} - force adjusting`);
      const adjustedRoutes = forceExactBeatCount(routes, REQUIRED_TOTAL_BEATS, config, distributor, 0);
      routes.splice(0, routes.length, ...adjustedRoutes);
    }
    
    // CRITICAL: Final verification - ensure ALL customers are assigned exactly once
    const finalAssignedCount = globalAssignedCustomerIds.size;
    const totalCustomers = allCustomers.length;
    
    console.log(`GLOBAL VERIFICATION: ${finalAssignedCount}/${totalCustomers} customers assigned`);
    
    if (finalAssignedCount !== totalCustomers) {
      console.warn(`CUSTOMER ASSIGNMENT WARNING: ${totalCustomers - finalAssignedCount} customers missing from routes - force assigning`);
      
      // Emergency assignment of missing customers
      const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
      console.log('Missing customers:', missingCustomers.map(c => c.id));
      
      missingCustomers.forEach(customer => {
        // Find a route in the same cluster with space, or any route if needed
        const sameClusterRoutes = routes.filter(route => 
          route.clusterIds.includes(customer.clusterId)
        );
        
        let targetRoute = sameClusterRoutes[0];
        
        if (!targetRoute) {
          // Find any route (emergency case)
          targetRoute = routes[0];
        }
        
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
    console.log(`- Required beats: ${REQUIRED_TOTAL_BEATS}`);
    console.log(`- Beat count constraint satisfied: ${finalRoutes.length === REQUIRED_TOTAL_BEATS ? 'YES' : 'NO'}`);
    console.log(`- Customer assignment complete: ${finalCustomerCount === totalCustomers && uniqueCustomerIds.size === totalCustomers ? 'YES' : 'NO'}`);
    
    // Report beats per cluster
    const beatsByCluster = finalRoutes.reduce((acc, route) => {
      route.clusterIds.forEach(clusterId => {
        if (!acc[clusterId]) acc[clusterId] = 0;
        acc[clusterId]++;
      });
      return acc;
    }, {} as Record<number, number>);
    
    console.log('Beats per cluster:', beatsByCluster);
    
    // Calculate total distance
    const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    return {
      name: `DBSCAN-Based Beat Formation (${config.totalClusters} Clusters × ${config.beatsPerCluster} Beats = ${finalRoutes.length} Total Beats)`,
      totalDistance,
      totalSalesmen: finalRoutes.length,
      processingTime: Date.now() - startTime,
      routes: finalRoutes
    };
    
  } catch (error) {
    console.error('DBSCAN algorithm failed:', error);
    // Fallback to simple approach that guarantees exact beat count
    return createFallbackSolutionWithExactBeatCount(locationData, config);
  }
};

async function createDBSCANBasedBeatsWithExactCount(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  requiredBeats: number,
  checkTimeout: () => void
): Promise<SalesmanRoute[]> {
  if (customers.length === 0) {
    // Even if no customers, we need to create empty beats to meet the count requirement
    console.log(`Creating ${requiredBeats} empty beats for cluster ${clusterId} (no customers)`);
    return Array.from({ length: requiredBeats }, (_, index) => ({
      salesmanId: startingSalesmanId + index,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    }));
  }
  
  console.log(`Creating EXACTLY ${requiredBeats} DBSCAN-based beats for cluster ${clusterId} with ${customers.length} customers`);
  
  let routes: SalesmanRoute[] = [];
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
    
    // Step 1: Create initial beats from DBSCAN clusters
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
        // Create a beat from this DBSCAN cluster
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
    
    console.log(`Created ${initialBeats.length} initial beats, need exactly ${requiredBeats} beats`);
    
    // Step 2: Adjust beat count to match EXACT requirement
    routes = adjustBeatCountToExactRequirement(initialBeats, requiredBeats, config, distributor, clusterId);
    
    console.log(`Cluster ${clusterId}: Adjusted to exactly ${routes.length} beats (target: ${requiredBeats})`);
    
  } catch (error) {
    console.warn('DBSCAN processing failed, using simple grouping with exact count:', error);
    
    // Fallback: Simple grouping by proximity with exact beat count
    routes = createExactBeatCountFallback(remainingCustomers, requiredBeats, config, distributor, clusterId, assignedIds, startingSalesmanId);
  }
  
  // CRITICAL: Verify exact beat count
  if (routes.length !== requiredBeats) {
    console.warn(`Beat count mismatch for cluster ${clusterId}: Expected ${requiredBeats}, got ${routes.length} - force adjusting`);
    // Force adjustment
    routes = forceExactBeatCount(routes, requiredBeats, config, distributor, clusterId);
  }
  
  return routes;
}

function adjustBeatCountToExactRequirement(
  initialBeats: SalesmanRoute[],
  requiredBeats: number,
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  clusterId: number
): SalesmanRoute[] {
  console.log(`Adjusting ${initialBeats.length} initial beats to exactly ${requiredBeats} required beats`);
  
  if (initialBeats.length === requiredBeats) {
    console.log('Beat count already matches requirement');
    return initialBeats;
  }
  
  if (initialBeats.length < requiredBeats) {
    // Need to create more beats by splitting existing ones
    console.log(`Need to create ${requiredBeats - initialBeats.length} additional beats by splitting`);
    return splitBeatsToIncreaseCount(initialBeats, requiredBeats, config, distributor, clusterId);
  } else {
    // Need to merge beats to reduce count
    console.log(`Need to merge ${initialBeats.length - requiredBeats} beats to reduce count`);
    return mergeBeatsToReduceCount(initialBeats, requiredBeats, config, distributor);
  }
}

function splitBeatsToIncreaseCount(
  beats: SalesmanRoute[],
  requiredBeats: number,
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  clusterId: number
): SalesmanRoute[] {
  const result = [...beats];
  const additionalBeatsNeeded = requiredBeats - beats.length;
  
  console.log(`Splitting beats to create ${additionalBeatsNeeded} additional beats`);
  
  // Sort beats by size (largest first) to split the biggest ones
  const sortedBeats = result.sort((a, b) => b.stops.length - a.stops.length);
  
  let beatsCreated = 0;
  
  for (let i = 0; i < sortedBeats.length && beatsCreated < additionalBeatsNeeded; i++) {
    const beat = sortedBeats[i];
    
    if (beat.stops.length >= 2) { // Can only split if at least 2 customers
      const midPoint = Math.ceil(beat.stops.length / 2);
      
      // Create new beat with second half of customers
      const newBeat: SalesmanRoute = {
        salesmanId: result.length + beatsCreated + 1, // Temporary ID
        stops: beat.stops.splice(midPoint),
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [clusterId],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      };
      
      result.push(newBeat);
      beatsCreated++;
      
      console.log(`Split beat ${beat.salesmanId}: ${beat.stops.length + newBeat.stops.length} customers → ${beat.stops.length} + ${newBeat.stops.length}`);
    }
  }
  
  // If we still need more beats, create empty ones
  while (result.length < requiredBeats) {
    const emptyBeat: SalesmanRoute = {
      salesmanId: result.length + 1, // Temporary ID
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    result.push(emptyBeat);
    console.log(`Created empty beat to meet count requirement`);
  }
  
  return result;
}

function mergeBeatsToReduceCount(
  beats: SalesmanRoute[],
  requiredBeats: number,
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number }
): SalesmanRoute[] {
  const result = [...beats];
  const beatsToRemove = beats.length - requiredBeats;
  
  console.log(`Merging beats to remove ${beatsToRemove} beats`);
  
  // Sort beats by size (smallest first) to merge the smallest ones
  result.sort((a, b) => a.stops.length - b.stops.length);
  
  let beatsRemoved = 0;
  
  while (beatsRemoved < beatsToRemove && result.length > 1) {
    // Take the smallest beat
    const smallestBeat = result.shift()!;
    
    // Find the best target beat to merge with (one that won't exceed max size)
    let targetBeat = null;
    let minSizeIncrease = Infinity;
    
    for (const beat of result) {
      if (beat.stops.length + smallestBeat.stops.length <= config.maxOutletsPerBeat) {
        const sizeIncrease = smallestBeat.stops.length;
        if (sizeIncrease < minSizeIncrease) {
          minSizeIncrease = sizeIncrease;
          targetBeat = beat;
        }
      }
    }
    
    if (targetBeat) {
      // Merge smallest beat into target beat
      targetBeat.stops.push(...smallestBeat.stops);
      
      // Update cluster IDs
      const allClusterIds = new Set([...targetBeat.clusterIds, ...smallestBeat.clusterIds]);
      targetBeat.clusterIds = Array.from(allClusterIds);
      
      beatsRemoved++;
      console.log(`Merged beat with ${smallestBeat.stops.length} customers into beat with ${targetBeat.stops.length - smallestBeat.stops.length} customers`);
    } else {
      // If no suitable target found, put the beat back and try with next smallest
      result.unshift(smallestBeat);
      break;
    }
  }
  
  return result;
}

function forceExactBeatCount(
  beats: SalesmanRoute[],
  requiredBeats: number,
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  clusterId: number
): SalesmanRoute[] {
  console.log(`Force adjusting beat count from ${beats.length} to ${requiredBeats}`);
  
  if (beats.length === requiredBeats) return beats;
  
  if (beats.length < requiredBeats) {
    // Add empty beats
    const result = [...beats];
    while (result.length < requiredBeats) {
      result.push({
        salesmanId: result.length + 1,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [clusterId],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      });
    }
    return result;
  } else {
    // Remove excess beats by merging them into remaining ones
    const result = beats.slice(0, requiredBeats);
    const excessBeats = beats.slice(requiredBeats);
    
    // Distribute customers from excess beats - CRITICAL FIX: Remove the conditional check
    excessBeats.forEach(excessBeat => {
      excessBeat.stops.forEach(stop => {
        // Find the beat with the least customers
        const targetBeat = result.reduce((min, beat) => 
          beat.stops.length < min.stops.length ? beat : min
        );
        
        // CRITICAL FIX: Always assign the customer, even if it exceeds maxOutletsPerBeat
        // This ensures no customers are lost during the force adjustment
        targetBeat.stops.push(stop);
      });
    });
    
    return result;
  }
}

function createExactBeatCountFallback(
  customers: ClusteredCustomer[],
  requiredBeats: number,
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  clusterId: number,
  assignedIds: Set<string>,
  startingSalesmanId: number
): SalesmanRoute[] {
  console.log(`Creating exactly ${requiredBeats} beats using fallback method for ${customers.length} customers`);
  
  const routes: SalesmanRoute[] = [];
  
  // Calculate customers per beat
  const customersPerBeat = Math.ceil(customers.length / requiredBeats);
  
  for (let i = 0; i < requiredBeats; i++) {
    const startIndex = i * customersPerBeat;
    const endIndex = Math.min(startIndex + customersPerBeat, customers.length);
    const beatCustomers = customers.slice(startIndex, endIndex);
    
    const route: SalesmanRoute = {
      salesmanId: startingSalesmanId + i,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Add customers to this beat
    beatCustomers.forEach(customer => {
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
    
    routes.push(route);
  }
  
  console.log(`Created exactly ${routes.length} beats using fallback method`);
  return routes;
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

function createFallbackSolutionWithExactBeatCount(
  locationData: LocationData,
  config: ClusteringConfig
): AlgorithmResult {
  console.log('Creating fallback solution for DBSCAN with EXACT beat count enforcement');
  
  const { distributor, customers } = locationData;
  const REQUIRED_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
  
  console.log(`FALLBACK: Must create exactly ${REQUIRED_TOTAL_BEATS} beats (${config.totalClusters} clusters × ${config.beatsPerCluster} beats)`);
  
  // Group customers by cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = 1;
  
  // Process each cluster to create exactly the required number of beats
  Object.entries(customersByCluster).forEach(([clusterId, clusterCustomers]) => {
    console.log(`Fallback processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    
    // Create exactly beatsPerCluster beats for this cluster
    for (let beatIndex = 0; beatIndex < config.beatsPerCluster; beatIndex++) {
      const route: SalesmanRoute = {
        salesmanId: salesmanId++,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [Number(clusterId)],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      };
      
      // Distribute customers evenly across beats
      const customersPerBeat = Math.ceil(clusterCustomers.length / config.beatsPerCluster);
      const startIndex = beatIndex * customersPerBeat;
      const endIndex = Math.min(startIndex + customersPerBeat, clusterCustomers.length);
      const beatCustomers = clusterCustomers.slice(startIndex, endIndex);
      
      // Add customers to this beat
      beatCustomers.forEach(customer => {
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
      
      updateRouteMetrics(route, distributor, config);
      routes.push(route);
      
      console.log(`Fallback created beat ${route.salesmanId} for cluster ${clusterId} with ${route.stops.length} customers`);
    }
  });
  
  // CRITICAL: Verify exact beat count
  if (routes.length !== REQUIRED_TOTAL_BEATS) {
    console.error(`FALLBACK ERROR: Expected ${REQUIRED_TOTAL_BEATS} beats, got ${routes.length}`);
    
    // Force correct count
    if (routes.length < REQUIRED_TOTAL_BEATS) {
      // Add empty beats
      while (routes.length < REQUIRED_TOTAL_BEATS) {
        routes.push({
          salesmanId: routes.length + 1,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [0], // Default cluster
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        });
      }
    } else {
      // Remove excess beats
      routes.splice(REQUIRED_TOTAL_BEATS);
    }
  }
  
  const totalDistance = routes.reduce((total, route) => total + route.totalDistance, 0);
  
  console.log(`FALLBACK COMPLETE: Created exactly ${routes.length} beats as required`);
  
  return {
    name: `DBSCAN-Based Beat Formation (Fallback) (${config.totalClusters} Clusters × ${config.beatsPerCluster} Beats = ${routes.length} Total Beats)`,
    totalDistance,
    totalSalesmen: routes.length,
    processingTime: 0,
    routes
  };
}