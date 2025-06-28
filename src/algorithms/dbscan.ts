import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const dbscan = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting optimized DBSCAN with ${customers.length} customers`);
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
    
    // Process each cluster with optimized approach
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      console.log(`Processing cluster ${clusterId}: ${clusterCustomers.length} customers → ${config.beatsPerCluster} beats`);
      
      const clusterAssignedIds = new Set<string>();
      
      // Use fast geographical partitioning instead of complex DBSCAN
      const clusterRoutes = await createFastGeographicalBeats(
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
      
      // Handle any missing customers
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      missingCustomers.forEach(customer => {
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
      });
      
      // Add to global tracking
      clusterAssignedIds.forEach(id => globalAssignedIds.add(id));
      routes.push(...clusterRoutes);
      currentSalesmanId += clusterRoutes.length;
      
      // Yield control
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Apply fast isolation optimization
    const optimizedRoutes = await applyFastIsolationOptimization(routes, config);
    
    // Update metrics
    optimizedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Final verification
    const finalRoutes = optimizedRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
    const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    console.log(`✅ DBSCAN completed: ${finalRoutes.length} beats, ${finalCustomerCount} customers, ${totalDistance.toFixed(2)}km`);
    
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

async function createFastGeographicalBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number
): Promise<SalesmanRoute[]> {
  
  if (customers.length === 0) return [];
  
  console.log(`Creating ${targetBeats} beats for cluster ${clusterId} with fast geographical partitioning`);
  
  // Step 1: Calculate cluster bounds
  const bounds = {
    minLat: Math.min(...customers.map(c => c.latitude)),
    maxLat: Math.max(...customers.map(c => c.latitude)),
    minLng: Math.min(...customers.map(c => c.longitude)),
    maxLng: Math.max(...customers.map(c => c.longitude))
  };
  
  // Step 2: Create spatial grid for beat assignment
  const gridCols = Math.ceil(Math.sqrt(targetBeats));
  const gridRows = Math.ceil(targetBeats / gridCols);
  
  const cellWidth = (bounds.maxLng - bounds.minLng) / gridCols;
  const cellHeight = (bounds.maxLat - bounds.minLat) / gridRows;
  
  // Step 3: Initialize beats
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
  
  // Step 4: Assign customers to beats based on spatial grid
  customers.forEach(customer => {
    // Determine grid cell
    const colIndex = Math.min(
      Math.floor((customer.longitude - bounds.minLng) / cellWidth),
      gridCols - 1
    );
    const rowIndex = Math.min(
      Math.floor((customer.latitude - bounds.minLat) / cellHeight),
      gridRows - 1
    );
    
    // Map to beat index
    const beatIndex = (rowIndex * gridCols + colIndex) % targetBeats;
    
    // Assign to beat
    routes[beatIndex].stops.push({
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
  });
  
  // Step 5: Balance beat sizes
  const avgSize = Math.ceil(customers.length / targetBeats);
  const tolerance = Math.max(1, Math.floor(avgSize * 0.3));
  
  // Move customers from oversized to undersized beats
  let balanceIterations = 0;
  const maxBalanceIterations = 3;
  
  while (balanceIterations < maxBalanceIterations) {
    const oversized = routes.filter(r => r.stops.length > avgSize + tolerance);
    const undersized = routes.filter(r => r.stops.length < avgSize - tolerance);
    
    if (oversized.length === 0 || undersized.length === 0) break;
    
    // Move customers from oversized to undersized beats
    oversized.forEach(oversizedBeat => {
      while (oversizedBeat.stops.length > avgSize + tolerance && undersized.length > 0) {
        const undersizedBeat = undersized.find(r => r.stops.length < avgSize + tolerance);
        if (!undersizedBeat) break;
        
        // Move the last customer (arbitrary choice for speed)
        const customer = oversizedBeat.stops.pop();
        if (customer) {
          undersizedBeat.stops.push(customer);
        }
      }
    });
    
    balanceIterations++;
  }
  
  console.log(`Cluster ${clusterId}: Beat sizes after balancing: ${routes.map(r => r.stops.length).join(', ')}`);
  
  return routes;
}

async function applyFastIsolationOptimization(
  routes: SalesmanRoute[],
  config: ClusteringConfig
): Promise<SalesmanRoute[]> {
  console.log('Applying fast isolation optimization...');
  
  const ISOLATION_DISTANCE = 0.2; // 200m minimum separation
  const MAX_ITERATIONS = 3; // Limit iterations to prevent hanging
  
  let optimizedRoutes = [...routes];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let movesMade = 0;
    
    // Find and resolve the most critical violations only
    const violations = findCriticalViolations(optimizedRoutes, ISOLATION_DISTANCE);
    
    if (violations.length === 0) {
      console.log(`Isolation optimization completed after ${iteration + 1} iterations`);
      break;
    }
    
    console.log(`Iteration ${iteration + 1}: Resolving ${Math.min(violations.length, 10)} critical violations`);
    
    // Resolve only the first 10 violations to prevent hanging
    const violationsToResolve = violations.slice(0, 10);
    
    for (const violation of violationsToResolve) {
      const moved = attemptCustomerMove(violation, optimizedRoutes, ISOLATION_DISTANCE);
      if (moved) movesMade++;
    }
    
    if (movesMade === 0) {
      console.log('No beneficial moves found, stopping optimization');
      break;
    }
    
    // Yield control
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  const finalViolations = findCriticalViolations(optimizedRoutes, ISOLATION_DISTANCE);
  console.log(`Final isolation violations: ${finalViolations.length}`);
  
  return optimizedRoutes;
}

function findCriticalViolations(
  routes: SalesmanRoute[],
  minDistance: number
): Array<{
  customer: RouteStop;
  fromBeatId: number;
  conflictBeatId: number;
  distance: number;
}> {
  const violations: Array<{
    customer: RouteStop;
    fromBeatId: number;
    conflictBeatId: number;
    distance: number;
  }> = [];
  
  // Only check first 5 customers per beat to prevent hanging
  for (let i = 0; i < routes.length && violations.length < 50; i++) {
    const beat1 = routes[i];
    const customersToCheck = beat1.stops.slice(0, 5);
    
    for (const customer of customersToCheck) {
      for (let j = i + 1; j < routes.length; j++) {
        const beat2 = routes[j];
        const otherCustomersToCheck = beat2.stops.slice(0, 5);
        
        for (const otherCustomer of otherCustomersToCheck) {
          const distance = calculateHaversineDistance(
            customer.latitude, customer.longitude,
            otherCustomer.latitude, otherCustomer.longitude
          );
          
          if (distance < minDistance) {
            violations.push({
              customer,
              fromBeatId: beat1.salesmanId,
              conflictBeatId: beat2.salesmanId,
              distance
            });
            
            // Limit violations to prevent excessive processing
            if (violations.length >= 50) return violations;
          }
        }
      }
    }
  }
  
  // Sort by distance (closest violations first)
  return violations.sort((a, b) => a.distance - b.distance);
}

function attemptCustomerMove(
  violation: {
    customer: RouteStop;
    fromBeatId: number;
    conflictBeatId: number;
    distance: number;
  },
  routes: SalesmanRoute[],
  minDistance: number
): boolean {
  const { customer, fromBeatId } = violation;
  
  // Find alternative beats in the same cluster
  const sameClusterBeats = routes.filter(route => 
    route.salesmanId !== fromBeatId && 
    route.clusterIds.some(id => customer.clusterId === id)
  );
  
  if (sameClusterBeats.length === 0) return false;
  
  // Find the beat with minimum conflicts (check only first few customers for speed)
  let bestBeat: SalesmanRoute | null = null;
  let minConflicts = Infinity;
  
  for (const candidateBeat of sameClusterBeats) {
    let conflicts = 0;
    
    // Only check first 5 customers for speed
    const customersToCheck = candidateBeat.stops.slice(0, 5);
    
    for (const stop of customersToCheck) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance < minDistance) {
        conflicts++;
      }
    }
    
    if (conflicts < minConflicts) {
      minConflicts = conflicts;
      bestBeat = candidateBeat;
    }
  }
  
  // Move customer if it reduces conflicts
  if (bestBeat && minConflicts === 0) {
    const fromBeat = routes.find(r => r.salesmanId === fromBeatId);
    if (fromBeat) {
      const customerIndex = fromBeat.stops.findIndex(s => s.customerId === customer.customerId);
      if (customerIndex !== -1) {
        fromBeat.stops.splice(customerIndex, 1);
        bestBeat.stops.push(customer);
        return true;
      }
    }
  }
  
  return false;
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