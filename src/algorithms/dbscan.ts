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
      const clusterRoutes = await createDBSCANBeatsWithStrictCount(
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

async function createDBSCANBeatsWithStrictCount(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  if (customers.length === 0) return [];
  
  console.log(`Creating exactly ${targetBeats} DBSCAN-based beats for cluster ${clusterId} with ${customers.length} customers`);
  
  // Step 1: Apply DBSCAN to find geographically isolated groups within the cluster
  const EPS = 0.2; // 200 meters in kilometers
  const MIN_PTS = Math.max(2, Math.floor(config.minOutletsPerBeat * 0.3)); // Flexible minimum
  
  const dbscanGroups = await performDBSCANWithinCluster(customers, EPS, MIN_PTS);
  console.log(`DBSCAN found ${dbscanGroups.length} geographically isolated groups in cluster ${clusterId}`);
  
  // Step 2: Create exactly targetBeats number of beats by intelligently distributing DBSCAN groups
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
  
  // Step 3: Distribute DBSCAN groups to beats ensuring geographical isolation within beats
  const unassignedCustomers = [...customers];
  
  // First, assign complete DBSCAN groups to beats
  dbscanGroups.forEach((group, groupIndex) => {
    const targetBeatIndex = groupIndex % targetBeats;
    const targetBeat = routes[targetBeatIndex];
    
    // Check if adding this group would violate geographical isolation within the beat
    if (targetBeat.stops.length === 0 || isGeographicallyCompatible(group, targetBeat.stops, EPS)) {
      // Add all customers from this group to the target beat
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
          
          // Remove from unassigned list
          const unassignedIndex = unassignedCustomers.findIndex(c => c.id === customer.id);
          if (unassignedIndex !== -1) {
            unassignedCustomers.splice(unassignedIndex, 1);
          }
        }
      });
      
      console.log(`Assigned DBSCAN group ${groupIndex} (${group.length} customers) to beat ${targetBeat.salesmanId}`);
    }
  });
  
  // Step 4: Distribute remaining unassigned customers while maintaining geographical isolation
  unassignedCustomers.forEach(customer => {
    if (assignedIds.has(customer.id)) return;
    
    // Find the beat with the least customers that can accommodate this customer geographically
    let bestBeat: SalesmanRoute | null = null;
    let minSize = Infinity;
    
    for (const beat of routes) {
      if (beat.stops.length < config.maxOutletsPerBeat) {
        // Check geographical compatibility
        if (beat.stops.length === 0 || isCustomerCompatibleWithBeat(customer, beat.stops, EPS)) {
          if (beat.stops.length < minSize) {
            minSize = beat.stops.length;
            bestBeat = beat;
          }
        }
      }
    }
    
    // If no geographically compatible beat found, assign to the smallest beat anyway
    if (!bestBeat) {
      bestBeat = routes.reduce((min, route) => 
        route.stops.length < min.stops.length ? route : min
      );
      console.warn(`Customer ${customer.id} assigned to beat ${bestBeat.salesmanId} without geographical isolation`);
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
  
  console.log(`Cluster ${clusterId}: Created exactly ${routes.length} beats as required`);
  
  // Log beat sizes for verification
  const beatSizes = routes.map(route => route.stops.length);
  console.log(`Beat sizes in cluster ${clusterId}: ${beatSizes.join(', ')}`);
  
  return routes;
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

function isGeographicallyCompatible(
  newGroup: ClusteredCustomer[],
  existingStops: RouteStop[],
  maxDistance: number
): boolean {
  // Check if the new group can be added while maintaining geographical isolation
  for (const newCustomer of newGroup) {
    for (const existingStop of existingStops) {
      const distance = calculateHaversineDistance(
        newCustomer.latitude, newCustomer.longitude,
        existingStop.latitude, existingStop.longitude
      );
      
      // If any customer in the new group is too far from existing stops, it's not compatible
      if (distance > maxDistance * 2) { // Allow some flexibility for beat formation
        return false;
      }
    }
  }
  
  return true;
}

function isCustomerCompatibleWithBeat(
  customer: ClusteredCustomer,
  beatStops: RouteStop[],
  maxDistance: number
): boolean {
  // Check if customer can be added to beat while maintaining geographical isolation
  if (beatStops.length === 0) return true;
  
  // Find the closest stop in the beat
  let minDistance = Infinity;
  for (const stop of beatStops) {
    const distance = calculateHaversineDistance(
      customer.latitude, customer.longitude,
      stop.latitude, stop.longitude
    );
    minDistance = Math.min(minDistance, distance);
  }
  
  // Customer is compatible if it's within reasonable distance of the beat
  return minDistance <= maxDistance * 3; // Allow some flexibility for beat formation
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