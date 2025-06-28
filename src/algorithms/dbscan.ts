import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const dbscan = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting DBSCAN with strict 200m isolation for ${customers.length} customers`);
  console.log(`Target: ${config.totalClusters} clusters × ${config.beatsPerCluster} beats = ${config.totalClusters * config.beatsPerCluster} total beats`);
  
  const startTime = Date.now();
  
  try {
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    const allCustomers = [...customers];
    const globalAssignedIds = new Set<string>();
    
    // Group customers by cluster
    const customersByCluster = customers.reduce((acc, customer) => {
      if (!acc[customer.clusterId]) {
        acc[customer.clusterId] = [];
      }
      acc[customer.clusterId].push(customer);
      return acc;
    }, {} as Record<number, ClusteredCustomer[]>);
    
    const routes: SalesmanRoute[] = [];
    let currentSalesmanId = 1;
    
    // Process each cluster with strict isolation
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      console.log(`Processing cluster ${clusterId}: ${clusterCustomers.length} customers → ${config.beatsPerCluster} beats`);
      
      const clusterAssignedIds = new Set<string>();
      
      // Create geographically isolated beats with 200m minimum separation
      const clusterRoutes = await createStrictlyIsolatedBeats(
        clusterCustomers,
        distributor,
        config,
        currentSalesmanId,
        Number(clusterId),
        clusterAssignedIds,
        config.beatsPerCluster
      );
      
      // Verify assignment
      const assignedCount = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
      console.log(`Cluster ${clusterId}: ${assignedCount}/${clusterCustomers.length} assigned to ${clusterRoutes.length} beats`);
      
      // Handle any missing customers with isolation constraints
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      for (const customer of missingCustomers) {
        const suitableBeat = findSuitableBeatWithIsolation(customer, clusterRoutes, 0.2); // 200m
        if (suitableBeat) {
          suitableBeat.stops.push({
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
        } else {
          // Force assign to least conflicted beat if no suitable beat found
          const targetRoute = clusterRoutes.reduce((min, route) => 
            route.stops.length < min.stops.length ? route : min
          );
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
        }
      }
      
      // Add to global tracking
      clusterAssignedIds.forEach(id => globalAssignedIds.add(id));
      routes.push(...clusterRoutes);
      currentSalesmanId += clusterRoutes.length;
      
      // Yield control
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Apply comprehensive isolation optimization
    const optimizedRoutes = await enforceStrictIsolation(routes, config);
    
    // Update metrics
    optimizedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Final verification and reporting
    const finalRoutes = optimizedRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    const isolationReport = generateIsolationReport(finalRoutes);
    console.log('📊 Final Isolation Report:', isolationReport);
    
    const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
    const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    console.log(`✅ DBSCAN completed: ${finalRoutes.length} beats, ${finalCustomerCount} customers, ${totalDistance.toFixed(2)}km`);
    console.log(`🎯 Isolation violations: ${isolationReport.totalViolations} (${isolationReport.violationPercentage.toFixed(1)}%)`);
    
    return {
      name: `DBSCAN-Based Beat Formation (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
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

async function createStrictlyIsolatedBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  
  if (customers.length === 0) return [];
  
  console.log(`Creating ${targetBeats} strictly isolated beats for cluster ${clusterId}`);
  
  const ISOLATION_DISTANCE = 0.2; // 200m minimum separation
  
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
  
  // Assign customers using isolation-aware algorithm
  for (const customer of sortedCustomers) {
    let assigned = false;
    
    // Try to find a beat where this customer can be placed without violating 200m rule
    for (const route of routes) {
      if (canAddCustomerWithIsolation(customer, route, routes, ISOLATION_DISTANCE)) {
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
        break;
      }
    }
    
    // If no suitable beat found, assign to the beat with minimum conflicts
    if (!assigned) {
      const bestBeat = findBeatWithMinimumConflicts(customer, routes, ISOLATION_DISTANCE);
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
  }
  
  console.log(`Cluster ${clusterId}: Initial assignment complete. Beat sizes: ${routes.map(r => r.stops.length).join(', ')}`);
  
  return routes;
}

function canAddCustomerWithIsolation(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  minDistance: number
): boolean {
  // Check against all customers in other beats
  for (const otherBeat of allBeats) {
    if (otherBeat.salesmanId === targetBeat.salesmanId) continue;
    
    for (const stop of otherBeat.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < minDistance) {
        return false; // Violation found
      }
    }
  }
  
  return true; // No violations
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
        }
      }
    }
    
    // Prefer beats with fewer customers if conflicts are equal
    const score = conflicts * 1000 + route.stops.length;
    
    if (score < minConflicts) {
      minConflicts = score;
      bestBeat = route;
    }
  }
  
  return bestBeat;
}

function findSuitableBeatWithIsolation(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  minDistance: number
): SalesmanRoute | null {
  for (const route of routes) {
    if (canAddCustomerWithIsolation(customer, route, routes, minDistance)) {
      return route;
    }
  }
  return null;
}

async function enforceStrictIsolation(
  routes: SalesmanRoute[],
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  console.log('🔧 Enforcing strict 200m isolation between beats...');
  
  const ISOLATION_DISTANCE = 0.2; // 200m
  const MAX_ITERATIONS = 5;
  const MAX_MOVES_PER_ITERATION = 20;
  
  let optimizedRoutes = [...routes];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    console.log(`🔄 Isolation iteration ${iteration + 1}/${MAX_ITERATIONS}`);
    
    // Find all violations
    const violations = findAllIsolationViolations(optimizedRoutes, ISOLATION_DISTANCE);
    
    if (violations.length === 0) {
      console.log(`✅ Perfect isolation achieved after ${iteration + 1} iterations`);
      break;
    }
    
    console.log(`🚨 Found ${violations.length} isolation violations`);
    
    // Sort violations by severity (closest distances first)
    violations.sort((a, b) => a.distance - b.distance);
    
    let movesMade = 0;
    const maxMovesThisIteration = Math.min(violations.length, MAX_MOVES_PER_ITERATION);
    
    // Attempt to resolve violations by moving customers
    for (let i = 0; i < maxMovesThisIteration; i++) {
      const violation = violations[i];
      
      if (attemptViolationResolution(violation, optimizedRoutes, ISOLATION_DISTANCE)) {
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
    if (canAddCustomerWithIsolation(
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
    if (canAddCustomerWithIsolation(
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

function generateIsolationReport(routes: SalesmanRoute[]): {
  totalViolations: number;
  violationPercentage: number;
  averageViolationDistance: number;
  beatPairViolations: number;
} {
  const violations = findAllIsolationViolations(routes, 0.2); // 200m
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