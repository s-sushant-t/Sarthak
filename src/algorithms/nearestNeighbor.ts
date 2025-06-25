import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting STRICT median distance constraint nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`Beat constraints: ${config.minOutletsPerBeat}-${config.maxOutletsPerBeat} outlets per beat`);
  
  // Calculate median distance between all outlets for STRICT constraint
  const medianDistance = calculateMedianDistance(customers);
  console.log(`STRICT median distance constraint: ${medianDistance.toFixed(2)} km - NO two outlets in a beat can exceed this distance`);
  
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
  
  // Process each cluster independently with STRICT median distance constraint
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    console.log(`Target: ${config.beatsPerCluster} beats for this cluster`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create STRICT median distance constraint routes within the cluster
    const clusterRoutes = createStrictMedianDistanceRoutesInCluster(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds,
      medianDistance
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned`);
    
    if (assignedInCluster !== clusterSize) {
      console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
      
      // Find and assign missing customers
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
      
      // Force assign missing customers to routes that have space
      missingCustomers.forEach(customer => {
        const targetRoute = clusterRoutes.find(r => r.stops.length < config.maxOutletsPerBeat) || 
                           clusterRoutes.reduce((min, route) => 
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
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} STRICT median distance beats created`);
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
  
  // FINAL verification and constraint compliance check
  const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(finalRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`FINAL VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  console.log(`- Total beats created: ${finalRoutes.length}`);
  
  // Check median distance constraint compliance
  const constraintViolations = finalRoutes.filter(route => {
    const maxDistanceInBeat = calculateMaxDistanceInBeat(route.stops);
    return maxDistanceInBeat > medianDistance;
  });
  
  console.log(`CONSTRAINT COMPLIANCE CHECK:`);
  console.log(`- Median distance limit: ${medianDistance.toFixed(2)} km`);
  console.log(`- Beats violating constraint: ${constraintViolations.length}/${finalRoutes.length}`);
  
  if (constraintViolations.length > 0) {
    console.warn(`CONSTRAINT VIOLATIONS DETECTED:`);
    constraintViolations.forEach(route => {
      const maxDistance = calculateMaxDistanceInBeat(route.stops);
      console.warn(`Beat ${route.salesmanId}: Max distance ${maxDistance.toFixed(2)} km > ${medianDistance.toFixed(2)} km limit`);
    });
  } else {
    console.log(`✅ ALL BEATS COMPLY with median distance constraint`);
  }
  
  // Report beats per cluster and size compliance
  const beatsByCluster = finalRoutes.reduce((acc, route) => {
    route.clusterIds.forEach(clusterId => {
      if (!acc[clusterId]) acc[clusterId] = 0;
      acc[clusterId]++;
    });
    return acc;
  }, {} as Record<number, number>);
  
  console.log('Beats per cluster:', beatsByCluster);
  
  // Check size constraint compliance
  const sizeViolations = finalRoutes.filter(route => 
    route.stops.length < config.minOutletsPerBeat || route.stops.length > config.maxOutletsPerBeat
  );
  
  if (sizeViolations.length > 0) {
    console.warn(`SIZE CONSTRAINT VIOLATIONS: ${sizeViolations.length} beats outside size constraints`);
    sizeViolations.forEach(route => {
      console.warn(`Beat ${route.salesmanId}: ${route.stops.length} outlets (should be ${config.minOutletsPerBeat}-${config.maxOutletsPerBeat})`);
    });
  }
  
  if (finalCustomerCount !== totalCustomers || uniqueCustomerIds.size !== totalCustomers) {
    console.error(`FINAL ERROR: Customer count mismatch!`);
    console.error(`Expected: ${totalCustomers}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
  }
  
  // Calculate total distance
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `STRICT Median Distance Constraint Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function calculateMedianDistance(customers: ClusteredCustomer[]): number {
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
  
  // Sort distances to find median
  distances.sort((a, b) => a - b);
  
  const medianIndex = Math.floor(distances.length / 2);
  let medianDistance: number;
  
  if (distances.length % 2 === 0) {
    // Even number of distances - average of two middle values
    medianDistance = (distances[medianIndex - 1] + distances[medianIndex]) / 2;
  } else {
    // Odd number of distances - middle value
    medianDistance = distances[medianIndex];
  }
  
  console.log(`Distance statistics: Min: ${distances[0].toFixed(2)} km, Median: ${medianDistance.toFixed(2)} km, Max: ${distances[distances.length - 1].toFixed(2)} km`);
  
  // Use a reasonable minimum that ensures tight clustering
  return Math.max(medianDistance, 1.5);
}

function createStrictMedianDistanceRoutesInCluster(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  medianDistance: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating STRICT median distance routes for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`ABSOLUTE constraint: NO two outlets in a beat can be more than ${medianDistance.toFixed(2)} km apart`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Calculate target number of beats for this cluster
  const targetBeats = config.beatsPerCluster;
  const customersPerBeat = Math.ceil(customers.length / targetBeats);
  
  console.log(`Target: ${targetBeats} beats, ~${customersPerBeat} customers per beat`);
  
  // Create beats with ABSOLUTE median distance constraint
  for (let beatIndex = 0; beatIndex < targetBeats && remainingCustomers.length > 0; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    console.log(`Creating STRICT beat ${route.salesmanId} (${beatIndex + 1}/${targetBeats})`);
    
    // Calculate target size for this beat
    const remainingBeats = targetBeats - beatIndex;
    const remainingCustomersCount = remainingCustomers.length;
    let targetSize = Math.ceil(remainingCustomersCount / remainingBeats);
    
    // Enforce size constraints
    targetSize = Math.max(config.minOutletsPerBeat, Math.min(config.maxOutletsPerBeat, targetSize));
    
    console.log(`Target size for beat ${route.salesmanId}: ${targetSize} customers`);
    
    // Start with the customer closest to distributor (or previous beat center)
    let seedIndex = 0;
    let minDistanceToReference = Infinity;
    
    const referencePoint = routes.length > 0 ? 
      calculateBeatCenter(routes[routes.length - 1].stops) : 
      { latitude: distributor.latitude, longitude: distributor.longitude };
    
    for (let i = 0; i < remainingCustomers.length; i++) {
      const distance = calculateHaversineDistance(
        referencePoint.latitude, referencePoint.longitude,
        remainingCustomers[i].latitude, remainingCustomers[i].longitude
      );
      if (distance < minDistanceToReference) {
        minDistanceToReference = distance;
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
      visitTime: config.customerVisitTimeMinutes,
      clusterId: seedCustomer.clusterId,
      outletName: seedCustomer.outletName
    });
    
    console.log(`Seed customer for beat ${route.salesmanId}: ${seedCustomer.id}`);
    
    // Build ABSOLUTELY STRICT cluster around seed customer
    while (route.stops.length < targetSize && 
           route.stops.length < config.maxOutletsPerBeat && 
           remainingCustomers.length > 0) {
      
      let bestCandidate = null;
      let bestCandidateIndex = -1;
      let minMaxDistance = Infinity;
      
      // Find customer that maintains ABSOLUTE median distance constraint
      for (let i = 0; i < remainingCustomers.length; i++) {
        const candidate = remainingCustomers[i];
        
        // Check if adding this candidate would violate the ABSOLUTE median distance constraint
        let maxDistanceInBeat = 0;
        let violatesAbsoluteConstraint = false;
        
        for (const stop of route.stops) {
          const distance = calculateHaversineDistance(
            candidate.latitude, candidate.longitude,
            stop.latitude, stop.longitude
          );
          
          // ABSOLUTE constraint: NO distance can exceed median distance
          if (distance > medianDistance) {
            violatesAbsoluteConstraint = true;
            break;
          }
          
          maxDistanceInBeat = Math.max(maxDistanceInBeat, distance);
        }
        
        // Only consider candidates that ABSOLUTELY satisfy the constraint
        if (!violatesAbsoluteConstraint && maxDistanceInBeat < minMaxDistance) {
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
          visitTime: config.customerVisitTimeMinutes,
          clusterId: customer.clusterId,
          outletName: customer.outletName
        });
        
        console.log(`Added customer ${customer.id} to beat ${route.salesmanId} (max distance in beat: ${minMaxDistance.toFixed(2)} km ≤ ${medianDistance.toFixed(2)} km)`);
      } else {
        // No suitable candidate found that satisfies ABSOLUTE constraint
        console.log(`No candidate found for beat ${route.salesmanId} that satisfies ABSOLUTE median distance constraint, stopping at ${route.stops.length} customers`);
        break;
      }
    }
    
    // Only try to reach minimum size if we can do so without violating the ABSOLUTE constraint
    if (route.stops.length < config.minOutletsPerBeat && remainingCustomers.length > 0) {
      console.log(`Beat ${route.salesmanId} has only ${route.stops.length} customers, checking if we can add more without violating ABSOLUTE constraint...`);
      
      // Try to add more customers while maintaining ABSOLUTE constraint
      while (route.stops.length < config.minOutletsPerBeat && 
             route.stops.length < config.maxOutletsPerBeat && 
             remainingCustomers.length > 0) {
        
        let bestCandidate = null;
        let bestCandidateIndex = -1;
        let minMaxDistance = Infinity;
        
        for (let i = 0; i < remainingCustomers.length; i++) {
          const candidate = remainingCustomers[i];
          
          let maxDistanceInBeat = 0;
          let violatesAbsoluteConstraint = false;
          
          for (const stop of route.stops) {
            const distance = calculateHaversineDistance(
              candidate.latitude, candidate.longitude,
              stop.latitude, stop.longitude
            );
            
            // ABSOLUTE constraint: NO distance can exceed median distance
            if (distance > medianDistance) {
              violatesAbsoluteConstraint = true;
              break;
            }
            
            maxDistanceInBeat = Math.max(maxDistanceInBeat, distance);
          }
          
          if (!violatesAbsoluteConstraint && maxDistanceInBeat < minMaxDistance) {
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
            visitTime: config.customerVisitTimeMinutes,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          });
          
          console.log(`Added customer ${customer.id} to beat ${route.salesmanId} while maintaining ABSOLUTE constraint (max distance: ${minMaxDistance.toFixed(2)} km)`);
        } else {
          console.log(`Cannot add more customers to beat ${route.salesmanId} without violating ABSOLUTE median distance constraint`);
          break; // No more candidates available that satisfy ABSOLUTE constraint
        }
      }
    }
    
    if (route.stops.length > 0) {
      // Optimize the order within the beat to minimize distance while maintaining constraint
      optimizeRouteOrderWithAbsoluteConstraint(route, distributor, medianDistance);
      routes.push(route);
      
      // Verify ABSOLUTE constraint compliance
      const maxDistanceInBeat = calculateMaxDistanceInBeat(route.stops);
      const constraintSatisfied = maxDistanceInBeat <= medianDistance;
      
      console.log(`Created beat ${route.salesmanId} with ${route.stops.length} stops`);
      console.log(`Max internal distance: ${maxDistanceInBeat.toFixed(2)} km ${constraintSatisfied ? '✅' : '❌'} (limit: ${medianDistance.toFixed(2)} km)`);
      console.log(`Total distance: ${route.totalDistance.toFixed(2)} km`);
      
      if (!constraintSatisfied) {
        console.error(`❌ CONSTRAINT VIOLATION in beat ${route.salesmanId}!`);
      }
    }
  }
  
  // Handle any remaining customers by distributing to existing beats or creating new ones
  if (remainingCustomers.length > 0) {
    console.log(`Distributing ${remainingCustomers.length} remaining customers while maintaining ABSOLUTE constraint...`);
    
    remainingCustomers.forEach(customer => {
      if (assignedIds.has(customer.id)) {
        console.warn(`Customer ${customer.id} already assigned, skipping`);
        return;
      }
      
      // Try to find an existing route that can accommodate this customer without violating ABSOLUTE constraint
      let bestRoute = null;
      let canAddWithoutViolation = false;
      
      for (const route of routes) {
        if (route.stops.length < config.maxOutletsPerBeat) {
          let violatesConstraint = false;
          
          for (const stop of route.stops) {
            const distance = calculateHaversineDistance(
              customer.latitude, customer.longitude,
              stop.latitude, stop.longitude
            );
            if (distance > medianDistance) {
              violatesConstraint = true;
              break;
            }
          }
          
          if (!violatesConstraint) {
            bestRoute = route;
            canAddWithoutViolation = true;
            break;
          }
        }
      }
      
      // If no suitable route found, create a new one
      if (!canAddWithoutViolation) {
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
        console.log(`Created new beat ${bestRoute.salesmanId} for remaining customer ${customer.id} to maintain ABSOLUTE constraint`);
      }
      
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
      console.log(`Distributed customer ${customer.id} to route ${bestRoute.salesmanId}`);
    });
  }
  
  return routes;
}

function calculateBeatCenter(stops: RouteStop[]): { latitude: number; longitude: number } {
  if (stops.length === 0) return { latitude: 0, longitude: 0 };
  
  const avgLat = stops.reduce((sum, stop) => sum + stop.latitude, 0) / stops.length;
  const avgLng = stops.reduce((sum, stop) => sum + stop.longitude, 0) / stops.length;
  
  return { latitude: avgLat, longitude: avgLng };
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

function optimizeRouteOrderWithAbsoluteConstraint(
  route: SalesmanRoute,
  distributor: { latitude: number; longitude: number },
  medianDistance: number
): void {
  if (route.stops.length < 3) return;
  
  // Use nearest neighbor ordering starting from distributor to minimize distance
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
  
  // Verify that the optimized order still satisfies the ABSOLUTE constraint
  let maxDistance = 0;
  for (let i = 0; i < optimizedStops.length; i++) {
    for (let j = i + 1; j < optimizedStops.length; j++) {
      const distance = calculateHaversineDistance(
        optimizedStops[i].latitude, optimizedStops[i].longitude,
        optimizedStops[j].latitude, optimizedStops[j].longitude
      );
      maxDistance = Math.max(maxDistance, distance);
    }
  }
  
  // Only apply optimization if it maintains the ABSOLUTE constraint
  if (maxDistance <= medianDistance) {
    route.stops = optimizedStops;
  } else {
    console.warn(`Route optimization would violate ABSOLUTE constraint (${maxDistance.toFixed(2)} > ${medianDistance.toFixed(2)}), keeping original order`);
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