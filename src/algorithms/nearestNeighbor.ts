import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-optimized nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Calculate mode distance between all outlets for constraint
  const modeDistance = calculateModeDistance(customers);
  console.log(`Mode distance between outlets: ${modeDistance.toFixed(2)} km`);
  
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
  
  // Process each cluster independently to ensure no cross-cluster contamination
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    console.log(`Target: ${config.beatsPerCluster} beats for this cluster`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create proximity-based linear routes within the cluster with strict mode distance constraint
    const clusterRoutes = createStrictProximityBasedRoutesInCluster(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds,
      modeDistance
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
            visitTime: 0, // No visit time constraint
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
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} proximity-based beats created`);
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
        visitTime: 0, // No visit time constraint
        clusterId: customer.clusterId,
        outletName: customer.outletName
      });
      
      globalAssignedCustomerIds.add(customer.id);
      console.log(`Emergency assigned customer ${customer.id} to route ${targetRoute.salesmanId}`);
    });
  }
  
  // Update route metrics for all routes
  routes.forEach(route => {
    updateRouteMetrics(route, distributor);
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
    name: `Proximity-Optimized Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function calculateModeDistance(customers: ClusteredCustomer[]): number {
  const distances: number[] = [];
  
  // Calculate distances between all pairs of customers
  for (let i = 0; i < customers.length; i++) {
    for (let j = i + 1; j < customers.length; j++) {
      const distance = calculateHaversineDistance(
        customers[i].latitude, customers[i].longitude,
        customers[j].latitude, customers[j].longitude
      );
      distances.push(distance);
    }
  }
  
  if (distances.length === 0) return 2; // Default fallback
  
  // Create frequency map with smaller binning for more precise mode
  const binSize = 0.2; // 0.2 km bins for better precision
  const frequencyMap = new Map<number, number>();
  
  distances.forEach(distance => {
    const bin = Math.round(distance / binSize) * binSize;
    frequencyMap.set(bin, (frequencyMap.get(bin) || 0) + 1);
  });
  
  // Find the bin with highest frequency (mode)
  let maxFrequency = 0;
  let modeDistance = 0;
  
  frequencyMap.forEach((frequency, bin) => {
    if (frequency > maxFrequency) {
      maxFrequency = frequency;
      modeDistance = bin;
    }
  });
  
  // Use a reasonable minimum that ensures tight clustering
  return Math.max(modeDistance, 1.5);
}

function createStrictProximityBasedRoutesInCluster(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  modeDistance: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating STRICT proximity-based routes for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`STRICT mode distance constraint: ${modeDistance.toFixed(2)} km`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Create beats using strict proximity clustering
  while (remainingCustomers.length > 0) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    console.log(`Creating STRICT beat ${route.salesmanId} from ${remainingCustomers.length} remaining customers`);
    
    // Start with the customer closest to distributor
    let seedIndex = 0;
    let minDistanceToDistributor = Infinity;
    
    for (let i = 0; i < remainingCustomers.length; i++) {
      const distance = calculateHaversineDistance(
        distributor.latitude, distributor.longitude,
        remainingCustomers[i].latitude, remainingCustomers[i].longitude
      );
      if (distance < minDistanceToDistributor) {
        minDistanceToDistributor = distance;
        seedIndex = i;
      }
    }
    
    // Add seed customer
    const seedCustomer = remainingCustomers.splice(seedIndex, 1)[0];
    assignedIds.add(seedCustomer.id);
    
    route.stops.push({
      customerId: seedCustomer.id,
      latitude: seedCustomer.latitude,
      longitude: seedCustomer.longitude,
      distanceToNext: 0,
      timeToNext: 0,
      visitTime: 0, // No visit time constraint
      clusterId: seedCustomer.clusterId,
      outletName: seedCustomer.outletName
    });
    
    console.log(`Seed customer for beat ${route.salesmanId}: ${seedCustomer.id}`);
    
    // Build tight cluster around seed customer using STRICT mode distance constraint
    let addedInThisIteration = true;
    while (addedInThisIteration && 
           route.stops.length < config.maxOutletsPerBeat && 
           remainingCustomers.length > 0) {
      
      addedInThisIteration = false;
      let bestCandidate = null;
      let bestCandidateIndex = -1;
      let minMaxDistance = Infinity;
      
      // Find customer that minimizes the maximum distance to any customer in the current beat
      for (let i = 0; i < remainingCustomers.length; i++) {
        const candidate = remainingCustomers[i];
        
        // Calculate maximum distance from this candidate to any customer in the current beat
        let maxDistanceInBeat = 0;
        let violatesConstraint = false;
        
        for (const stop of route.stops) {
          const distance = calculateHaversineDistance(
            candidate.latitude, candidate.longitude,
            stop.latitude, stop.longitude
          );
          
          if (distance > modeDistance) {
            violatesConstraint = true;
            break;
          }
          
          maxDistanceInBeat = Math.max(maxDistanceInBeat, distance);
        }
        
        // Only consider candidates that don't violate the mode distance constraint
        if (!violatesConstraint && maxDistanceInBeat < minMaxDistance) {
          minMaxDistance = maxDistanceInBeat;
          bestCandidate = candidate;
          bestCandidateIndex = i;
        }
      }
      
      // Add the best candidate if found
      if (bestCandidate && bestCandidateIndex !== -1) {
        const customer = remainingCustomers.splice(bestCandidateIndex, 1)[0];
        assignedIds.add(customer.id);
        
        route.stops.push({
          customerId: customer.id,
          latitude: customer.latitude,
          longitude: customer.longitude,
          distanceToNext: 0,
          timeToNext: 0,
          visitTime: 0, // No visit time constraint
          clusterId: customer.clusterId,
          outletName: customer.outletName
        });
        
        addedInThisIteration = true;
        console.log(`Added customer ${customer.id} to beat ${route.salesmanId} (max distance in beat: ${minMaxDistance.toFixed(2)} km)`);
      }
    }
    
    // Ensure minimum beat size if possible
    if (route.stops.length < config.minOutletsPerBeat && remainingCustomers.length > 0) {
      console.log(`Beat ${route.salesmanId} has only ${route.stops.length} customers, trying to add more...`);
      
      // Relax constraint slightly to meet minimum beat size
      const relaxedModeDistance = modeDistance * 1.2; // 20% relaxation
      
      while (route.stops.length < config.minOutletsPerBeat && 
             route.stops.length < config.maxOutletsPerBeat && 
             remainingCustomers.length > 0) {
        
        let bestCandidate = null;
        let bestCandidateIndex = -1;
        let minMaxDistance = Infinity;
        
        for (let i = 0; i < remainingCustomers.length; i++) {
          const candidate = remainingCustomers[i];
          
          let maxDistanceInBeat = 0;
          let violatesRelaxedConstraint = false;
          
          for (const stop of route.stops) {
            const distance = calculateHaversineDistance(
              candidate.latitude, candidate.longitude,
              stop.latitude, stop.longitude
            );
            
            if (distance > relaxedModeDistance) {
              violatesRelaxedConstraint = true;
              break;
            }
            
            maxDistanceInBeat = Math.max(maxDistanceInBeat, distance);
          }
          
          if (!violatesRelaxedConstraint && maxDistanceInBeat < minMaxDistance) {
            minMaxDistance = maxDistanceInBeat;
            bestCandidate = candidate;
            bestCandidateIndex = i;
          }
        }
        
        if (bestCandidate && bestCandidateIndex !== -1) {
          const customer = remainingCustomers.splice(bestCandidateIndex, 1)[0];
          assignedIds.add(customer.id);
          
          route.stops.push({
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: 0, // No visit time constraint
            clusterId: customer.clusterId,
            outletName: customer.outletName
          });
          
          console.log(`Added customer ${customer.id} to beat ${route.salesmanId} with relaxed constraint (max distance: ${minMaxDistance.toFixed(2)} km)`);
        } else {
          break; // No more candidates available
        }
      }
    }
    
    if (route.stops.length > 0) {
      // Optimize the order within the beat to minimize total distance while maintaining proximity
      optimizeRouteOrderForProximity(route, distributor, modeDistance);
      routes.push(route);
      
      // Calculate actual maximum distance within this beat for verification
      const maxDistanceInBeat = calculateMaxDistanceInBeat(route.stops);
      console.log(`Created STRICT beat ${route.salesmanId} with ${route.stops.length} stops, max internal distance: ${maxDistanceInBeat.toFixed(2)} km`);
    }
    
    // Safety check to prevent infinite loops
    if (routes.length >= config.beatsPerCluster * 2) {
      console.warn(`Safety break: Created ${routes.length} routes for cluster ${clusterId}`);
      break;
    }
  }
  
  // Handle any remaining customers by creating additional beats or distributing to existing ones
  if (remainingCustomers.length > 0) {
    console.log(`Distributing ${remainingCustomers.length} remaining customers to existing routes or creating new beats...`);
    
    remainingCustomers.forEach(customer => {
      if (assignedIds.has(customer.id)) {
        console.warn(`Customer ${customer.id} already assigned, skipping`);
        return;
      }
      
      // Try to find an existing route that can accommodate this customer without violating constraint
      let bestRoute = null;
      let minViolation = Infinity;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat) {
          let maxViolation = 0;
          
          for (const stop of route.stops) {
            const distance = calculateHaversineDistance(
              customer.latitude, customer.longitude,
              stop.latitude, stop.longitude
            );
            if (distance > modeDistance) {
              maxViolation = Math.max(maxViolation, distance - modeDistance);
            }
          }
          
          if (maxViolation < minViolation) {
            minViolation = maxViolation;
            bestRoute = route;
          }
        }
      }
      
      // If no suitable route found, create a new one
      if (!bestRoute || minViolation > modeDistance * 0.5) {
        bestRoute = {
          salesmanId: salesmanId++,
          stops: [],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [clusterId],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        routes.push(bestRoute);
        console.log(`Created new beat ${bestRoute.salesmanId} for remaining customer ${customer.id}`);
      }
      
      bestRoute.stops.push({
        customerId: customer.id,
        latitude: customer.latitude,
        longitude: customer.longitude,
        distanceToNext: 0,
        timeToNext: 0,
        visitTime: 0, // No visit time constraint
        clusterId: customer.clusterId,
        outletName: customer.outletName
      });
      
      assignedIds.add(customer.id);
      console.log(`Distributed customer ${customer.id} to route ${bestRoute.salesmanId}`);
    });
  }
  
  return routes;
}

