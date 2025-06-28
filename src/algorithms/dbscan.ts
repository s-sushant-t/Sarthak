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
  console.log(`Target: exactly ${config.totalClusters * config.beatsPerCluster} total beats`);
  
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
      
      // Create exactly beatsPerCluster beats using DBSCAN-based geographical isolation
      const clusterRoutes = await createGeographicallyIsolatedBeats(
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
        console.warn(`Cluster ${clusterId}: Expected ${config.beatsPerCluster} beats, got ${clusterRoutes.length}`);
      }
      
      // Add cluster customers to global tracking
      clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
      
      routes.push(...clusterRoutes);
      currentSalesmanId += clusterRoutes.length;
      
      console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} beats created`);
      
      // Yield control between clusters
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
    
    // CRITICAL: Apply final geographical isolation enforcement between beats
    const isolatedRoutes = await enforceInterBeatIsolation(routes, config);
    
    // Update route metrics for all routes
    isolatedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Reassign beat IDs sequentially
    const finalRoutes = isolatedRoutes.map((route, index) => ({
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
    
    // Verify geographical isolation between beats
    const isolationReport = verifyBeatIsolation(finalRoutes);
    console.log('Beat isolation verification:', isolationReport);
    
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

async function createGeographicallyIsolatedBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  if (customers.length === 0) return [];
  
  console.log(`Creating exactly ${targetBeats} geographically isolated beats for cluster ${clusterId} with ${customers.length} customers`);
  
  // Step 1: Apply DBSCAN to find geographically isolated groups within the cluster
  const EPS = 0.2; // 200 meters in kilometers
  const MIN_PTS = Math.max(2, Math.floor(config.minOutletsPerBeat * 0.3)); // Flexible minimum
  const ISOLATION_BUFFER = 0.5; // 500 meters minimum separation between beats
  
  const dbscanGroups = await performDBSCANWithinCluster(customers, EPS, MIN_PTS);
  console.log(`DBSCAN found ${dbscanGroups.length} geographically isolated groups in cluster ${clusterId}`);
  
  // Step 2: Create exactly targetBeats number of beats using spatial partitioning
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Initialize exactly targetBeats number of empty beats
  for (let i = 0; i < targetBeats; i++) {
    routes.push({
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    });
  }
  
  // Step 3: Use spatial partitioning to ensure geographical isolation between beats
  const spatiallyPartitionedBeats = await createSpatiallyPartitionedBeats(
    customers, 
    routes, 
    dbscanGroups, 
    ISOLATION_BUFFER,
    config,
    assignedIds
  );
  
  console.log(`Cluster ${clusterId}: Created exactly ${spatiallyPartitionedBeats.length} geographically isolated beats`);
  
  // Log beat sizes and isolation metrics for verification
  const beatSizes = spatiallyPartitionedBeats.map(route => route.stops.length);
  console.log(`Beat sizes in cluster ${clusterId}: ${beatSizes.join(', ')}`);
  
  // Verify isolation between beats
  const isolationViolations = checkBeatIsolation(spatiallyPartitionedBeats, ISOLATION_BUFFER);
  if (isolationViolations > 0) {
    console.warn(`Cluster ${clusterId}: ${isolationViolations} isolation violations detected`);
  } else {
    console.log(`Cluster ${clusterId}: All beats are geographically isolated`);
  }
  
  return spatiallyPartitionedBeats;
}

async function createSpatiallyPartitionedBeats(
  customers: ClusteredCustomer[],
  emptyBeats: SalesmanRoute[],
  dbscanGroups: ClusteredCustomer[][],
  isolationBuffer: number,
  config: ClusteringConfig,
  assignedIds: Set<string>
): Promise<SalesmanRoute[]> {
  console.log(`Creating spatially partitioned beats with ${isolationBuffer}km isolation buffer`);
  
  // Step 1: Calculate spatial bounds of all customers
  const bounds = calculateSpatialBounds(customers);
  
  // Step 2: Create spatial grid for beat assignment
  const gridSize = Math.ceil(Math.sqrt(emptyBeats.length));
  const spatialGrid = createSpatialGrid(bounds, gridSize);
  
  // Step 3: Assign DBSCAN groups to grid cells ensuring isolation
  const groupAssignments = assignGroupsToGrid(dbscanGroups, spatialGrid, emptyBeats.length);
  
  // Step 4: Distribute groups to beats based on spatial assignments
  groupAssignments.forEach((groupIndices, beatIndex) => {
    if (beatIndex < emptyBeats.length) {
      const targetBeat = emptyBeats[beatIndex];
      
      groupIndices.forEach(groupIndex => {
        if (groupIndex < dbscanGroups.length) {
          const group = dbscanGroups[groupIndex];
          
          group.forEach(customer => {
            if (!assignedIds.has(customer.id)) {
              targetBeat.stops.push({
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
      });
    }
  });
  
  // Step 5: Handle any remaining unassigned customers
  const unassignedCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  unassignedCustomers.forEach(customer => {
    // Find the beat with minimum isolation violations
    let bestBeat: SalesmanRoute | null = null;
    let minViolations = Infinity;
    
    for (const beat of emptyBeats) {
      const violations = calculateIsolationViolations(customer, beat, emptyBeats, isolationBuffer);
      if (violations < minViolations) {
        minViolations = violations;
        bestBeat = beat;
      }
    }
    
    // If no beat found without violations, assign to smallest beat
    if (!bestBeat) {
      bestBeat = emptyBeats.reduce((min, route) => 
        route.stops.length < min.stops.length ? route : min
      );
    }
    
    if (bestBeat) {
      bestBeat.stops.push({
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
  
  return emptyBeats;
}

function calculateSpatialBounds(customers: ClusteredCustomer[]): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  return {
    minLat: Math.min(...customers.map(c => c.latitude)),
    maxLat: Math.max(...customers.map(c => c.latitude)),
    minLng: Math.min(...customers.map(c => c.longitude)),
    maxLng: Math.max(...customers.map(c => c.longitude))
  };
}

function createSpatialGrid(bounds: any, gridSize: number): {
  cellWidth: number;
  cellHeight: number;
  gridSize: number;
  bounds: any;
} {
  const cellWidth = (bounds.maxLng - bounds.minLng) / gridSize;
  const cellHeight = (bounds.maxLat - bounds.minLat) / gridSize;
  
  return {
    cellWidth,
    cellHeight,
    gridSize,
    bounds
  };
}

function assignGroupsToGrid(
  dbscanGroups: ClusteredCustomer[][],
  spatialGrid: any,
  numBeats: number
): Map<number, number[]> {
  const assignments = new Map<number, number[]>();
  
  // Initialize assignments for each beat
  for (let i = 0; i < numBeats; i++) {
    assignments.set(i, []);
  }
  
  // Assign each group to a grid cell and then to a beat
  dbscanGroups.forEach((group, groupIndex) => {
    // Calculate centroid of the group
    const centroid = {
      latitude: group.reduce((sum, c) => sum + c.latitude, 0) / group.length,
      longitude: group.reduce((sum, c) => sum + c.longitude, 0) / group.length
    };
    
    // Determine grid cell
    const cellX = Math.floor((centroid.longitude - spatialGrid.bounds.minLng) / spatialGrid.cellWidth);
    const cellY = Math.floor((centroid.latitude - spatialGrid.bounds.minLat) / spatialGrid.cellHeight);
    
    // Map grid cell to beat index
    const beatIndex = (cellY * spatialGrid.gridSize + cellX) % numBeats;
    
    assignments.get(beatIndex)!.push(groupIndex);
  });
  
  return assignments;
}

function calculateIsolationViolations(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  isolationBuffer: number
): number {
  let violations = 0;
  
  // Check against all other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    // Check distance to all stops in other beats
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < isolationBuffer) {
        violations++;
      }
    }
  }
  
  return violations;
}

async function enforceInterBeatIsolation(
  routes: SalesmanRoute[],
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  console.log('Enforcing geographical isolation between all beats...');
  
  const ISOLATION_DISTANCE = 0.5; // 500 meters minimum separation
  const MAX_ITERATIONS = 5;
  
  let isolatedRoutes = [...routes];
  let iteration = 0;
  
  while (iteration < MAX_ITERATIONS) {
    const violations = findIsolationViolations(isolatedRoutes, ISOLATION_DISTANCE);
    
    if (violations.length === 0) {
      console.log(`Beat isolation achieved after ${iteration} iterations`);
      break;
    }
    
    console.log(`Iteration ${iteration + 1}: Found ${violations.length} isolation violations`);
    
    // Resolve violations by moving customers to less conflicted beats
    for (const violation of violations) {
      const { customer, fromBeatId, toBeatId, distance } = violation;
      
      // Find alternative beats for the customer
      const alternativeBeats = isolatedRoutes.filter(route => 
        route.salesmanId !== fromBeatId && 
        route.clusterIds.some(id => customer.clusterId === id)
      );
      
      if (alternativeBeats.length > 0) {
        // Find the beat with least isolation conflicts
        let bestBeat = alternativeBeats[0];
        let minConflicts = Infinity;
        
        for (const altBeat of alternativeBeats) {
          const conflicts = calculateBeatConflicts(customer, altBeat, isolatedRoutes, ISOLATION_DISTANCE);
          if (conflicts < minConflicts) {
            minConflicts = conflicts;
            bestBeat = altBeat;
          }
        }
        
        // Move customer if it reduces conflicts
        if (minConflicts < 1) {
          moveCustomerBetweenBeats(customer, fromBeatId, bestBeat.salesmanId, isolatedRoutes);
          console.log(`Moved customer ${customer.customerId} from beat ${fromBeatId} to beat ${bestBeat.salesmanId}`);
        }
      }
    }
    
    iteration++;
  }
  
  const finalViolations = findIsolationViolations(isolatedRoutes, ISOLATION_DISTANCE);
  if (finalViolations.length > 0) {
    console.warn(`Could not resolve all isolation violations: ${finalViolations.length} remaining`);
  }
  
  return isolatedRoutes;
}

function findIsolationViolations(
  routes: SalesmanRoute[],
  minDistance: number
): Array<{
  customer: RouteStop;
  fromBeatId: number;
  toBeatId: number;
  distance: number;
}> {
  const violations: Array<{
    customer: RouteStop;
    fromBeatId: number;
    toBeatId: number;
    distance: number;
  }> = [];
  
  // Check all pairs of beats for proximity violations
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const beat1 = routes[i];
      const beat2 = routes[j];
      
      // Check all customers in beat1 against all customers in beat2
      for (const customer1 of beat1.stops) {
        for (const customer2 of beat2.stops) {
          const distance = calculateHaversineDistance(
            customer1.latitude, customer1.longitude,
            customer2.latitude, customer2.longitude
          );
          
          if (distance < minDistance) {
            violations.push({
              customer: customer1,
              fromBeatId: beat1.salesmanId,
              toBeatId: beat2.salesmanId,
              distance
            });
          }
        }
      }
    }
  }
  
  return violations;
}

function calculateBeatConflicts(
  customer: RouteStop,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  minDistance: number
): number {
  let conflicts = 0;
  
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < minDistance) {
        conflicts++;
      }
    }
  }
  
  return conflicts;
}

function moveCustomerBetweenBeats(
  customer: RouteStop,
  fromBeatId: number,
  toBeatId: number,
  routes: SalesmanRoute[]
): void {
  const fromBeat = routes.find(r => r.salesmanId === fromBeatId);
  const toBeat = routes.find(r => r.salesmanId === toBeatId);
  
  if (fromBeat && toBeat) {
    // Remove from source beat
    const customerIndex = fromBeat.stops.findIndex(s => s.customerId === customer.customerId);
    if (customerIndex !== -1) {
      fromBeat.stops.splice(customerIndex, 1);
    }
    
    // Add to target beat
    toBeat.stops.push(customer);
  }
}

function checkBeatIsolation(routes: SalesmanRoute[], minDistance: number): number {
  let violations = 0;
  
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const beat1 = routes[i];
      const beat2 = routes[j];
      
      for (const stop1 of beat1.stops) {
        for (const stop2 of beat2.stops) {
          const distance = calculateHaversineDistance(
            stop1.latitude, stop1.longitude,
            stop2.latitude, stop2.longitude
          );
          
          if (distance < minDistance) {
            violations++;
          }
        }
      }
    }
  }
  
  return violations;
}

function verifyBeatIsolation(routes: SalesmanRoute[]): {
  totalViolations: number;
  minDistanceBetweenBeats: number;
  averageDistanceBetweenBeats: number;
} {
  const ISOLATION_DISTANCE = 0.5; // 500 meters
  let violations = 0;
  let minDistance = Infinity;
  let totalDistance = 0;
  let distanceCount = 0;
  
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const beat1 = routes[i];
      const beat2 = routes[j];
      
      for (const stop1 of beat1.stops) {
        for (const stop2 of beat2.stops) {
          const distance = calculateHaversineDistance(
            stop1.latitude, stop1.longitude,
            stop2.latitude, stop2.longitude
          );
          
          if (distance < ISOLATION_DISTANCE) {
            violations++;
          }
          
          minDistance = Math.min(minDistance, distance);
          totalDistance += distance;
          distanceCount++;
        }
      }
    }
  }
  
  return {
    totalViolations: violations,
    minDistanceBetweenBeats: minDistance === Infinity ? 0 : minDistance,
    averageDistanceBetweenBeats: distanceCount > 0 ? totalDistance / distanceCount : 0
  };
}

async function performDBSCANWithinCluster(
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number
): Promise<ClusteredCustomer[][]> {
  const groups: ClusteredCustomer[][] = [];
  const visited = new Set<string>();
  const processed = new Set<string>();
  
  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    
    if (visited.has(customer.id) || processed.has(customer.id)) continue;
    
    visited.add(customer.id);
    const neighbors = getNeighborsWithinRadius(customer, customers, eps, processed);
    
    if (neighbors.length < minPts) {
      // Mark as noise but continue
      continue;
    } else {
      const group: ClusteredCustomer[] = [];
      expandDBSCANGroup(customer, neighbors, group, visited, customers, eps, minPts, processed);
      if (group.length > 0) {
        groups.push(group);
        // Mark all group members as processed
        group.forEach(c => processed.add(c.id));
      }
    }
    
    // Yield control every 20 customers
    if (i % 20 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Handle remaining unprocessed customers as individual groups
  const unprocessedCustomers = customers.filter(c => !processed.has(c.id));
  unprocessedCustomers.forEach(customer => {
    groups.push([customer]);
  });
  
  return groups;
}

function getNeighborsWithinRadius(
  customer: ClusteredCustomer,
  customers: ClusteredCustomer[],
  eps: number,
  processed: Set<string>
): ClusteredCustomer[] {
  const neighbors: ClusteredCustomer[] = [];
  
  for (const other of customers) {
    if (customer.id !== other.id && !processed.has(other.id)) {
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

function expandDBSCANGroup(
  customer: ClusteredCustomer,
  neighbors: ClusteredCustomer[],
  group: ClusteredCustomer[],
  visited: Set<string>,
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number,
  processed: Set<string>
): void {
  group.push(customer);
  processed.add(customer.id);
  
  // Limit expansion to prevent excessive processing
  const maxExpansion = Math.min(neighbors.length, 100);
  
  for (let i = 0; i < Math.min(neighbors.length, maxExpansion); i++) {
    const neighbor = neighbors[i];
    
    if (!visited.has(neighbor.id)) {
      visited.add(neighbor.id);
      
      const neighborNeighbors = getNeighborsWithinRadius(neighbor, customers, eps, processed);
      
      if (neighborNeighbors.length >= minPts) {
        // Add only new neighbors to prevent duplicates
        neighborNeighbors.forEach(nn => {
          if (!neighbors.some(existing => existing.id === nn.id)) {
            neighbors.push(nn);
          }
        });
      }
    }
    
    if (!group.some(c => c.id === neighbor.id) && !processed.has(neighbor.id)) {
      group.push(neighbor);
      processed.add(neighbor.id);
    }
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