import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

const PROXIMITY_CONSTRAINT = 0.2; // 200 meters in kilometers - strict constraint

export const dbscan = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-constrained DBSCAN beat formation with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`STRICT PROXIMITY CONSTRAINT: All outlets within 200m of each other in the same beat`);
  console.log(`Minimum outlets per beat: ${config.minOutletsPerBeat}`);
  
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
    
    // Process each cluster independently using proximity-constrained DBSCAN
    for (const clusterId of Object.keys(customersByCluster)) {
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers using proximity-constrained DBSCAN`);
      
      // CRITICAL: Track assigned customers within this cluster only
      const clusterAssignedIds = new Set<string>();
      
      // Create proximity-constrained DBSCAN beats within the cluster
      const clusterRoutes = await createProximityConstrainedDBSCANBeats(
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
        
        // Find and assign missing customers with strict proximity constraints
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to compatible routes only
        missingCustomers.forEach(customer => {
          const compatibleRoute = findStrictlyCompatibleRoute(customer, clusterRoutes, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
          
          if (compatibleRoute) {
            compatibleRoute.stops.push({
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
            console.log(`Force-assigned missing customer ${customer.id} to route ${compatibleRoute.salesmanId} (proximity satisfied)`);
          } else {
            // Create new beat for incompatible customer
            const newRoute: SalesmanRoute = {
              salesmanId: currentSalesmanId + clusterRoutes.length,
              stops: [{
                customerId: customer.id,
                latitude: customer.latitude,
                longitude: customer.longitude,
                distanceToNext: 0,
                timeToNext: 0,
                visitTime: config.customerVisitTimeMinutes,
                clusterId: customer.clusterId,
                outletName: customer.outletName
              }],
              totalDistance: 0,
              totalTime: 0,
              clusterIds: [Number(clusterId)],
              distributorLat: distributor.latitude,
              distributorLng: distributor.longitude
            };
            clusterRoutes.push(newRoute);
            clusterAssignedIds.add(customer.id);
            console.log(`Created new proximity-constrained beat ${newRoute.salesmanId} for customer ${customer.id}`);
          }
        });
      }
      
      // Add cluster customers to global tracking
      clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
      
      routes.push(...clusterRoutes);
      currentSalesmanId += clusterRoutes.length;
      
      console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} proximity-constrained DBSCAN beats created`);
      
      // Yield control to prevent blocking
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // CRITICAL: Apply equal distribution balancing while maintaining proximity constraints
    const balancedRoutes = await balanceRoutesWithProximityConstraints(routes, config, distributor);
    
    // CRITICAL: Final verification - ensure ALL customers are assigned exactly once
    const finalAssignedCount = globalAssignedCustomerIds.size;
    const totalCustomers = allCustomers.length;
    
    console.log(`GLOBAL VERIFICATION: ${finalAssignedCount}/${totalCustomers} customers assigned`);
    
    if (finalAssignedCount !== totalCustomers) {
      console.error(`CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
      
      // Emergency assignment of missing customers with proximity constraints
      const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
      console.error('Missing customers:', missingCustomers.map(c => c.id));
      
      missingCustomers.forEach(customer => {
        // Find a compatible route in the same cluster
        const sameClusterRoutes = balancedRoutes.filter(route => 
          route.clusterIds.includes(customer.clusterId)
        );
        
        const compatibleRoute = findStrictlyCompatibleRoute(customer, sameClusterRoutes, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
        
        if (compatibleRoute) {
          compatibleRoute.stops.push({
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
          console.log(`Emergency assigned customer ${customer.id} to route ${compatibleRoute.salesmanId} (proximity satisfied)`);
        } else {
          // Create emergency route for incompatible customer
          const emergencyRoute: SalesmanRoute = {
            salesmanId: balancedRoutes.length + 1,
            stops: [{
              customerId: customer.id,
              latitude: customer.latitude,
              longitude: customer.longitude,
              distanceToNext: 0,
              timeToNext: 0,
              visitTime: config.customerVisitTimeMinutes,
              clusterId: customer.clusterId,
              outletName: customer.outletName
            }],
            totalDistance: 0,
            totalTime: 0,
            clusterIds: [customer.clusterId],
            distributorLat: distributor.latitude,
            distributorLng: distributor.longitude
          };
          balancedRoutes.push(emergencyRoute);
          globalAssignedCustomerIds.add(customer.id);
          console.log(`Created emergency proximity-constrained beat for customer ${customer.id}`);
        }
      });
    }
    
    // Update route metrics for all routes
    balancedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // CRITICAL: Apply minimum beat size enforcement - merge undersized beats with nearest beats
    const finalRoutes = enforceMinimumBeatSize(balancedRoutes, config, distributor, PROXIMITY_CONSTRAINT);
    
    // Reassign beat IDs sequentially after merging
    const sequentialRoutes = finalRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    // FINAL verification and proximity validation
    const finalCustomerCount = sequentialRoutes.reduce((count, route) => count + route.stops.length, 0);
    const uniqueCustomerIds = new Set(sequentialRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
    
    console.log(`FINAL VERIFICATION:`);
    console.log(`- Total customers in routes: ${finalCustomerCount}`);
    console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
    console.log(`- Expected customers: ${totalCustomers}`);
    console.log(`- Total beats created: ${sequentialRoutes.length}`);
    
    // Validate strict proximity constraints
    const proximityViolations = validateStrictProximityConstraints(sequentialRoutes, PROXIMITY_CONSTRAINT);
    console.log(`- Proximity constraint violations: ${proximityViolations}`);
    
    // Validate minimum beat size enforcement
    const undersizedBeats = sequentialRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
    console.log(`- Beats below minimum size (${config.minOutletsPerBeat}): ${undersizedBeats.length}`);
    
    // Report beats per cluster
    const beatsByCluster = sequentialRoutes.reduce((acc, route) => {
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
    
    // Calculate total distance (not optimized, just for reporting)
    const totalDistance = sequentialRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    return {
      name: `Proximity-Constrained DBSCAN Beat Formation (${config.totalClusters} Clusters, ${sequentialRoutes.length} Beats, 200m Strict Constraint, Min Size Enforced)`,
      totalDistance,
      totalSalesmen: sequentialRoutes.length,
      processingTime: Date.now() - startTime,
      routes: sequentialRoutes
    };
    
  } catch (error) {
    console.error('Proximity-constrained DBSCAN algorithm failed:', error);
    throw error; // Re-throw to let the caller handle fallback
  }
};

function enforceMinimumBeatSize(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  proximityConstraint: number
): SalesmanRoute[] {
  console.log(`Enforcing minimum beat size of ${config.minOutletsPerBeat} outlets per beat...`);
  
  const processedRoutes = [...routes];
  let mergesMade = true;
  let iterationCount = 0;
  const maxIterations = 10; // Prevent infinite loops
  
  while (mergesMade && iterationCount < maxIterations) {
    mergesMade = false;
    iterationCount++;
    
    console.log(`Minimum beat size enforcement iteration ${iterationCount}`);
    
    // Find beats that are below the minimum size
    const undersizedBeats = processedRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
    
    if (undersizedBeats.length === 0) {
      console.log('All beats meet minimum size requirement');
      break;
    }
    
    console.log(`Found ${undersizedBeats.length} beats below minimum size of ${config.minOutletsPerBeat}`);
    
    // Process each undersized beat
    for (const undersizedBeat of undersizedBeats) {
      if (undersizedBeat.stops.length >= config.minOutletsPerBeat) {
        continue; // Skip if already processed in this iteration
      }
      
      console.log(`Processing undersized beat ${undersizedBeat.salesmanId} with ${undersizedBeat.stops.length} outlets`);
      
      // Find the nearest beat that can accommodate the undersized beat's outlets
      const nearestCompatibleBeat = findNearestCompatibleBeat(
        undersizedBeat,
        processedRoutes,
        config,
        proximityConstraint
      );
      
      if (nearestCompatibleBeat) {
        console.log(`Merging beat ${undersizedBeat.salesmanId} (${undersizedBeat.stops.length} outlets) with beat ${nearestCompatibleBeat.salesmanId} (${nearestCompatibleBeat.stops.length} outlets)`);
        
        // Check if all outlets from undersized beat can be added while maintaining proximity constraint
        const canMergeAll = undersizedBeat.stops.every(stop => {
          return nearestCompatibleBeat.stops.every(existingStop => {
            const distance = calculateHaversineDistance(
              stop.latitude, stop.longitude,
              existingStop.latitude, existingStop.longitude
            );
            return distance <= proximityConstraint;
          });
        });
        
        if (canMergeAll && nearestCompatibleBeat.stops.length + undersizedBeat.stops.length <= config.maxOutletsPerBeat) {
          // Merge all outlets from undersized beat to nearest compatible beat
          nearestCompatibleBeat.stops.push(...undersizedBeat.stops);
          
          // Update route metrics
          updateRouteMetrics(nearestCompatibleBeat, distributor, config);
          
          // Remove the undersized beat from the list
          const undersizedIndex = processedRoutes.findIndex(r => r.salesmanId === undersizedBeat.salesmanId);
          if (undersizedIndex !== -1) {
            processedRoutes.splice(undersizedIndex, 1);
            mergesMade = true;
            console.log(`Successfully merged beat ${undersizedBeat.salesmanId} into beat ${nearestCompatibleBeat.salesmanId}`);
          }
        } else {
          console.log(`Cannot merge beat ${undersizedBeat.salesmanId} with beat ${nearestCompatibleBeat.salesmanId} due to proximity or size constraints`);
          
          // Try to merge individual outlets that satisfy proximity constraint
          const outletsToMove: RouteStop[] = [];
          
          for (const stop of undersizedBeat.stops) {
            const satisfiesProximity = nearestCompatibleBeat.stops.every(existingStop => {
              const distance = calculateHaversineDistance(
                stop.latitude, stop.longitude,
                existingStop.latitude, existingStop.longitude
              );
              return distance <= proximityConstraint;
            });
            
            if (satisfiesProximity && nearestCompatibleBeat.stops.length < config.maxOutletsPerBeat) {
              outletsToMove.push(stop);
              nearestCompatibleBeat.stops.push(stop);
            }
          }
          
          if (outletsToMove.length > 0) {
            // Remove moved outlets from undersized beat
            undersizedBeat.stops = undersizedBeat.stops.filter(stop => 
              !outletsToMove.some(moved => moved.customerId === stop.customerId)
            );
            
            updateRouteMetrics(nearestCompatibleBeat, distributor, config);
            updateRouteMetrics(undersizedBeat, distributor, config);
            
            console.log(`Moved ${outletsToMove.length} outlets from beat ${undersizedBeat.salesmanId} to beat ${nearestCompatibleBeat.salesmanId}`);
            
            // If undersized beat is now empty, remove it
            if (undersizedBeat.stops.length === 0) {
              const undersizedIndex = processedRoutes.findIndex(r => r.salesmanId === undersizedBeat.salesmanId);
              if (undersizedIndex !== -1) {
                processedRoutes.splice(undersizedIndex, 1);
                mergesMade = true;
                console.log(`Removed empty beat ${undersizedBeat.salesmanId}`);
              }
            }
          }
        }
      } else {
        console.log(`No compatible beat found for undersized beat ${undersizedBeat.salesmanId} - keeping as is`);
      }
    }
  }
  
  // Final report
  const finalUndersizedBeats = processedRoutes.filter(route => route.stops.length < config.minOutletsPerBeat);
  console.log(`Minimum beat size enforcement complete after ${iterationCount} iterations`);
  console.log(`Remaining beats below minimum size: ${finalUndersizedBeats.length}`);
  
  if (finalUndersizedBeats.length > 0) {
    console.log('Remaining undersized beats:', finalUndersizedBeats.map(r => 
      `Beat ${r.salesmanId}: ${r.stops.length} outlets`
    ));
  }
  
  return processedRoutes;
}

function findNearestCompatibleBeat(
  undersizedBeat: SalesmanRoute,
  allRoutes: SalesmanRoute[],
  config: ClusteringConfig,
  proximityConstraint: number
): SalesmanRoute | null {
  let nearestBeat: SalesmanRoute | null = null;
  let shortestDistance = Infinity;
  
  // Calculate centroid of undersized beat
  const undersizedCentroid = calculateRouteCentroid(undersizedBeat);
  
  for (const candidateBeat of allRoutes) {
    // Skip the undersized beat itself
    if (candidateBeat.salesmanId === undersizedBeat.salesmanId) continue;
    
    // Skip if candidate beat is also undersized (to avoid merging two undersized beats)
    if (candidateBeat.stops.length < config.minOutletsPerBeat) continue;
    
    // Skip if merging would exceed maximum beat size
    if (candidateBeat.stops.length + undersizedBeat.stops.length > config.maxOutletsPerBeat) continue;
    
    // Prefer beats in the same cluster
    const sameCluster = candidateBeat.clusterIds.some(id => undersizedBeat.clusterIds.includes(id));
    if (!sameCluster) continue;
    
    // Calculate distance between beat centroids
    const candidateCentroid = calculateRouteCentroid(candidateBeat);
    const distance = calculateHaversineDistance(
      undersizedCentroid.latitude, undersizedCentroid.longitude,
      candidateCentroid.latitude, candidateCentroid.longitude
    );
    
    // Check if this is the nearest compatible beat so far
    if (distance < shortestDistance) {
      shortestDistance = distance;
      nearestBeat = candidateBeat;
    }
  }
  
  if (nearestBeat) {
    console.log(`Found nearest compatible beat ${nearestBeat.salesmanId} at distance ${shortestDistance.toFixed(3)}km`);
  }
  
  return nearestBeat;
}

function calculateRouteCentroid(route: SalesmanRoute): { latitude: number; longitude: number } {
  if (route.stops.length === 0) {
    return { latitude: route.distributorLat, longitude: route.distributorLng };
  }
  
  const totalLat = route.stops.reduce((sum, stop) => sum + stop.latitude, 0);
  const totalLng = route.stops.reduce((sum, stop) => sum + stop.longitude, 0);
  
  return {
    latitude: totalLat / route.stops.length,
    longitude: totalLng / route.stops.length
  };
}

async function createProximityConstrainedDBSCANBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>
): Promise<SalesmanRoute[]> {
  if (customers.length === 0) return [];
  
  console.log(`Creating proximity-constrained DBSCAN beats for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`STRICT CONSTRAINT: All outlets within ${PROXIMITY_CONSTRAINT * 1000}m of each other`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // DBSCAN parameters optimized for 200m proximity constraint
  const EPS = PROXIMITY_CONSTRAINT; // 200 meters exactly
  const MIN_PTS = 2; // Minimum 2 points to form a cluster
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Apply strict proximity DBSCAN clustering
  const dbscanClusters = await performStrictProximityDBSCAN(remainingCustomers, EPS, MIN_PTS);
  
  console.log(`Strict proximity DBSCAN found ${dbscanClusters.length} valid clusters in cluster ${clusterId}`);
  
  // Process each DBSCAN cluster to create beats with equal distribution
  const targetBeatsPerCluster = Math.ceil(customers.length / ((config.minOutletsPerBeat + config.maxOutletsPerBeat) / 2));
  
  for (let index = 0; index < dbscanClusters.length; index++) {
    const dbscanCluster = dbscanClusters[index];
    console.log(`Processing DBSCAN cluster ${index} with ${dbscanCluster.length} customers`);
    
    // Ensure equal distribution: split large clusters, merge small ones
    if (dbscanCluster.length > config.maxOutletsPerBeat) {
      const subBeats = splitClusterWithProximityConstraint(dbscanCluster, config.maxOutletsPerBeat, PROXIMITY_CONSTRAINT);
      subBeats.forEach(subBeat => {
        const route = createRouteFromCustomersWithValidation(subBeat, salesmanId++, clusterId, distributor, config, assignedIds, PROXIMITY_CONSTRAINT);
        if (route) routes.push(route);
      });
    } else if (dbscanCluster.length >= config.minOutletsPerBeat) {
      // Create a single beat from this DBSCAN cluster
      const route = createRouteFromCustomersWithValidation(dbscanCluster, salesmanId++, clusterId, distributor, config, assignedIds, PROXIMITY_CONSTRAINT);
      if (route) routes.push(route);
    } else {
      // Small cluster - try to merge with nearby clusters or create standalone beat
      const route = createRouteFromCustomersWithValidation(dbscanCluster, salesmanId++, clusterId, distributor, config, assignedIds, PROXIMITY_CONSTRAINT);
      if (route) routes.push(route);
    }
    
    // Yield control periodically
    if (index % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Handle any remaining unassigned customers with strict proximity constraints
  const unassignedCustomers = remainingCustomers.filter(c => !assignedIds.has(c.id));
  if (unassignedCustomers.length > 0) {
    console.log(`Handling ${unassignedCustomers.length} unassigned customers in cluster ${clusterId} with proximity constraints`);
    
    // Group remaining customers into proximity-constrained beats
    while (unassignedCustomers.length > 0) {
      const proximityGroup = buildProximityConstrainedGroup(unassignedCustomers, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
      
      if (proximityGroup.length > 0) {
        const route = createRouteFromCustomersWithValidation(proximityGroup, salesmanId++, clusterId, distributor, config, assignedIds, PROXIMITY_CONSTRAINT);
        if (route) routes.push(route);
        
        // Remove assigned customers from unassigned list
        proximityGroup.forEach(customer => {
          const index = unassignedCustomers.findIndex(c => c.id === customer.id);
          if (index !== -1) unassignedCustomers.splice(index, 1);
        });
      } else {
        // If no proximity group can be formed, create individual beats
        const customer = unassignedCustomers.shift()!;
        const route = createRouteFromCustomersWithValidation([customer], salesmanId++, clusterId, distributor, config, assignedIds, PROXIMITY_CONSTRAINT);
        if (route) routes.push(route);
      }
      
      // Yield control
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  return routes;
}

async function balanceRoutesWithProximityConstraints(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number }
): Promise<SalesmanRoute[]> {
  console.log('Balancing routes for equal distribution while maintaining proximity constraints...');
  
  const balancedRoutes = [...routes];
  const targetSize = Math.ceil(balancedRoutes.reduce((sum, route) => sum + route.stops.length, 0) / balancedRoutes.length);
  
  console.log(`Target size per beat: ${targetSize} outlets`);
  
  // Identify oversized and undersized routes
  const oversizedRoutes = balancedRoutes.filter(r => r.stops.length > config.maxOutletsPerBeat);
  const undersizedRoutes = balancedRoutes.filter(r => r.stops.length < config.minOutletsPerBeat);
  
  console.log(`Found ${oversizedRoutes.length} oversized routes and ${undersizedRoutes.length} undersized routes`);
  
  // Try to balance by moving customers between compatible routes
  for (const oversizedRoute of oversizedRoutes) {
    const excess = oversizedRoute.stops.length - config.maxOutletsPerBeat;
    
    if (excess > 0) {
      // Find customers that can be moved while maintaining proximity in the source route
      const movableCustomers = findMovableCustomersWithProximityConstraint(oversizedRoute, excess, PROXIMITY_CONSTRAINT);
      
      for (const customer of movableCustomers) {
        // Find a compatible undersized route in the same cluster
        const compatibleRoute = undersizedRoutes.find(route => 
          route.clusterIds.some(id => oversizedRoute.clusterIds.includes(id)) &&
          route.stops.length < config.maxOutletsPerBeat &&
          canAddCustomerWithProximityConstraint(route, customer, PROXIMITY_CONSTRAINT)
        );
        
        if (compatibleRoute) {
          // Move customer
          const customerIndex = oversizedRoute.stops.findIndex(stop => stop.customerId === customer.id);
          if (customerIndex !== -1) {
            const stop = oversizedRoute.stops.splice(customerIndex, 1)[0];
            compatibleRoute.stops.push(stop);
            console.log(`Moved customer ${customer.id} from beat ${oversizedRoute.salesmanId} to beat ${compatibleRoute.salesmanId} (proximity maintained)`);
          }
        }
      }
    }
  }
  
  return balancedRoutes;
}

async function performStrictProximityDBSCAN(
  customers: ClusteredCustomer[],
  eps: number,
  minPts: number
): Promise<ClusteredCustomer[][]> {
  const clusters: ClusteredCustomer[][] = [];
  const visited = new Set<string>();
  const processed = new Set<string>();
  
  console.log(`Performing strict proximity DBSCAN with eps=${eps * 1000}m, minPts=${minPts}`);
  
  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    
    if (visited.has(customer.id) || processed.has(customer.id)) continue;
    
    visited.add(customer.id);
    const neighbors = getStrictProximityNeighbors(customer, customers, eps, processed);
    
    if (neighbors.length < minPts) {
      // Mark as noise but continue
      continue;
    } else {
      const cluster: ClusteredCustomer[] = [];
      expandStrictProximityCluster(customer, neighbors, cluster, visited, customers, eps, minPts, processed);
      
      // Validate that the entire cluster satisfies strict proximity constraints
      if (cluster.length > 0 && validateClusterStrictProximity(cluster, eps)) {
        clusters.push(cluster);
        // Mark all cluster members as processed
        cluster.forEach(c => processed.add(c.id));
      } else {
        console.warn(`Rejected cluster of ${cluster.length} customers due to proximity constraint violations`);
        // Unmark customers so they can be processed individually
        cluster.forEach(c => {
          visited.delete(c.id);
          processed.delete(c.id);
        });
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
    console.log(`Creating individual clusters for ${unprocessedCustomers.length} unprocessed customers`);
    unprocessedCustomers.forEach(customer => {
      clusters.push([customer]);
      processed.add(customer.id);
    });
  }
  
  console.log(`Strict proximity DBSCAN completed: ${clusters.length} valid clusters created`);
  
  return clusters;
}

function getStrictProximityNeighbors(
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

function expandStrictProximityCluster(
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
  
  // Limit expansion to prevent excessive processing and maintain strict proximity
  const maxExpansion = Math.min(neighbors.length, 50);
  
  for (let i = 0; i < Math.min(neighbors.length, maxExpansion); i++) {
    const neighbor = neighbors[i];
    
    if (!visited.has(neighbor.id)) {
      visited.add(neighbor.id);
      
      const neighborNeighbors = getStrictProximityNeighbors(neighbor, customers, eps, processed);
      
      if (neighborNeighbors.length >= minPts) {
        // Only add neighbors that maintain strict proximity with ALL existing cluster members
        neighborNeighbors.forEach(nn => {
          if (!neighbors.some(existing => existing.id === nn.id)) {
            const maintainsProximity = cluster.every(clusterMember => {
              const distance = calculateHaversineDistance(
                nn.latitude, nn.longitude,
                clusterMember.latitude, clusterMember.longitude
              );
              return distance <= eps;
            });
            
            if (maintainsProximity) {
              neighbors.push(nn);
            }
          }
        });
      }
    }
    
    if (!cluster.some(c => c.id === neighbor.id) && !processed.has(neighbor.id)) {
      // Verify that adding this neighbor maintains strict proximity with ALL cluster members
      const maintainsProximity = cluster.every(clusterMember => {
        const distance = calculateHaversineDistance(
          neighbor.latitude, neighbor.longitude,
          clusterMember.latitude, clusterMember.longitude
        );
        return distance <= eps;
      });
      
      if (maintainsProximity) {
        cluster.push(neighbor);
        processed.add(neighbor.id);
      }
    }
  }
}

function validateClusterStrictProximity(cluster: ClusteredCustomer[], eps: number): boolean {
  // Validate that ALL pairs of customers in the cluster are within the proximity constraint
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const distance = calculateHaversineDistance(
        cluster[i].latitude, cluster[i].longitude,
        cluster[j].latitude, cluster[j].longitude
      );
      
      if (distance > eps) {
        return false; // Strict proximity constraint violated
      }
    }
  }
  return true; // All pairs satisfy the constraint
}

function buildProximityConstrainedGroup(
  customers: ClusteredCustomer[],
  proximityConstraint: number,
  maxSize: number
): ClusteredCustomer[] {
  if (customers.length === 0) return [];
  
  const group = [customers[0]];
  
  // Add customers that satisfy proximity constraint with ALL existing group members
  for (let i = 1; i < customers.length && group.length < maxSize; i++) {
    const candidate = customers[i];
    
    const satisfiesProximity = group.every(groupMember => {
      const distance = calculateHaversineDistance(
        candidate.latitude, candidate.longitude,
        groupMember.latitude, groupMember.longitude
      );
      return distance <= proximityConstraint;
    });
    
    if (satisfiesProximity) {
      group.push(candidate);
    }
  }
  
  return group;
}

function splitClusterWithProximityConstraint(
  cluster: ClusteredCustomer[],
  maxSize: number,
  proximityConstraint: number
): ClusteredCustomer[][] {
  if (cluster.length <= maxSize) return [cluster];
  
  const subClusters: ClusteredCustomer[][] = [];
  const remaining = [...cluster];
  
  while (remaining.length > 0) {
    const subCluster = buildProximityConstrainedGroup(remaining, proximityConstraint, maxSize);
    
    if (subCluster.length > 0) {
      subClusters.push(subCluster);
      // Remove assigned customers from remaining
      subCluster.forEach(customer => {
        const index = remaining.findIndex(c => c.id === customer.id);
        if (index !== -1) remaining.splice(index, 1);
      });
    } else {
      // If no group can be formed, take individual customers
      subClusters.push([remaining.shift()!]);
    }
  }
  
  return subClusters;
}

function findMovableCustomersWithProximityConstraint(
  route: SalesmanRoute,
  maxToMove: number,
  proximityConstraint: number
): { id: string; latitude: number; longitude: number }[] {
  const movableCustomers: { id: string; latitude: number; longitude: number }[] = [];
  
  // Find customers that can be removed while maintaining proximity in the remaining route
  for (let i = 0; i < route.stops.length && movableCustomers.length < maxToMove; i++) {
    const customer = route.stops[i];
    
    // Check if removing this customer would still maintain proximity in the remaining route
    const remainingStops = route.stops.filter((_, index) => index !== i);
    
    if (remainingStops.length <= 1 || validateStopsStrictProximity(remainingStops, proximityConstraint)) {
      movableCustomers.push({
        id: customer.customerId,
        latitude: customer.latitude,
        longitude: customer.longitude
      });
    }
  }
  
  return movableCustomers;
}

function canAddCustomerWithProximityConstraint(
  route: SalesmanRoute,
  customer: { id: string; latitude: number; longitude: number },
  proximityConstraint: number
): boolean {
  // Check if customer satisfies proximity constraint with ALL customers in the route
  return route.stops.every(stop => {
    const distance = calculateHaversineDistance(
      customer.latitude, customer.longitude,
      stop.latitude, stop.longitude
    );
    return distance <= proximityConstraint;
  });
}

function validateStopsStrictProximity(stops: RouteStop[], proximityConstraint: number): boolean {
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      
      if (distance > proximityConstraint) {
        return false; // Proximity constraint violated
      }
    }
  }
  return true; // All pairs satisfy the constraint
}

function findStrictlyCompatibleRoute(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  proximityConstraint: number,
  maxOutletsPerBeat: number
): SalesmanRoute | null {
  for (const route of routes) {
    // Check if route has space
    if (route.stops.length >= maxOutletsPerBeat) continue;
    
    // Check if customer satisfies strict proximity constraint with ALL customers in the route
    const satisfiesProximity = route.stops.every(stop => {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      return distance <= proximityConstraint;
    });
    
    if (satisfiesProximity) {
      return route;
    }
  }
  
  return null;
}

function validateStrictProximityConstraints(routes: SalesmanRoute[], proximityConstraint: number): number {
  let violations = 0;
  
  routes.forEach(route => {
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        
        if (distance > proximityConstraint) {
          violations++;
          console.error(`STRICT PROXIMITY VIOLATION in beat ${route.salesmanId}: ${distance.toFixed(3)}km > ${proximityConstraint}km between outlets ${route.stops[i].customerId} and ${route.stops[j].customerId}`);
        }
      }
    }
  });
  
  return violations;
}

function createRouteFromCustomersWithValidation(
  customers: ClusteredCustomer[],
  salesmanId: number,
  clusterId: number,
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  assignedIds: Set<string>,
  proximityConstraint: number
): SalesmanRoute | null {
  if (customers.length === 0) return null;
  
  // Validate that all customers satisfy strict proximity constraint
  if (!validateClusterStrictProximity(customers, proximityConstraint)) {
    console.warn(`Rejected route creation: customers do not satisfy strict proximity constraint`);
    return null;
  }
  
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