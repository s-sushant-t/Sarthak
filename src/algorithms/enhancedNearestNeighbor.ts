import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';
import { performDBSCANClustering, DBSCANCluster } from '../utils/dbscanClustering';
import { calculateConvexHull, calculateConvexHullArea } from '../utils/convexHull';

export const enhancedNearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`🚀 Starting ENHANCED nearest neighbor with ${customers.length} total customers`);
  console.log(`📊 Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // 1. Calculate mode distance for primary constraint
  const modeDistance = calculateModeDistance(customers);
  const maxPairwiseDistance = 2 * modeDistance; // 🔒 Hard limit constraint
  console.log(`📏 Mode distance: ${modeDistance.toFixed(2)} km, Max pairwise: ${maxPairwiseDistance.toFixed(2)} km`);
  
  // 2. 📦 DBSCAN Pre-clustering for natural geographic grouping
  const dbscanClusters = performDBSCANClustering(customers, { eps: 0.3, minSamples: 4 });
  console.log(`📦 DBSCAN created ${dbscanClusters.length} natural geographic clusters`);
  
  // Track all customers to ensure no duplicates or missing outlets
  const allCustomers = [...customers];
  const globalAssignedCustomerIds = new Set<string>();
  
  // Group customers by original cluster, then by DBSCAN cluster
  const customersByCluster = customers.reduce((acc, customer) => {
    if (!acc[customer.clusterId]) {
      acc[customer.clusterId] = [];
    }
    acc[customer.clusterId].push(customer);
    return acc;
  }, {} as Record<number, ClusteredCustomer[]>);
  
  const routes: SalesmanRoute[] = [];
  let currentSalesmanId = 1;
  
  // Process each original cluster independently
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    console.log(`🎯 Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    
    // Find DBSCAN sub-clusters within this original cluster
    const clusterDBSCANClusters = findDBSCANSubClusters(clusterCustomers, dbscanClusters);
    console.log(`📦 Found ${clusterDBSCANClusters.length} DBSCAN sub-clusters in cluster ${clusterId}`);
    
    const clusterAssignedIds = new Set<string>();
    
    // Create enhanced routes with all constraints
    const clusterRoutes = createEnhancedConstrainedRoutes(
      clusterCustomers,
      clusterDBSCANClusters,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds,
      modeDistance,
      maxPairwiseDistance
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`✅ Cluster ${clusterId}: ${assignedInCluster}/${clusterCustomers.length} customers assigned`);
    
    if (assignedInCluster !== clusterCustomers.length) {
      console.error(`❌ CLUSTER ${clusterId} ERROR: Expected ${clusterCustomers.length} customers, got ${assignedInCluster}`);
      handleMissingCustomers(clusterCustomers, clusterAssignedIds, clusterRoutes, config);
    }
    
    // Add cluster customers to global tracking
    clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
    
    routes.push(...clusterRoutes);
    currentSalesmanId += clusterRoutes.length;
    
    console.log(`🎉 Cluster ${clusterId} complete: ${clusterRoutes.length} enhanced beats created`);
  }
  
  // Final verification and emergency handling
  handleFinalVerification(allCustomers, globalAssignedCustomerIds, routes, config, distributor, currentSalesmanId);
  
  // Update route metrics for all routes
  routes.forEach(route => {
    updateRouteMetrics(route, distributor, config);
  });
  
  // Reassign beat IDs sequentially
  const finalRoutes = routes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
  
  // Final constraint validation and reporting
  const constraintReport = validateAllConstraints(finalRoutes, modeDistance, maxPairwiseDistance, config);
  console.log('🔍 Final Constraint Report:', constraintReport);
  
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `🚀 Enhanced Multi-Constraint Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function calculateModeDistance(customers: ClusteredCustomer[]): number {
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
  
  if (distances.length === 0) return 2;
  
  const binSize = 0.1; // Finer binning for more precise mode
  const frequencyMap = new Map<number, number>();
  
  distances.forEach(distance => {
    const bin = Math.round(distance / binSize) * binSize;
    frequencyMap.set(bin, (frequencyMap.get(bin) || 0) + 1);
  });
  
  let maxFrequency = 0;
  let modeDistance = 0;
  
  frequencyMap.forEach((frequency, bin) => {
    if (frequency > maxFrequency) {
      maxFrequency = frequency;
      modeDistance = bin;
    }
  });
  
  return Math.max(modeDistance, 1.0); // Minimum 1km for reasonable clustering
}

function findDBSCANSubClusters(
  clusterCustomers: ClusteredCustomer[], 
  dbscanClusters: DBSCANCluster[]
): DBSCANCluster[] {
  const subClusters: DBSCANCluster[] = [];
  
  // Find which DBSCAN clusters contain customers from this original cluster
  for (const dbscanCluster of dbscanClusters) {
    const overlappingCustomers = dbscanCluster.customers.filter(dbCustomer =>
      clusterCustomers.some(clusterCustomer => clusterCustomer.id === dbCustomer.id)
    );
    
    if (overlappingCustomers.length > 0) {
      subClusters.push({
        ...dbscanCluster,
        customers: overlappingCustomers
      });
    }
  }
  
  return subClusters;
}

function createEnhancedConstrainedRoutes(
  customers: ClusteredCustomer[],
  dbscanClusters: DBSCANCluster[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  modeDistance: number,
  maxPairwiseDistance: number
): SalesmanRoute[] {
  console.log(`🔧 Creating enhanced constrained routes for cluster ${clusterId}`);
  console.log(`📏 Mode distance: ${modeDistance.toFixed(2)} km, Max pairwise: ${maxPairwiseDistance.toFixed(2)} km`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Process each DBSCAN sub-cluster separately to prevent cross-contamination
  for (const dbscanCluster of dbscanClusters) {
    console.log(`📦 Processing DBSCAN cluster ${dbscanCluster.id} with ${dbscanCluster.customers.length} customers`);
    
    const subClusterRoutes = createRoutesFromDBSCANCluster(
      dbscanCluster,
      distributor,
      config,
      salesmanId,
      clusterId,
      assignedIds,
      modeDistance,
      maxPairwiseDistance
    );
    
    routes.push(...subClusterRoutes);
    salesmanId += subClusterRoutes.length;
  }
  
  // Handle any remaining unassigned customers
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  if (remainingCustomers.length > 0) {
    console.log(`🔄 Processing ${remainingCustomers.length} remaining customers`);
    
    const remainingRoutes = createRoutesFromRemainingCustomers(
      remainingCustomers,
      distributor,
      config,
      salesmanId,
      clusterId,
      assignedIds,
      modeDistance,
      maxPairwiseDistance
    );
    
    routes.push(...remainingRoutes);
  }
  
  return routes;
}

function createRoutesFromDBSCANCluster(
  dbscanCluster: DBSCANCluster,
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  modeDistance: number,
  maxPairwiseDistance: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  const remainingCustomers = [...dbscanCluster.customers];
  
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
    
    // 🧮 Start with seed customer using density-based selection
    const seedCustomer = findOptimalSeed(remainingCustomers, modeDistance);
    const seedIndex = remainingCustomers.indexOf(seedCustomer);
    
    if (seedIndex === -1) break;
    
    remainingCustomers.splice(seedIndex, 1);
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
    
    // Build route with all constraints
    buildRouteWithAllConstraints(
      route,
      remainingCustomers,
      assignedIds,
      config,
      modeDistance,
      maxPairwiseDistance
    );
    
    // 🧮 Validate convex hull area constraint
    if (route.stops.length >= 3) {
      const hull = calculateConvexHull(route.stops);
      const area = calculateConvexHullArea(hull);
      const maxArea = route.stops.length < 35 ? 2.5 : 3.0; // Smaller beats = tighter area
      
      if (area > maxArea) {
        console.warn(`⚠️ Beat ${route.salesmanId} convex hull area ${area.toFixed(2)} km² exceeds limit ${maxArea} km²`);
        // Apply area reduction strategy
        reduceRouteArea(route, maxArea, modeDistance);
      }
    }
    
    if (route.stops.length > 0) {
      routes.push(route);
      console.log(`✅ Created enhanced beat ${route.salesmanId} with ${route.stops.length} stops`);
    }
  }
  
  return routes;
}

function findOptimalSeed(customers: ClusteredCustomer[], modeDistance: number): ClusteredCustomer {
  let bestSeed = customers[0];
  let maxScore = 0;
  
  for (const candidate of customers) {
    let neighborCount = 0;
    let totalDistance = 0;
    
    for (const other of customers) {
      if (candidate.id !== other.id) {
        const distance = calculateHaversineDistance(
          candidate.latitude, candidate.longitude,
          other.latitude, other.longitude
        );
        
        if (distance <= modeDistance) {
          neighborCount++;
          totalDistance += distance;
        }
      }
    }
    
    // Score based on neighbor count and average distance (prefer dense, close clusters)
    const avgDistance = neighborCount > 0 ? totalDistance / neighborCount : modeDistance;
    const score = neighborCount * (modeDistance - avgDistance);
    
    if (score > maxScore) {
      maxScore = score;
      bestSeed = candidate;
    }
  }
  
  return bestSeed;
}

function buildRouteWithAllConstraints(
  route: SalesmanRoute,
  remainingCustomers: ClusteredCustomer[],
  assignedIds: Set<string>,
  config: ClusteringConfig,
  modeDistance: number,
  maxPairwiseDistance: number
): void {
  let addedInIteration = true;
  
  while (addedInIteration && 
         route.stops.length < config.maxOutletsPerBeat && 
         remainingCustomers.length > 0) {
    
    addedInIteration = false;
    let bestCandidate = null;
    let bestCandidateIndex = -1;
    let bestScore = -Infinity;
    
    for (let i = 0; i < remainingCustomers.length; i++) {
      const candidate = remainingCustomers[i];
      
      // 🔒 Check maximum pairwise distance constraint (HARD LIMIT)
      if (!checkMaxPairwiseDistanceConstraint(route.stops, candidate, maxPairwiseDistance)) {
        continue;
      }
      
      // 📉 Check percentile-based mode constraint (90% rule)
      if (!checkPercentileBasedModeConstraint(route.stops, candidate, modeDistance)) {
        continue;
      }
      
      // 🔁 Check inter-cluster transition penalty
      const interClusterPenalty = calculateInterClusterPenalty(route.stops, candidate);
      
      // Calculate candidate score (higher is better)
      const proximityScore = calculateProximityScore(route.stops, candidate, modeDistance);
      const workingTimeScore = calculateWorkingTimeScore(route, candidate, config);
      
      const totalScore = proximityScore + workingTimeScore - interClusterPenalty;
      
      if (totalScore > bestScore) {
        bestScore = totalScore;
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
      
      addedInIteration = true;
    }
  }
}

function checkMaxPairwiseDistanceConstraint(
  stops: RouteStop[], 
  candidate: ClusteredCustomer, 
  maxPairwiseDistance: number
): boolean {
  for (const stop of stops) {
    const distance = calculateHaversineDistance(
      candidate.latitude, candidate.longitude,
      stop.latitude, stop.longitude
    );
    
    if (distance > maxPairwiseDistance) {
      return false; // HARD LIMIT violated
    }
  }
  return true;
}

function checkPercentileBasedModeConstraint(
  stops: RouteStop[], 
  candidate: ClusteredCustomer, 
  modeDistance: number
): boolean {
  if (stops.length === 0) return true;
  
  const distances: number[] = [];
  
  // Calculate distances from candidate to all existing stops
  for (const stop of stops) {
    const distance = calculateHaversineDistance(
      candidate.latitude, candidate.longitude,
      stop.latitude, stop.longitude
    );
    distances.push(distance);
  }
  
  // Check if 90% of distances are within mode distance
  distances.sort((a, b) => a - b);
  const percentile90Index = Math.floor(distances.length * 0.9);
  const percentile90Distance = distances[percentile90Index];
  
  return percentile90Distance <= modeDistance;
}

function calculateInterClusterPenalty(stops: RouteStop[], candidate: ClusteredCustomer): number {
  if (stops.length === 0) return 0;
  
  // Check if candidate is from a different DBSCAN cluster than existing stops
  const existingDBSCANClusters = new Set(stops.map(stop => stop.clusterId));
  
  if (existingDBSCANClusters.has(candidate.clusterId)) {
    return 0; // Same cluster, no penalty
  } else {
    return 1000; // Different cluster, exponential penalty
  }
}

function calculateProximityScore(
  stops: RouteStop[], 
  candidate: ClusteredCustomer, 
  modeDistance: number
): number {
  if (stops.length === 0) return 100;
  
  let totalDistance = 0;
  for (const stop of stops) {
    const distance = calculateHaversineDistance(
      candidate.latitude, candidate.longitude,
      stop.latitude, stop.longitude
    );
    totalDistance += distance;
  }
  
  const avgDistance = totalDistance / stops.length;
  return Math.max(0, (modeDistance - avgDistance) * 100);
}

function calculateWorkingTimeScore(
  route: SalesmanRoute, 
  candidate: ClusteredCustomer, 
  config: ClusteringConfig
): number {
  // Estimate additional time if this candidate is added
  const nearestStop = route.stops.reduce((nearest, stop) => {
    const distance = calculateHaversineDistance(
      candidate.latitude, candidate.longitude,
      stop.latitude, stop.longitude
    );
    return distance < nearest.distance ? { stop, distance } : nearest;
  }, { stop: route.stops[0], distance: Infinity });
  
  const additionalTravelTime = calculateTravelTime(nearestStop.distance, config.travelSpeedKmh);
  const totalAdditionalTime = additionalTravelTime + config.customerVisitTimeMinutes;
  
  const remainingTime = config.maxWorkingTimeMinutes - route.totalTime;
  
  if (totalAdditionalTime > remainingTime) {
    return -1000; // Would exceed working time
  }
  
  return Math.max(0, remainingTime - totalAdditionalTime);
}

function reduceRouteArea(route: SalesmanRoute, maxArea: number, modeDistance: number): void {
  // Remove outlier stops that contribute most to area expansion
  while (route.stops.length > 3) {
    const hull = calculateConvexHull(route.stops);
    const currentArea = calculateConvexHullArea(hull);
    
    if (currentArea <= maxArea) break;
    
    // Find the stop that contributes most to the area
    let maxAreaReduction = 0;
    let stopToRemove = -1;
    
    for (let i = 0; i < route.stops.length; i++) {
      const tempStops = route.stops.filter((_, index) => index !== i);
      if (tempStops.length < 3) continue;
      
      const tempHull = calculateConvexHull(tempStops);
      const tempArea = calculateConvexHullArea(tempHull);
      const areaReduction = currentArea - tempArea;
      
      if (areaReduction > maxAreaReduction) {
        maxAreaReduction = areaReduction;
        stopToRemove = i;
      }
    }
    
    if (stopToRemove !== -1) {
      console.log(`🔧 Removing stop ${route.stops[stopToRemove].customerId} to reduce area`);
      route.stops.splice(stopToRemove, 1);
    } else {
      break;
    }
  }
}

function createRoutesFromRemainingCustomers(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  modeDistance: number,
  maxPairwiseDistance: number
): SalesmanRoute[] {
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  const remainingCustomers = [...customers];
  
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
    
    // Take customers up to max beat size
    const customersToTake = Math.min(config.maxOutletsPerBeat, remainingCustomers.length);
    
    for (let i = 0; i < customersToTake; i++) {
      const customer = remainingCustomers.shift()!;
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
    }
    
    if (route.stops.length > 0) {
      routes.push(route);
    }
  }
  
  return routes;
}

function handleMissingCustomers(
  clusterCustomers: ClusteredCustomer[],
  clusterAssignedIds: Set<string>,
  clusterRoutes: SalesmanRoute[],
  config: ClusteringConfig
): void {
  const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
  
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
    }
  });
}

function handleFinalVerification(
  allCustomers: ClusteredCustomer[],
  globalAssignedCustomerIds: Set<string>,
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  distributor: { latitude: number; longitude: number },
  currentSalesmanId: number
): void {
  const finalAssignedCount = globalAssignedCustomerIds.size;
  const totalCustomers = allCustomers.length;
  
  if (finalAssignedCount !== totalCustomers) {
    console.error(`❌ CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
    
    const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
    
    missingCustomers.forEach(customer => {
      const sameClusterRoutes = routes.filter(route => 
        route.clusterIds.includes(customer.clusterId) && 
        route.stops.length < config.maxOutletsPerBeat
      );
      
      let targetRoute = sameClusterRoutes[0];
      
      if (!targetRoute) {
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
    });
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

function validateAllConstraints(
  routes: SalesmanRoute[], 
  modeDistance: number, 
  maxPairwiseDistance: number, 
  config: ClusteringConfig
): any {
  const report = {
    totalBeats: routes.length,
    sizeViolations: 0,
    modeDistanceViolations: 0,
    maxPairwiseViolations: 0,
    convexHullViolations: 0,
    workingTimeViolations: 0,
    averageCompactness: 0
  };
  
  let totalCompactness = 0;
  
  routes.forEach(route => {
    // Size constraint check
    if (route.stops.length < config.minOutletsPerBeat || route.stops.length > config.maxOutletsPerBeat) {
      report.sizeViolations++;
    }
    
    // Working time constraint check
    if (route.totalTime > config.maxWorkingTimeMinutes) {
      report.workingTimeViolations++;
    }
    
    // Pairwise distance checks
    let modeViolations = 0;
    let maxPairwiseViolationFound = false;
    let totalInternalDistance = 0;
    let pairCount = 0;
    
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        
        totalInternalDistance += distance;
        pairCount++;
        
        if (distance > modeDistance) {
          modeViolations++;
        }
        
        if (distance > maxPairwiseDistance) {
          maxPairwiseViolationFound = true;
        }
      }
    }
    
    if (modeViolations > pairCount * 0.1) { // More than 10% violations
      report.modeDistanceViolations++;
    }
    
    if (maxPairwiseViolationFound) {
      report.maxPairwiseViolations++;
    }
    
    // Convex hull area check
    if (route.stops.length >= 3) {
      const hull = calculateConvexHull(route.stops);
      const area = calculateConvexHullArea(hull);
      const maxArea = route.stops.length < 35 ? 2.5 : 3.0;
      
      if (area > maxArea) {
        report.convexHullViolations++;
      }
    }
    
    // Calculate compactness
    if (pairCount > 0) {
      const avgInternalDistance = totalInternalDistance / pairCount;
      const compactness = Math.max(0, (modeDistance - avgInternalDistance) / modeDistance);
      totalCompactness += compactness;
    }
  });
  
  report.averageCompactness = totalCompactness / routes.length;
  
  return report;
}