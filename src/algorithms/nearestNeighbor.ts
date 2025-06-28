import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting Nearest Neighbor with STRICT 50m isolation for ${customers.length} customers`);
  console.log(`Target: ${config.totalClusters} clusters × ${config.beatsPerCluster} beats = ${config.totalClusters * config.beatsPerCluster} total beats`);
  
  const startTime = Date.now();
  
  try {
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    const STRICT_ISOLATION_DISTANCE = 0.05; // 50m minimum separation
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
    
    // Process each cluster independently with STRICT 50m isolation
    for (const clusterId of Object.keys(customersByCluster)) {
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
      console.log(`Target: exactly ${config.beatsPerCluster} beats for this cluster`);
      
      const clusterAssignedIds = new Set<string>();
      
      // Create exactly beatsPerCluster beats with STRICT 50m isolation
      const clusterRoutes = createStrictlyIsolatedBeatsNearestNeighbor(
        clusterCustomers,
        distributor,
        config,
        currentSalesmanId,
        Number(clusterId),
        clusterAssignedIds,
        config.beatsPerCluster,
        STRICT_ISOLATION_DISTANCE
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned in ${clusterRoutes.length} beats`);
      
      if (assignedInCluster !== clusterSize) {
        console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
        
        // Find and assign missing customers with STRICT isolation constraints
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to suitable beats
        missingCustomers.forEach(customer => {
          const suitableBeat = findSuitableBeatWithStrictIsolation(customer, clusterRoutes, STRICT_ISOLATION_DISTANCE);
          let targetRoute = suitableBeat;
          
          if (!targetRoute) {
            // If no suitable beat, find one with minimum conflicts
            targetRoute = findBeatWithMinimumConflicts(customer, clusterRoutes, STRICT_ISOLATION_DISTANCE);
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
    }
    
    // Apply comprehensive STRICT isolation optimization
    console.log('🔧 Applying STRICT 50m isolation optimization...');
    const optimizedRoutes = await enforceStrictIsolationNN(routes, config, STRICT_ISOLATION_DISTANCE);
    
    // Update route metrics for all routes
    optimizedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Reassign beat IDs sequentially
    const finalRoutes = optimizedRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    // Generate isolation report
    const isolationReport = generateIsolationReport(finalRoutes, STRICT_ISOLATION_DISTANCE);
    console.log('📊 Final STRICT Isolation Report:', isolationReport);
    
    // FINAL verification
    const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
    const uniqueCustomerIds = new Set(finalRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
    
    console.log(`NEAREST NEIGHBOR VERIFICATION:`);
    console.log(`- Total customers in routes: ${finalCustomerCount}`);
    console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
    console.log(`- Expected customers: ${allCustomers.length}`);
    console.log(`- Total beats created: ${finalRoutes.length}`);
    console.log(`- Target beats: ${TARGET_TOTAL_BEATS}`);
    console.log(`🎯 STRICT Isolation violations: ${isolationReport.totalViolations} (${isolationReport.violationPercentage.toFixed(1)}%)`);
    
    // Report beats per cluster
    const beatsByCluster = finalRoutes.reduce((acc, route) => {
      route.clusterIds.forEach(clusterId => {
        if (!acc[clusterId]) acc[clusterId] = 0;
        acc[clusterId]++;
      });
      return acc;
    }, {} as Record<number, number>);
    
    console.log('Beats per cluster:', beatsByCluster);
    
    if (finalCustomerCount !== allCustomers.length || uniqueCustomerIds.size !== allCustomers.length) {
      console.error(`NEAREST NEIGHBOR ERROR: Customer count mismatch!`);
      console.error(`Expected: ${allCustomers.length}, Got: ${finalCustomerCount}, Unique: ${uniqueCustomerIds.size}`);
    }
    
    // Calculate total distance
    const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    return {
      name: `Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats, 50m Isolation)`,
      totalDistance,
      totalSalesmen: finalRoutes.length,
      processingTime: Date.now() - startTime,
      routes: finalRoutes
    };
    
  } catch (error) {
    console.error('Nearest Neighbor algorithm failed:', error);
    throw error;
  }
};

function createStrictlyIsolatedBeatsNearestNeighbor(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number,
  isolationDistance: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating exactly ${targetBeats} STRICTLY isolated beats (50m) for cluster ${clusterId} with ${customers.length} customers`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  // Calculate optimal distribution of customers across beats
  const customersPerBeat = Math.ceil(remainingCustomers.length / targetBeats);
  
  console.log(`Target customers per beat: ${customersPerBeat}`);
  
  // Create exactly targetBeats number of beats
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
    
    // Calculate how many customers this beat should get
    const remainingBeats = targetBeats - beatIndex;
    const remainingCustomersCount = remainingCustomers.length;
    const customersForThisBeat = Math.ceil(remainingCustomersCount / remainingBeats);
    
    console.log(`Beat ${beatIndex + 1}: targeting ${customersForThisBeat} customers from ${remainingCustomersCount} remaining`);
    
    // Build route using nearest neighbor with STRICT isolation constraints
    let currentLat = distributor.latitude;
    let currentLng = distributor.longitude;
    
    for (let i = 0; i < customersForThisBeat && remainingCustomers.length > 0; i++) {
      let nearestIndex = -1;
      let shortestDistance = Infinity;
      
      // Find the nearest unvisited customer that doesn't violate STRICT isolation
      for (let j = 0; j < remainingCustomers.length; j++) {
        const customer = remainingCustomers[j];
        const distance = calculateHaversineDistance(
          currentLat, currentLng,
          customer.latitude, customer.longitude
        );
        
        // Check if adding this customer would violate STRICT 50m isolation with other beats
        if (distance < shortestDistance && 
            canAddCustomerWithStrictIsolation(customer, route, routes, isolationDistance)) {
          shortestDistance = distance;
          nearestIndex = j;
        }
      }
      
      // If no customer found without violations, find one with minimum conflicts
      if (nearestIndex === -1 && remainingCustomers.length > 0) {
        const bestCustomer = findCustomerWithMinimumConflicts(
          currentLat, currentLng, remainingCustomers, routes, isolationDistance
        );
        nearestIndex = remainingCustomers.findIndex(c => c.id === bestCustomer.id);
        console.log(`⚠️ No violation-free customer found, using minimum conflicts: ${bestCustomer.id}`);
      }
      
      if (nearestIndex === -1) break;
      
      // Remove customer from remaining and add to route
      const nearestCustomer = remainingCustomers.splice(nearestIndex, 1)[0];
      
      // CRITICAL: Ensure no duplicate assignment
      if (assignedIds.has(nearestCustomer.id)) {
        console.error(`DUPLICATE ASSIGNMENT DETECTED: Customer ${nearestCustomer.id} already assigned!`);
        continue;
      }
      
      assignedIds.add(nearestCustomer.id);
      
      route.stops.push({
        customerId: nearestCustomer.id,
        latitude: nearestCustomer.latitude,
        longitude: nearestCustomer.longitude,
        distanceToNext: 0,
        timeToNext: 0,
        visitTime: config.customerVisitTimeMinutes,
        clusterId: nearestCustomer.clusterId,
        outletName: nearestCustomer.outletName
      });
      
      // Update current position for next nearest neighbor search
      currentLat = nearestCustomer.latitude;
      currentLng = nearestCustomer.longitude;
      
      console.log(`✅ Added customer ${nearestCustomer.id} to beat ${route.salesmanId} (${route.stops.length}/${customersForThisBeat})`);
    }
    
    // Add route even if it has no stops (to maintain exact beat count)
    routes.push(route);
    console.log(`Created beat ${route.salesmanId} with ${route.stops.length} stops`);
  }
  
  // If there are still remaining customers, distribute them to existing beats with STRICT isolation constraints
  if (remainingCustomers.length > 0) {
    console.log(`Distributing ${remainingCustomers.length} remaining customers to existing beats...`);
    
    remainingCustomers.forEach(customer => {
      if (assignedIds.has(customer.id)) {
        console.warn(`Customer ${customer.id} already assigned, skipping`);
        return;
      }
      
      // Find a suitable beat that doesn't violate STRICT isolation
      const suitableBeat = findSuitableBeatWithStrictIsolation(customer, routes, isolationDistance);
      let targetRoute = suitableBeat;
      
      if (!targetRoute) {
        // If no suitable beat, find one with minimum conflicts
        targetRoute = findBeatWithMinimumConflicts(customer, routes, isolationDistance);
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
        
        assignedIds.add(customer.id);
        console.log(`Distributed customer ${customer.id} to route ${targetRoute.salesmanId}`);
      }
    });
  }
  
  console.log(`Cluster ${clusterId}: Created exactly ${routes.length} beats as required`);
  
  return routes;
}

function canAddCustomerWithStrictIsolation(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  minDistance: number
): boolean {
  // Check against ALL customers in ALL other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < minDistance) {
        return false; // STRICT: Any violation = rejection
      }
    }
  }
  
  return true; // No violations found
}

function findCustomerWithMinimumConflicts(
  currentLat: number,
  currentLng: number,
  customers: ClusteredCustomer[],
  routes: SalesmanRoute[],
  minDistance: number
): ClusteredCustomer {
  let bestCustomer = customers[0];
  let bestScore = Infinity;
  
  for (const customer of customers) {
    let conflicts = 0;
    let totalViolationDistance = 0;
    
    // Count conflicts with other beats
    for (const route of routes) {
      for (const stop of route.stops) {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
        
        if (distance < minDistance) {
          conflicts++;
          totalViolationDistance += (minDistance - distance);
        }
      }
    }
    
    // Calculate distance from current position
    const distanceFromCurrent = calculateHaversineDistance(
      currentLat, currentLng,
      customer.latitude, customer.longitude
    );
    
    // Score: prioritize fewer conflicts, then closer distance
    const score = conflicts * 1000 + totalViolationDistance * 100 + distanceFromCurrent;
    
    if (score < bestScore) {
      bestScore = score;
      bestCustomer = customer;
    }
  }
  
  console.log(`🔍 Best customer: ${bestCustomer.id} (${Math.floor(bestScore / 1000)} conflicts)`);
  
  return bestCustomer;
}

function findBeatWithMinimumConflicts(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  minDistance: number
): SalesmanRoute {
  let bestBeat = routes[0];
  let minConflicts = Infinity;
  
  for (const route of routes) {
    let conflicts = 0;
    let totalViolationDistance = 0;
    
    // Count conflicts with other beats
    for (const otherRoute of routes) {
      if (otherRoute.salesmanId === route.salesmanId) continue;
      
      for (const stop of otherRoute.stops) {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
        
        if (distance < minDistance) {
          conflicts++;
          totalViolationDistance += (minDistance - distance);
        }
      }
    }
    
    // Prefer beats with fewer customers if conflicts are equal
    const score = conflicts * 1000 + totalViolationDistance * 100 + route.stops.length;
    
    if (score < minConflicts) {
      minConflicts = score;
      bestBeat = route;
    }
  }
  
  return bestBeat;
}

function findSuitableBeatWithStrictIsolation(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  minDistance: number
): SalesmanRoute | null {
  for (const route of routes) {
    if (canAddCustomerWithStrictIsolation(customer, route, routes, minDistance)) {
      return route;
    }
  }
  return null;
}

async function enforceStrictIsolationNN(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  isolationDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`🔧 Enforcing STRICT ${isolationDistance * 1000}m isolation between beats...`);
  
  const MAX_ITERATIONS = 10;
  const MAX_MOVES_PER_ITERATION = 50;
  
  let optimizedRoutes = [...routes];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    console.log(`🔄 STRICT Isolation iteration ${iteration + 1}/${MAX_ITERATIONS}`);
    
    // Find all violations
    const violations = findAllIsolationViolations(optimizedRoutes, isolationDistance);
    
    if (violations.length === 0) {
      console.log(`✅ Perfect STRICT isolation achieved after ${iteration + 1} iterations`);
      break;
    }
    
    console.log(`🚨 Found ${violations.length} STRICT isolation violations`);
    
    // Sort violations by severity (closest distances first)
    violations.sort((a, b) => a.distance - b.distance);
    
    let movesMade = 0;
    const maxMovesThisIteration = Math.min(violations.length, MAX_MOVES_PER_ITERATION);
    
    // Attempt to resolve violations by moving customers
    for (let i = 0; i < maxMovesThisIteration; i++) {
      const violation = violations[i];
      
      if (attemptViolationResolution(violation, optimizedRoutes, isolationDistance)) {
        movesMade++;
      }
    }
    
    console.log(`📊 Iteration ${iteration + 1}: Resolved ${movesMade}/${maxMovesThisIteration} violations`);
    
    if (movesMade === 0) {
      console.log('⚠️ No more beneficial moves possible');
      break;
    }
    
    // Yield control
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  return optimizedRoutes;
}

function findAllIsolationViolations(
  routes: SalesmanRoute[],
  minDistance: number
): Array<{
  customer1: RouteStop;
  customer2: RouteStop;
  beat1Id: number;
  beat2Id: number;
  distance: number;
}> {
  const violations: Array<{
    customer1: RouteStop;
    customer2: RouteStop;
    beat1Id: number;
    beat2Id: number;
    distance: number;
  }> = [];
  
  // Check all pairs of beats
  for (let i = 0; i < routes.length; i++) {
    const beat1 = routes[i];
    
    for (let j = i + 1; j < routes.length; j++) {
      const beat2 = routes[j];
      
      // Check all customer pairs between these beats
      for (const customer1 of beat1.stops) {
        for (const customer2 of beat2.stops) {
          const distance = calculateHaversineDistance(
            customer1.latitude, customer1.longitude,
            customer2.latitude, customer2.longitude
          );
          
          if (distance < minDistance) {
            violations.push({
              customer1,
              customer2,
              beat1Id: beat1.salesmanId,
              beat2Id: beat2.salesmanId,
              distance
            });
          }
        }
      }
    }
  }
  
  return violations;
}

function attemptViolationResolution(
  violation: {
    customer1: RouteStop;
    customer2: RouteStop;
    beat1Id: number;
    beat2Id: number;
    distance: number;
  },
  routes: SalesmanRoute[],
  minDistance: number
): boolean {
  const { customer1, customer2, beat1Id, beat2Id } = violation;
  
  // Try moving customer1 to a different beat in the same cluster
  const customer1Beat = routes.find(r => r.salesmanId === beat1Id);
  const customer2Beat = routes.find(r => r.salesmanId === beat2Id);
  
  if (!customer1Beat || !customer2Beat) return false;
  
  // Find alternative beats for customer1 in the same cluster
  const sameClusterBeats = routes.filter(route => 
    route.salesmanId !== beat1Id && 
    route.clusterIds.some(id => customer1.clusterId === id)
  );
  
  // Try moving customer1
  for (const alternativeBeat of sameClusterBeats) {
    if (canAddCustomerWithStrictIsolation(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      alternativeBeat, 
      routes, 
      minDistance
    )) {
      // Move customer1 to alternative beat
      const customerIndex = customer1Beat.stops.findIndex(s => s.customerId === customer1.customerId);
      if (customerIndex !== -1) {
        customer1Beat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer1);
        console.log(`🔄 Moved customer ${customer1.customerId} from beat ${beat1Id} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  // Try moving customer2 if moving customer1 failed
  const customer2SameClusterBeats = routes.filter(route => 
    route.salesmanId !== beat2Id && 
    route.clusterIds.some(id => customer2.clusterId === id)
  );
  
  for (const alternativeBeat of customer2SameClusterBeats) {
    if (canAddCustomerWithStrictIsolation(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      alternativeBeat, 
      routes, 
      minDistance
    )) {
      // Move customer2 to alternative beat
      const customerIndex = customer2Beat.stops.findIndex(s => s.customerId === customer2.customerId);
      if (customerIndex !== -1) {
        customer2Beat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer2);
        console.log(`🔄 Moved customer ${customer2.customerId} from beat ${beat2Id} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  return false; // Could not resolve this violation
}

function generateIsolationReport(routes: SalesmanRoute[], minDistance: number): {
  totalViolations: number;
  violationPercentage: number;
  averageViolationDistance: number;
  beatPairViolations: number;
} {
  const violations = findAllIsolationViolations(routes, minDistance);
  const totalCustomerPairs = routes.reduce((total, route, i) => {
    return total + routes.slice(i + 1).reduce((pairCount, otherRoute) => {
      return pairCount + (route.stops.length * otherRoute.stops.length);
    }, 0);
  }, 0);
  
  const averageDistance = violations.length > 0 
    ? violations.reduce((sum, v) => sum + v.distance, 0) / violations.length 
    : 0;
  
  const beatPairs = new Set(violations.map(v => `${v.beat1Id}-${v.beat2Id}`)).size;
  
  return {
    totalViolations: violations.length,
    violationPercentage: totalCustomerPairs > 0 ? (violations.length / totalCustomerPairs) * 100 : 0,
    averageViolationDistance: averageDistance * 1000, // Convert to meters
    beatPairViolations: beatPairs
  };
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