import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting Nearest Neighbor with DUAL constraints (50m isolation + 500m max intra-beat) for ${customers.length} customers`);
  console.log(`Target: ${config.totalClusters} clusters × ${config.beatsPerCluster} beats = ${config.totalClusters * config.beatsPerCluster} total beats`);
  
  const startTime = Date.now();
  
  try {
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    const STRICT_ISOLATION_DISTANCE = 0.05; // 50m minimum separation between beats
    const MAX_INTRA_BEAT_DISTANCE = 0.5; // 500m maximum distance within a beat
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
    
    // Process each cluster independently with DUAL constraints
    for (const clusterId of Object.keys(customersByCluster)) {
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
      console.log(`Target: exactly ${config.beatsPerCluster} beats for this cluster`);
      
      const clusterAssignedIds = new Set<string>();
      
      // Create exactly beatsPerCluster beats with DUAL constraints
      const clusterRoutes = createDualConstraintBeatsNearestNeighbor(
        clusterCustomers,
        distributor,
        config,
        currentSalesmanId,
        Number(clusterId),
        clusterAssignedIds,
        config.beatsPerCluster,
        STRICT_ISOLATION_DISTANCE,
        MAX_INTRA_BEAT_DISTANCE
      );
      
      // Verify all cluster customers are assigned exactly once
      const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned in ${clusterRoutes.length} beats`);
      
      if (assignedInCluster !== clusterSize) {
        console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
        
        // Find and assign missing customers with DUAL constraints
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to suitable beats
        missingCustomers.forEach(customer => {
          const suitableBeat = findSuitableBeatWithDualConstraints(customer, clusterRoutes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
          let targetRoute = suitableBeat;
          
          if (!targetRoute) {
            // If no suitable beat, find one with minimum constraint violations
            targetRoute = findBeatWithMinimumConstraintViolations(customer, clusterRoutes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
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
    
    // Apply comprehensive DUAL constraint optimization
    console.log('🔧 Applying DUAL constraint optimization (50m isolation + 500m intra-beat)...');
    const optimizedRoutes = await enforceDualConstraintsNN(routes, config, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    
    // Update route metrics for all routes
    optimizedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Reassign beat IDs sequentially
    const finalRoutes = optimizedRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    // Generate dual constraint report
    const constraintReport = generateDualConstraintReport(finalRoutes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    console.log('📊 Final Dual Constraint Report:', constraintReport);
    
    // FINAL verification
    const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
    const uniqueCustomerIds = new Set(finalRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
    
    console.log(`NEAREST NEIGHBOR VERIFICATION:`);
    console.log(`- Total customers in routes: ${finalCustomerCount}`);
    console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
    console.log(`- Expected customers: ${allCustomers.length}`);
    console.log(`- Total beats created: ${finalRoutes.length}`);
    console.log(`- Target beats: ${TARGET_TOTAL_BEATS}`);
    console.log(`🎯 Constraint violations: Isolation=${constraintReport.isolationViolations}, Intra-beat=${constraintReport.intraBeatViolations}`);
    console.log(`📏 Max intra-beat distance found: ${constraintReport.maxIntraBeatDistanceFound.toFixed(0)}m (limit: 500m)`);
    
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
      name: `Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats, 50m+500m)`,
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

function createDualConstraintBeatsNearestNeighbor(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number,
  isolationDistance: number,
  maxIntraBeatDistance: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating exactly ${targetBeats} beats with DUAL constraints (50m isolation + 500m max intra-beat) for cluster ${clusterId} with ${customers.length} customers`);
  
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
    
    // Build route using nearest neighbor with DUAL constraints
    let currentLat = distributor.latitude;
    let currentLng = distributor.longitude;
    
    for (let i = 0; i < customersForThisBeat && remainingCustomers.length > 0; i++) {
      let nearestIndex = -1;
      let shortestDistance = Infinity;
      
      // Find the nearest unvisited customer that doesn't violate DUAL constraints
      for (let j = 0; j < remainingCustomers.length; j++) {
        const customer = remainingCustomers[j];
        const distance = calculateHaversineDistance(
          currentLat, currentLng,
          customer.latitude, customer.longitude
        );
        
        // Check if adding this customer would violate DUAL constraints
        if (distance < shortestDistance && 
            canAddCustomerWithDualConstraints(customer, route, routes, isolationDistance, maxIntraBeatDistance)) {
          shortestDistance = distance;
          nearestIndex = j;
        }
      }
      
      // If no customer found without violations, find one with minimum constraint violations
      if (nearestIndex === -1 && remainingCustomers.length > 0) {
        const bestCustomer = findCustomerWithMinimumConstraintViolations(
          currentLat, currentLng, remainingCustomers, routes, isolationDistance, maxIntraBeatDistance
        );
        nearestIndex = remainingCustomers.findIndex(c => c.id === bestCustomer.id);
        console.log(`⚠️ No violation-free customer found, using minimum violations: ${bestCustomer.id}`);
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
  
  // If there are still remaining customers, distribute them to existing beats with DUAL constraints
  if (remainingCustomers.length > 0) {
    console.log(`Distributing ${remainingCustomers.length} remaining customers to existing beats...`);
    
    remainingCustomers.forEach(customer => {
      if (assignedIds.has(customer.id)) {
        console.warn(`Customer ${customer.id} already assigned, skipping`);
        return;
      }
      
      // Find a suitable beat that doesn't violate DUAL constraints
      const suitableBeat = findSuitableBeatWithDualConstraints(customer, routes, isolationDistance, maxIntraBeatDistance);
      let targetRoute = suitableBeat;
      
      if (!targetRoute) {
        // If no suitable beat, find one with minimum constraint violations
        targetRoute = findBeatWithMinimumConstraintViolations(customer, routes, isolationDistance, maxIntraBeatDistance);
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

function canAddCustomerWithDualConstraints(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): boolean {
  // CONSTRAINT 1: Check 50m isolation with other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < isolationDistance) {
        return false; // Isolation violation
      }
    }
  }
  
  // CONSTRAINT 2: Check 500m max distance within the target beat
  for (const stop of targetBeat.stops) {
    const distance = calculateHaversineDistance(
      customer.latitude, customer.longitude,
      stop.latitude, stop.longitude
    );
    
    if (distance > maxIntraBeatDistance) {
      return false; // Intra-beat distance violation
    }
  }
  
  return true; // No violations found
}

function findCustomerWithMinimumConstraintViolations(
  currentLat: number,
  currentLng: number,
  customers: ClusteredCustomer[],
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): ClusteredCustomer {
  let bestCustomer = customers[0];
  let bestScore = Infinity;
  
  for (const customer of customers) {
    let isolationViolations = 0;
    let intraBeatViolations = 0;
    let totalViolationDistance = 0;
    
    // Count isolation violations with other beats
    for (const route of routes) {
      for (const stop of route.stops) {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
        
        if (distance < isolationDistance) {
          isolationViolations++;
          totalViolationDistance += (isolationDistance - distance);
        }
      }
    }
    
    // Calculate distance from current position
    const distanceFromCurrent = calculateHaversineDistance(
      currentLat, currentLng,
      customer.latitude, customer.longitude
    );
    
    // Score: prioritize isolation violations, then intra-beat violations, then distance
    const score = isolationViolations * 2000 + intraBeatViolations * 1000 + totalViolationDistance * 100 + distanceFromCurrent;
    
    if (score < bestScore) {
      bestScore = score;
      bestCustomer = customer;
    }
  }
  
  console.log(`🔍 Best customer: ${bestCustomer.id} (score: ${bestScore.toFixed(0)})`);
  
  return bestCustomer;
}

function findBeatWithMinimumConstraintViolations(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): SalesmanRoute {
  let bestBeat = routes[0];
  let minViolationScore = Infinity;
  
  for (const route of routes) {
    let isolationViolations = 0;
    let intraBeatViolations = 0;
    let totalViolationDistance = 0;
    
    // Count isolation violations with other beats
    for (const otherRoute of routes) {
      if (otherRoute.salesmanId === route.salesmanId) continue;
      
      for (const stop of otherRoute.stops) {
        const distance = calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
        
        if (distance < isolationDistance) {
          isolationViolations++;
          totalViolationDistance += (isolationDistance - distance);
        }
      }
    }
    
    // Count intra-beat distance violations
    for (const stop of route.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance > maxIntraBeatDistance) {
        intraBeatViolations++;
        totalViolationDistance += (distance - maxIntraBeatDistance);
      }
    }
    
    // Calculate violation score: prioritize isolation violations, then intra-beat violations
    const violationScore = isolationViolations * 2000 + intraBeatViolations * 1000 + totalViolationDistance * 100 + route.stops.length;
    
    if (violationScore < minViolationScore) {
      minViolationScore = violationScore;
      bestBeat = route;
    }
  }
  
  return bestBeat;
}

function findSuitableBeatWithDualConstraints(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): SalesmanRoute | null {
  for (const route of routes) {
    if (canAddCustomerWithDualConstraints(customer, route, routes, isolationDistance, maxIntraBeatDistance)) {
      return route;
    }
  }
  return null;
}

async function enforceDualConstraintsNN(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  isolationDistance: number,
  maxIntraBeatDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`🔧 Enforcing dual constraints: ${isolationDistance * 1000}m isolation + ${maxIntraBeatDistance * 1000}m max intra-beat...`);
  
  const MAX_ITERATIONS = 10;
  const MAX_MOVES_PER_ITERATION = 50;
  
  let optimizedRoutes = [...routes];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    console.log(`🔄 Dual constraint iteration ${iteration + 1}/${MAX_ITERATIONS}`);
    
    // Find all constraint violations
    const isolationViolations = findAllIsolationViolations(optimizedRoutes, isolationDistance);
    const intraBeatViolations = findAllIntraBeatViolations(optimizedRoutes, maxIntraBeatDistance);
    
    const totalViolations = isolationViolations.length + intraBeatViolations.length;
    
    if (totalViolations === 0) {
      console.log(`✅ Perfect dual constraint compliance achieved after ${iteration + 1} iterations`);
      break;
    }
    
    console.log(`🚨 Found ${isolationViolations.length} isolation + ${intraBeatViolations.length} intra-beat violations`);
    
    let movesMade = 0;
    
    // Prioritize resolving isolation violations first (more critical)
    const prioritizedViolations = [
      ...isolationViolations.map(v => ({ ...v, type: 'isolation', priority: 1 })),
      ...intraBeatViolations.map(v => ({ ...v, type: 'intra-beat', priority: 2 }))
    ].sort((a, b) => a.priority - b.priority || a.distance - b.distance);
    
    const maxMovesThisIteration = Math.min(prioritizedViolations.length, MAX_MOVES_PER_ITERATION);
    
    // Attempt to resolve violations by moving customers
    for (let i = 0; i < maxMovesThisIteration; i++) {
      const violation = prioritizedViolations[i];
      
      if (violation.type === 'isolation') {
        if (attemptIsolationViolationResolution(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
          movesMade++;
        }
      } else {
        if (attemptIntraBeatViolationResolution(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
          movesMade++;
        }
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

function findAllIntraBeatViolations(
  routes: SalesmanRoute[],
  maxIntraBeatDistance: number
): Array<{
  customer1: RouteStop;
  customer2: RouteStop;
  beatId: number;
  distance: number;
}> {
  const violations: Array<{
    customer1: RouteStop;
    customer2: RouteStop;
    beatId: number;
    distance: number;
  }> = [];
  
  // Check all customer pairs within each beat
  for (const beat of routes) {
    for (let i = 0; i < beat.stops.length; i++) {
      for (let j = i + 1; j < beat.stops.length; j++) {
        const customer1 = beat.stops[i];
        const customer2 = beat.stops[j];
        
        const distance = calculateHaversineDistance(
          customer1.latitude, customer1.longitude,
          customer2.latitude, customer2.longitude
        );
        
        if (distance > maxIntraBeatDistance) {
          violations.push({
            customer1,
            customer2,
            beatId: beat.salesmanId,
            distance
          });
        }
      }
    }
  }
  
  return violations;
}

function attemptIsolationViolationResolution(
  violation: {
    customer1: RouteStop;
    customer2: RouteStop;
    beat1Id: number;
    beat2Id: number;
    distance: number;
  },
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
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
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
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
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
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

function attemptIntraBeatViolationResolution(
  violation: {
    customer1: RouteStop;
    customer2: RouteStop;
    beatId: number;
    distance: number;
  },
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): boolean {
  const { customer1, customer2, beatId } = violation;
  
  console.log(`🔧 Attempting to resolve intra-beat violation: ${customer1.customerId} ↔ ${customer2.customerId} in beat ${beatId} = ${(violation.distance * 1000).toFixed(0)}m`);
  
  const sourceBeat = routes.find(r => r.salesmanId === beatId);
  if (!sourceBeat) return false;
  
  // Try moving customer1 to a different beat in the same cluster
  const sameClusterBeats = routes.filter(route => 
    route.salesmanId !== beatId && 
    route.clusterIds.some(id => customer1.clusterId === id)
  );
  
  // Try moving customer1
  for (const alternativeBeat of sameClusterBeats) {
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
    )) {
      // Move customer1 to alternative beat
      const customerIndex = sourceBeat.stops.findIndex(s => s.customerId === customer1.customerId);
      if (customerIndex !== -1) {
        sourceBeat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer1);
        console.log(`✅ Moved customer ${customer1.customerId} from beat ${beatId} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  // Try moving customer2 if moving customer1 failed
  for (const alternativeBeat of sameClusterBeats) {
    if (canAddCustomerWithDualConstraints(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      alternativeBeat, 
      routes, 
      isolationDistance,
      maxIntraBeatDistance
    )) {
      // Move customer2 to alternative beat
      const customerIndex = sourceBeat.stops.findIndex(s => s.customerId === customer2.customerId);
      if (customerIndex !== -1) {
        sourceBeat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer2);
        console.log(`✅ Moved customer ${customer2.customerId} from beat ${beatId} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  console.log(`❌ Could not resolve intra-beat violation between ${customer1.customerId} and ${customer2.customerId}`);
  return false;
}

function generateDualConstraintReport(routes: SalesmanRoute[], isolationDistance: number, maxIntraBeatDistance: number): {
  isolationViolations: number;
  intraBeatViolations: number;
  totalViolations: number;
  isolationPercentage: number;
  intraBeatPercentage: number;
  averageIntraBeatDistance: number;
  maxIntraBeatDistanceFound: number;
} {
  const isolationViolations = findAllIsolationViolations(routes, isolationDistance);
  const intraBeatViolations = findAllIntraBeatViolations(routes, maxIntraBeatDistance);
  
  // Calculate total customer pairs between different beats
  const totalInterBeatPairs = routes.reduce((total, route, i) => {
    return total + routes.slice(i + 1).reduce((pairCount, otherRoute) => {
      return pairCount + (route.stops.length * otherRoute.stops.length);
    }, 0);
  }, 0);
  
  // Calculate total customer pairs within beats
  const totalIntraBeatPairs = routes.reduce((total, route) => {
    return total + (route.stops.length * (route.stops.length - 1)) / 2;
  }, 0);
  
  // Calculate average and max intra-beat distances
  let totalIntraBeatDistance = 0;
  let intraBeatDistanceCount = 0;
  let maxIntraBeatDistanceFound = 0;
  
  routes.forEach(route => {
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        totalIntraBeatDistance += distance;
        intraBeatDistanceCount++;
        maxIntraBeatDistanceFound = Math.max(maxIntraBeatDistanceFound, distance);
      }
    }
  });
  
  const averageIntraBeatDistance = intraBeatDistanceCount > 0 ? totalIntraBeatDistance / intraBeatDistanceCount : 0;
  
  return {
    isolationViolations: isolationViolations.length,
    intraBeatViolations: intraBeatViolations.length,
    totalViolations: isolationViolations.length + intraBeatViolations.length,
    isolationPercentage: totalInterBeatPairs > 0 ? (isolationViolations.length / totalInterBeatPairs) * 100 : 0,
    intraBeatPercentage: totalIntraBeatPairs > 0 ? (intraBeatViolations.length / totalIntraBeatPairs) * 100 : 0,
    averageIntraBeatDistance: averageIntraBeatDistance * 1000, // Convert to meters
    maxIntraBeatDistanceFound: maxIntraBeatDistanceFound * 1000 // Convert to meters
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