function calculateMaxDistanceInBeat(stops: RouteStop[]): number {
  let maxDistance = 0;
  
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const distance = calculateHaversineDistance(
        stops[i].latitude, stops[i].longitude,
        stops[j].latitude, stops[j].longitude
      );
      maxDistance = Math.max(maxDistance, distance);
    }
  }
  
  return maxDistance;
}

function optimizeRouteOrderForProximity(
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number },
  modeDistance: number
): void {
  if (route.stops.length < 3) return;
  
  // Use nearest neighbor ordering starting from distributor
  const optimizedStops: RouteStop[] = [];
  const remainingStops = [...route.stops];
  
  let currentLat = distributor.latitude;
  let currentLng = distributor.longitude;
  
  while (remainingStops.length > 0) {
    let nearestIndex = 0;
    let shortestDistance = Infinity;
    
    for (let i = 0; i < remainingStops.length; i++) {
      const distance = calculateHaversineDistance(
        currentLat, currentLng,
        remainingStops[i].latitude, remainingStops[i].longitude
      );
      
      if (distance < shortestDistance) {
        shortestDistance = distance;
        nearestIndex = i;
      }
    }
    
    const nearestStop = remainingStops.splice(nearestIndex, 1)[0];
    optimizedStops.push(nearestStop);
    
    currentLat = nearestStop.latitude;
    currentLng = nearestStop.longitude;
  }
  
  route.stops = optimizedStops;
}

function updateRouteMetrics(
  route: SalesmanRoute, 
  distributor: { latitude: number; longitude: number }
): void {
  route.totalDistance = 0;
  route.totalTime = 0; // No time calculation needed
  
  if (route.stops.length === 0) return;
  
  let prevLat = distributor.latitude;
  let prevLng = distributor.longitude;
  
  for (let i = 0; i < route.stops.length; i++) {
    const stop = route.stops[i];
    const distance = calculateHaversineDistance(
      prevLat, prevLng,
      stop.latitude, stop.longitude
    );
    
    route.totalDistance += distance;
    
    if (i < route.stops.length - 1) {
      const nextStop = route.stops[i + 1];
      const nextDistance = calculateHaversineDistance(
        stop.latitude, stop.longitude,
        nextStop.latitude, nextStop.longitude
      );
      
      stop.distanceToNext = nextDistance;
      stop.timeToNext = 0; // No time calculation needed
    } else {
      stop.distanceToNext = 0;
      stop.timeToNext = 0;
    }
    
    prevLat = stop.latitude;
    prevLng = stop.longitude;
  }
}