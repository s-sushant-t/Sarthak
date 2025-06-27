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
  
  const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
  console.log(`Target total beats: ${TARGET_TOTAL_BEATS}`);
  
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
  
  // Process each cluster independently with exact beat count control
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers using controlled DBSCAN`);
    console.log(`Target: exactly ${config.beatsPerCluster} beats for this cluster`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create exactly the target number of beats for this cluster
    const clusterRoutes = createExactDBSCANBeats(
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
    
    console.log(`Cluster ${clusterId} complete: exactly ${clusterRoutes.length} DBSCAN-based beats created`);
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
        route.clusterIds.includes(customer.clusterId) && 
        route.stops.length < config.maxOutletsPerBeat
      );
      
      let targetRoute = sameClusterRoutes[0];
      
      if (!targetRoute) {
        // Find any route with space
        targetRoute = routes.find(route => route.stops.length < config.maxOutletsPerBeat);
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
    console.warn(`BEAT COUNT WARNING: Expected ${TARGET_TOTAL_BEATS} beats, got ${finalRoutes.length} beats`);
  }
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `DBSCAN Beat Formation (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function createExactDBSCANBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating exactly ${targetBeats} DBSCAN-based beats for cluster ${clusterId} with ${customers.length} customers`);
  
  // Calculate optimal distance parameter based on customer density and target beats
  const avgCustomersPerBeat = Math.ceil(customers.length / targetBeats);
  const optimalDistance = calculateOptimalDistance(customers, targetBeats);
  
  console.log(`Optimal distance parameter: ${optimalDistance.toFixed(3)}km (${(optimalDistance * 1000).toFixed(0)}m)`);
  console.log(`Average customers per beat: ${avgCustomersPerBeat}`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Try different DBSCAN parameters to get close to target beat count
  let bestRoutes: SalesmanRoute[] = [];
  let bestBeatCount = 0;
  let bestDistance = 0;
  
  // Test different distance parameters around the optimal distance
  const testDistances = [
    optimalDistance * 0.5,
    optimalDistance * 0.7,
    optimalDistance,
    optimalDistance * 1.3,
    optimalDistance * 1.5,
    optimalDistance * 2.0
  ];
  
  for (const testDistance of testDistances) {
    const testRoutes = tryDBSCANWithDistance(
      customers,
      distributor,
      config,
      salesmanId,
      clusterId,
      assignedIds, // Pass the shared assignedIds set
      testDistance,
      targetBeats
    );
    
    console.log(`Distance ${(testDistance * 1000).toFixed(0)}m produced ${testRoutes.length} beats`);
    
    // Choose the result closest to target beat count
    if (Math.abs(testRoutes.length - targetBeats) < Math.abs(bestBeatCount - targetBeats)) {
      bestRoutes = testRoutes;
      bestBeatCount = testRoutes.length;
      bestDistance = testDistance;
    }
    
    // If we hit the exact target, use it
    if (testRoutes.length === targetBeats) {
      bestRoutes = testRoutes;
      bestBeatCount = testRoutes.length;
      bestDistance = testDistance;
      break;
    }
  }
  
  console.log(`Best result: ${bestBeatCount} beats with distance ${(bestDistance * 1000).toFixed(0)}m`);
  
  // If we still don't have the exact number of beats, adjust by splitting or merging
  const adjustedRoutes = adjustToExactBeatCount(bestRoutes, targetBeats, config, distributor, clusterId);
  
  // Assign customer IDs to the assignedIds set
  adjustedRoutes.forEach(route => {
    route.stops.forEach(stop => {
      assignedIds.add(stop.customerId);
    });
  });
  
  // Reassign salesman IDs
  return adjustedRoutes.map((route, index) => ({
    ...route,
    salesmanId: salesmanId + index
  }));
}

function calculateOptimalDistance(customers: ClusteredCustomer[], targetBeats: number): number {
  if (customers.length <= 1) return 0.2; // Default 200m
  
  // Calculate all pairwise distances
  const distances: number[] = [];
  for (let i = 0; i < customers.length; i++) {
    for (let j = i + 1; j < customers.length; j++) {
      const distance = calculateHaversineDistance(
        customers[i].latitude, customers[i].longitude,
        customers[j].latitude, customers[j].longitude
      );
      distances.push(distance);
    }
  }
  
  // Sort distances
  distances.sort((a, b) => a - b);
  
  // Use a percentile based on target beat density
  const avgCustomersPerBeat = customers.length / targetBeats;
  let percentile = 0.3; // Default to 30th percentile
  
  if (avgCustomersPerBeat <= 10) {
    percentile = 0.2; // Smaller clusters for fewer customers per beat
  } else if (avgCustomersPerBeat <= 20) {
    percentile = 0.3;
  } else if (avgCustomersPerBeat <= 30) {
    percentile = 0.4;
  } else {
    percentile = 0.5; // Larger clusters for more customers per beat
  }
  
  const index = Math.floor(distances.length * percentile);
  const optimalDistance = distances[Math.min(index, distances.length - 1)];
  
  // Ensure minimum distance of 50m and maximum of 1km
  return Math.max(0.05, Math.min(1.0, optimalDistance));
}

function tryDBSCANWithDistance(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  eps: number,
  targetBeats: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // DBSCAN parameters
  const MIN_PTS = Math.max(2, Math.floor(customers.length / targetBeats * 0.3)); // Minimum points for a cluster
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Apply DBSCAN clustering to find dense groups
  const dbscanClusters = performDBSCAN(remainingCustomers, eps, MIN_PTS);
  
  // Process each DBSCAN cluster to create beats
  dbscanClusters.forEach((dbscanCluster) => {
    // If the DBSCAN cluster is too large, split it into multiple beats
    if (dbscanCluster.length > config.maxOutletsPerBeat) {
      const subBeats = splitLargeCluster(dbscanCluster, config.maxOutletsPerBeat, distributor);
      subBeats.forEach(subBeat => {
        const route = createRouteFromCustomers(subBeat, salesmanId++, clusterId, distributor, config, assignedIds);
        if (route) routes.push(route);
      });
    } else if (dbscanCluster.length >= Math.max(1, config.minOutletsPerBeat * 0.5)) {
      // Create a single beat from this DBSCAN cluster (relaxed minimum)
      const route = createRouteFromCustomers(dbscanCluster, salesmanId++, clusterId, distributor, config, assignedIds);
      if (route) routes.push(route);
    }
  });
  
  // Handle any remaining unassigned customers
  const assignedCustomerIds = new Set(routes.flatMap(route => route.stops.map(stop => stop.customerId)));
  const unassignedCustomers = remainingCustomers.filter(c => !assignedCustomerIds.has(c.id));
  
  if (unassignedCustomers.length > 0) {
    // Try to assign to existing routes first
    unassignedCustomers.forEach(customer => {
      // Find the nearest route with space
      let bestRoute = null;
      let minDistance = Infinity;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat) {
          // Calculate average distance to this route's customers
          if (route.stops.length > 0) {
            const avgDistance = route.stops.reduce((sum, stop) => {
              return sum + calculateHaversineDistance(
                customer.latitude, customer.longitude,
                stop.latitude, stop.longitude
              );
            }, 0) / route.stops.length;
            
            if (avgDistance < minDistance) {
              minDistance = avgDistance;
              bestRoute = route;
            }
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
      } else {
        // Create a new route for remaining customers
        const newRoute = createRouteFromCustomers([customer], salesmanId++, clusterId, distributor, config, assignedIds);
        if (newRoute) routes.push(newRoute);
      }
    });
  }
  
  return routes;
}

function adjustToExactBeatCount(
  routes: SalesmanRoute[],
  targetBeats: number,
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  clusterId: number
): SalesmanRoute[] {
  if (routes.length === targetBeats) {
    return routes;
  }
  
  console.log(`Adjusting from ${routes.length} beats to exactly ${targetBeats} beats`);
  
  if (routes.length < targetBeats) {
    // Need to split some routes
    const routesToSplit = routes.filter(route => route.stops.length >= config.minOutletsPerBeat * 2);
    routesToSplit.sort((a, b) => b.stops.length - a.stops.length); // Split largest first
    
    let currentRoutes = [...routes];
    
    while (currentRoutes.length < targetBeats && routesToSplit.length > 0) {
      const routeToSplit = routesToSplit.shift();
      if (!routeToSplit) break;
      
      const routeIndex = currentRoutes.findIndex(r => r.salesmanId === routeToSplit.salesmanId);
      if (routeIndex === -1) continue;
      
      // Split the route into two
      const midPoint = Math.ceil(routeToSplit.stops.length / 2);
      const firstHalf = routeToSplit.stops.slice(0, midPoint);
      const secondHalf = routeToSplit.stops.slice(midPoint);
      
      // Update the existing route
      currentRoutes[routeIndex] = {
        ...routeToSplit,
        stops: firstHalf
      };
      
      // Create a new route
      const newRoute: SalesmanRoute = {
        salesmanId: Math.max(...currentRoutes.map(r => r.salesmanId)) + 1,
        stops: secondHalf,
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [clusterId],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      };
      
      currentRoutes.push(newRoute);
      
      // If the new route is still large enough to split, add it to the split list
      if (newRoute.stops.length >= config.minOutletsPerBeat * 2 && currentRoutes.length < targetBeats) {
        routesToSplit.push(newRoute);
        routesToSplit.sort((a, b) => b.stops.length - a.stops.length);
      }
    }
    
    // If we still need more beats, create empty beats and distribute customers
    while (currentRoutes.length < targetBeats) {
      const newRoute: SalesmanRoute = {
        salesmanId: Math.max(...currentRoutes.map(r => r.salesmanId)) + 1,
        stops: [],
        totalDistance: 0,
        totalTime: 0,
        clusterIds: [clusterId],
        distributorLat: distributor.latitude,
        distributorLng: distributor.longitude
      };
      currentRoutes.push(newRoute);
    }
    
    // Redistribute customers more evenly
    return redistributeCustomers(currentRoutes, config);
    
  } else {
    // Need to merge some routes
    let currentRoutes = [...routes];
    currentRoutes.sort((a, b) => a.stops.length - b.stops.length); // Merge smallest first
    
    while (currentRoutes.length > targetBeats) {
      const smallestRoute = currentRoutes.shift();
      if (!smallestRoute) break;
      
      // Find the best route to merge with (closest geographically)
      let bestMergeRoute = null;
      let minDistance = Infinity;
      
      for (const route of currentRoutes) {
        if (route.stops.length + smallestRoute.stops.length <= config.maxOutletsPerBeat) {
          // Calculate average distance between the two routes
          let totalDistance = 0;
          let count = 0;
          
          for (const stop1 of smallestRoute.stops) {
            for (const stop2 of route.stops) {
              totalDistance += calculateHaversineDistance(
                stop1.latitude, stop1.longitude,
                stop2.latitude, stop2.longitude
              );
              count++;
            }
          }
          
          const avgDistance = count > 0 ? totalDistance / count : 0;
          if (avgDistance < minDistance) {
            minDistance = avgDistance;
            bestMergeRoute = route;
          }
        }
      }
      
      if (bestMergeRoute) {
        // Merge the routes
        bestMergeRoute.stops.push(...smallestRoute.stops);
      } else {
        // Can't merge, put it back
        currentRoutes.push(smallestRoute);
        break;
      }
    }
    
    return currentRoutes;
  }
}

function redistributeCustomers(
  routes: SalesmanRoute[],
  config: ClusteringConfig
): SalesmanRoute[] {
  // Collect all customers
  const allCustomers = routes.flatMap(route => route.stops);
  
  // Clear all routes
  routes.forEach(route => {
    route.stops = [];
  });
  
  // Distribute customers evenly across routes
  const customersPerRoute = Math.ceil(allCustomers.length / routes.length);
  
  allCustomers.forEach((customer, index) => {
    const routeIndex = Math.floor(index / customersPerRoute);
    if (routeIndex < routes.length) {
      routes[routeIndex].stops.push(customer);
    } else {
      // Add to the last route if we have extras
      routes[routes.length - 1].stops.push(customer);
    }
  });
  
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