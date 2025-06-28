import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const dbscan = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting DBSCAN with STRICT 50m isolation for ${customers.length} customers`);
  console.log(`Target: ${config.totalClusters} clusters × ${config.beatsPerCluster} beats = ${config.totalClusters * config.beatsPerCluster} total beats`);
  
  const startTime = Date.now();
  
  try {
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    const STRICT_ISOLATION_DISTANCE = 0.05; // 50m minimum separation
    
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
    
    // Process each cluster with STRICT isolation enforcement
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      const clusterAssignedIds = new Set<string>();
      
      console.log(`Processing cluster ${clusterId} with STRICT 50m isolation`);
      
      // Create exactly beatsPerCluster beats with STRICT isolation
      const clusterRoutes = await createStrictlyIsolatedBeatsDBSCAN(
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
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterCustomers.length} customers assigned in ${clusterRoutes.length} beats`);
      
      // Handle any missing customers with STRICT isolation constraints
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      if (missingCustomers.length > 0) {
        console.log(`Force-assigning ${missingCustomers.length} missing customers with isolation constraints`);
        
        for (const customer of missingCustomers) {
          const suitableBeat = findSuitableBeatWithStrictIsolation(customer, clusterRoutes, STRICT_ISOLATION_DISTANCE);
          let targetRoute = suitableBeat;
          
          if (!targetRoute) {
            // Find beat with minimum conflicts
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
            console.log(`Force-assigned customer ${customer.id} to route ${targetRoute.salesmanId}`);
          }
        }
      }
      
      // Add cluster customers to global tracking
      clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
      
      routes.push(...clusterRoutes);
      currentSalesmanId += clusterRoutes.length;
      
      // Yield control between clusters
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Apply final strict isolation optimization
    console.log('🔧 Applying final STRICT 50m isolation optimization...');
    const optimizedRoutes = await enforceStrictIsolationDBSCAN(routes, config, STRICT_ISOLATION_DISTANCE);
    
    // Update metrics
    optimizedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Final verification and reporting
    const finalRoutes = optimizedRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    const isolationReport = generateIsolationReport(finalRoutes, STRICT_ISOLATION_DISTANCE);
    console.log('📊 Final STRICT Isolation Report:', isolationReport);
    
    const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
    const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    console.log(`✅ DBSCAN completed: ${finalRoutes.length} beats, ${finalCustomerCount} customers, ${totalDistance.toFixed(2)}km`);
    console.log(`🎯 STRICT Isolation violations: ${isolationReport.totalViolations} (${isolationReport.violationPercentage.toFixed(1)}%)`);
    
    return {
      name: `DBSCAN-Based Beat Formation (${config.totalClusters} Clusters, ${finalRoutes.length} Beats, 50m Isolation)`,
      totalDistance,
      totalSalesmen: finalRoutes.length,
      processingTime: Date.now() - startTime,
      routes: finalRoutes
    };
    
  } catch (error) {
    console.error('DBSCAN algorithm failed:', error);
    throw error;
  }
};

async function createStrictlyIsolatedBeatsDBSCAN(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number,
  isolationDistance: number
): Promise<SalesmanRoute[]> {
  
  if (customers.length === 0) return [];
  
  console.log(`Creating ${targetBeats} STRICTLY isolated beats (50m) for cluster ${clusterId}`);
  
  // Initialize beats
  const routes: SalesmanRoute[] = [];
  for (let i = 0; i < targetBeats; i++) {
    routes.push({
      salesmanId: startingSalesmanId + i,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    });
  }
  
  // Sort customers by geographical position for better spatial distribution
  const sortedCustomers = [...customers].sort((a, b) => {
    return (a.latitude + a.longitude) - (b.latitude + b.longitude);
  });
  
  // STRICT assignment: Only assign if NO violations
  for (const customer of sortedCustomers) {
    if (assignedIds.has(customer.id)) continue;
    
    let assigned = false;
    
    // Try each beat in order, assign to FIRST beat with NO violations
    for (const route of routes) {
      if (canAddCustomerWithStrictIsolation(customer, route, routes, isolationDistance)) {
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
        assigned = true;
        console.log(`✅ Assigned customer ${customer.id} to beat ${route.salesmanId} (NO violations)`);
        break;
      }
    }
    
    // If no violation-free assignment possible, assign to beat with minimum conflicts
    if (!assigned) {
      const bestBeat = findBeatWithMinimumConflicts(customer, routes, isolationDistance);
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
      console.log(`⚠️ Force-assigned customer ${customer.id} to beat ${bestBeat.salesmanId} (minimum conflicts)`);
    }
  }
  
  console.log(`Cluster ${clusterId}: Initial assignment complete. Beat sizes: ${routes.map(r => r.stops.length).join(', ')}`);
  
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
        console.log(`❌ Violation: Customer ${customer.id} would be ${(distance * 1000).toFixed(0)}m from customer ${stop.customerId} in beat ${otherBeat.salesmanId}`);
        return false; // STRICT: Any violation = rejection
      }
    }
  }
  
  return true; // No violations found
}

function findBeatWithMinimumConflicts(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  minDistance: number
): SalesmanRoute {
  let bestBeat = routes[0];
  let minConflicts = Infinity;
  let minTotalViolationDistance = Infinity;
  
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
      minTotalViolationDistance = totalViolationDistance;
    }
  }
  
  console.log(`🔍 Best beat for customer ${customer.id}: Beat ${bestBeat.salesmanId} (${Math.floor(minConflicts / 1000)} conflicts, ${minTotalViolationDistance.toFixed(3)}km total violation)`);
  
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

async function enforceStrictIsolationDBSCAN(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  isolationDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`🔧 Enforcing STRICT ${isolationDistance * 1000}m isolation between beats...`);
  
  const MAX_ITERATIONS = 10; // More iterations for strict enforcement
  const MAX_MOVES_PER_ITERATION = 50; // More moves per iteration
  
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
  
  console.log(`🔧 Attempting to resolve violation: ${customer1.customerId} (beat ${beat1Id}) ↔ ${customer2.customerId} (beat ${beat2Id}) = ${(violation.distance * 1000).toFixed(0)}m`);
  
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
        console.log(`✅ Moved customer ${customer1.customerId} from beat ${beat1Id} to beat ${alternativeBeat.salesmanId}`);
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
        console.log(`✅ Moved customer ${customer2.customerId} from beat ${beat2Id} to beat ${alternativeBeat.salesmanId}`);
        return true;
      }
    }
  }
  
  console.log(`❌ Could not resolve violation between ${customer1.customerId} and ${customer2.customerId}`);
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