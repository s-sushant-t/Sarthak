import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const dbscan = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting DBSCAN with TIGHT CLUSTERING (50m isolation + 200m max intra-beat) for ${customers.length} customers`);
  console.log(`Target: ${config.totalClusters} clusters × ${config.beatsPerCluster} beats = ${config.totalClusters * config.beatsPerCluster} total beats`);
  
  const startTime = Date.now();
  
  try {
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    const STRICT_ISOLATION_DISTANCE = 0.05; // 50m minimum separation between beats
    const MAX_INTRA_BEAT_DISTANCE = 0.2; // 200m maximum distance within a beat
    
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
    
    // Process each cluster with TIGHT CLUSTERING approach
    for (const [clusterId, clusterCustomers] of Object.entries(customersByCluster)) {
      const clusterAssignedIds = new Set<string>();
      
      console.log(`Processing cluster ${clusterId} with TIGHT CLUSTERING approach`);
      
      // Create beats using TIGHT CLUSTERING to ensure outlets are close together
      const clusterRoutes = await createTightlyClusteredBeats(
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
      console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterCustomers.length} customers assigned in ${clusterRoutes.length} beats`);
      
      // Handle any missing customers with TIGHT CLUSTERING constraints
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      if (missingCustomers.length > 0) {
        console.log(`Force-assigning ${missingCustomers.length} missing customers with tight clustering`);
        
        for (const customer of missingCustomers) {
          const suitableBeat = findSuitableBeatForTightClustering(customer, clusterRoutes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
          let targetRoute = suitableBeat;
          
          if (!targetRoute) {
            // Find beat with minimum constraint violations
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
    
    // Apply final tight clustering optimization
    console.log('🔧 Applying final tight clustering optimization...');
    const optimizedRoutes = await enforceTightClustering(routes, config, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    
    // Update metrics
    optimizedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Final verification and reporting
    const finalRoutes = optimizedRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    const constraintReport = generateTightClusteringReport(finalRoutes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    console.log('📊 Final Tight Clustering Report:', constraintReport);
    
    const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
    const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    console.log(`✅ DBSCAN completed: ${finalRoutes.length} beats, ${finalCustomerCount} customers, ${totalDistance.toFixed(2)}km`);
    console.log(`🎯 Constraint violations: Isolation=${constraintReport.isolationViolations}, Intra-beat=${constraintReport.intraBeatViolations}`);
    console.log(`📏 Max intra-beat distance found: ${constraintReport.maxIntraBeatDistanceFound.toFixed(0)}m (limit: 200m)`);
    console.log(`📊 Avg intra-beat distance: ${constraintReport.averageIntraBeatDistance.toFixed(0)}m (target: <100m)`);
    
    return {
      name: `DBSCAN Tight Clustering (${config.totalClusters} Clusters, ${finalRoutes.length} Beats, 50m+200m)`,
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

async function createTightlyClusteredBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number,
  isolationDistance: number,
  maxIntraBeatDistance: number
): Promise<SalesmanRoute[]> {
  
  if (customers.length === 0) return [];
  
  console.log(`Creating ${targetBeats} TIGHTLY CLUSTERED beats for cluster ${clusterId}`);
  
  // STEP 1: Create geographical sub-clusters using density-based approach
  const subClusters = createDensityBasedSubClusters(customers, maxIntraBeatDistance, targetBeats);
  console.log(`Created ${subClusters.length} density-based sub-clusters`);
  
  // STEP 2: Initialize beats
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
  
  // STEP 3: Assign sub-clusters to beats ensuring tight clustering
  let beatIndex = 0;
  for (const subCluster of subClusters) {
    const targetBeat = routes[beatIndex % targetBeats];
    
    // Check if we can add this entire sub-cluster to the beat without violating constraints
    let canAddSubCluster = true;
    
    // Check isolation constraints with other beats
    for (const customer of subCluster) {
      if (!canAddCustomerWithIsolation(customer, targetBeat, routes, isolationDistance)) {
        canAddSubCluster = false;
        break;
      }
    }
    
    if (canAddSubCluster) {
      // Add entire sub-cluster to this beat
      for (const customer of subCluster) {
        targetBeat.stops.push({
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
      console.log(`✅ Added sub-cluster of ${subCluster.length} customers to beat ${targetBeat.salesmanId}`);
    } else {
      // Try to add customers individually to different beats
      for (const customer of subCluster) {
        const suitableBeat = findSuitableBeatForTightClustering(customer, routes, isolationDistance, maxIntraBeatDistance);
        let targetRoute = suitableBeat;
        
        if (!targetRoute) {
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
        }
      }
    }
    
    beatIndex++;
  }
  
  console.log(`Cluster ${clusterId}: Tight clustering complete. Beat sizes: ${routes.map(r => r.stops.length).join(', ')}`);
  
  return routes;
}

function createDensityBasedSubClusters(
  customers: ClusteredCustomer[],
  maxDistance: number,
  targetClusters: number
): ClusteredCustomer[][] {
  console.log(`Creating density-based sub-clusters with max distance ${maxDistance * 1000}m`);
  
  const subClusters: ClusteredCustomer[][] = [];
  const processed = new Set<string>();
  
  // Sort customers by density (number of nearby customers)
  const customerDensities = customers.map(customer => {
    const nearbyCount = customers.filter(other => {
      if (other.id === customer.id) return false;
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        other.latitude, other.longitude
      );
      return distance <= maxDistance;
    }).length;
    
    return { customer, density: nearbyCount };
  });
  
  // Sort by density (highest first) to start with densest areas
  customerDensities.sort((a, b) => b.density - a.density);
  
  for (const { customer } of customerDensities) {
    if (processed.has(customer.id)) continue;
    
    // Start a new sub-cluster with this customer
    const subCluster: ClusteredCustomer[] = [customer];
    processed.add(customer.id);
    
    // Find all customers within maxDistance of any customer in the sub-cluster
    let addedCustomers = true;
    while (addedCustomers) {
      addedCustomers = false;
      
      for (const unprocessedCustomer of customers) {
        if (processed.has(unprocessedCustomer.id)) continue;
        
        // Check if this customer is within maxDistance of any customer in the sub-cluster
        const isNearby = subCluster.some(clusterCustomer => {
          const distance = calculateHaversineDistance(
            unprocessedCustomer.latitude, unprocessedCustomer.longitude,
            clusterCustomer.latitude, clusterCustomer.longitude
          );
          return distance <= maxDistance;
        });
        
        if (isNearby) {
          subCluster.push(unprocessedCustomer);
          processed.add(unprocessedCustomer.id);
          addedCustomers = true;
        }
      }
    }
    
    subClusters.push(subCluster);
    console.log(`Created sub-cluster with ${subCluster.length} customers`);
  }
  
  // If we have too many sub-clusters, merge the smallest ones
  while (subClusters.length > targetClusters * 2) {
    // Find the two smallest sub-clusters
    subClusters.sort((a, b) => a.length - b.length);
    const smallest = subClusters.shift()!;
    const secondSmallest = subClusters.shift()!;
    
    // Merge them
    const merged = [...smallest, ...secondSmallest];
    subClusters.push(merged);
    
    console.log(`Merged two small sub-clusters: ${smallest.length} + ${secondSmallest.length} = ${merged.length}`);
  }
  
  console.log(`Final sub-clusters: ${subClusters.map(sc => sc.length).join(', ')}`);
  
  return subClusters;
}

function canAddCustomerWithIsolation(
  customer: ClusteredCustomer,
  targetBeat: SalesmanRoute,
  allBeats: SalesmanRoute[],
  isolationDistance: number
): boolean {
  // Check 50m isolation with other beats
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
  
  return true; // No isolation violations
}

function findSuitableBeatForTightClustering(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  isolationDistance: number,
  maxIntraBeatDistance: number
): SalesmanRoute | null {
  // Find beats where this customer can be added while maintaining tight clustering
  let bestBeat: SalesmanRoute | null = null;
  let bestScore = Infinity;
  
  for (const route of routes) {
    // Check isolation constraint
    if (!canAddCustomerWithIsolation(customer, route, routes, isolationDistance)) {
      continue;
    }
    
    // Check intra-beat distance constraint
    let maxDistanceInBeat = 0;
    let violatesIntraBeat = false;
    
    for (const stop of route.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      if (distance > maxIntraBeatDistance) {
        violatesIntraBeat = true;
        break;
      }
      
      maxDistanceInBeat = Math.max(maxDistanceInBeat, distance);
    }
    
    if (violatesIntraBeat) continue;
    
    // Calculate clustering score (prefer beats where customer fits tightly)
    const avgDistanceInBeat = route.stops.length > 0 ? 
      route.stops.reduce((sum, stop) => {
        return sum + calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
      }, 0) / route.stops.length : 0;
    
    // Score: prefer beats with smaller average distance (tighter clustering)
    const score = avgDistanceInBeat * 1000 + route.stops.length;
    
    if (score < bestScore) {
      bestScore = score;
      bestBeat = route;
    }
  }
  
  return bestBeat;
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

async function enforceTightClustering(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  isolationDistance: number,
  maxIntraBeatDistance: number
): Promise<SalesmanRoute[]> {
  console.log('🔧 Enforcing tight clustering within beats...');
  
  const MAX_ITERATIONS = 15;
  const MAX_MOVES_PER_ITERATION = 30;
  
  let optimizedRoutes = [...routes];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    console.log(`🔄 Tight clustering iteration ${iteration + 1}/${MAX_ITERATIONS}`);
    
    // Find all constraint violations
    const isolationViolations = findAllIsolationViolations(optimizedRoutes, isolationDistance);
    const intraBeatViolations = findAllIntraBeatViolations(optimizedRoutes, maxIntraBeatDistance);
    
    const totalViolations = isolationViolations.length + intraBeatViolations.length;
    
    if (totalViolations === 0) {
      console.log(`✅ Perfect tight clustering achieved after ${iteration + 1} iterations`);
      break;
    }
    
    console.log(`🚨 Found ${isolationViolations.length} isolation + ${intraBeatViolations.length} intra-beat violations`);
    
    let movesMade = 0;
    
    // Prioritize resolving intra-beat violations to achieve tight clustering
    const prioritizedViolations = [
      ...intraBeatViolations.map(v => ({ ...v, type: 'intra-beat', priority: 1 })),
      ...isolationViolations.map(v => ({ ...v, type: 'isolation', priority: 2 }))
    ].sort((a, b) => a.priority - b.priority || b.distance - a.distance); // Largest distances first
    
    const maxMovesThisIteration = Math.min(prioritizedViolations.length, MAX_MOVES_PER_ITERATION);
    
    // Attempt to resolve violations by moving customers
    for (let i = 0; i < maxMovesThisIteration; i++) {
      const violation = prioritizedViolations[i];
      
      if (violation.type === 'intra-beat') {
        if (attemptIntraBeatViolationResolution(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
          movesMade++;
        }
      } else {
        if (attemptIsolationViolationResolution(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
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
  
  console.log(`🔧 Resolving intra-beat violation: ${customer1.customerId} ↔ ${customer2.customerId} in beat ${beatId} = ${(violation.distance * 1000).toFixed(0)}m`);
  
  const sourceBeat = routes.find(r => r.salesmanId === beatId);
  if (!sourceBeat) return false;
  
  // Try moving the customer that would create the tightest clustering elsewhere
  const sameClusterBeats = routes.filter(route => 
    route.salesmanId !== beatId && 
    route.clusterIds.some(id => customer1.clusterId === id)
  );
  
  // Try moving customer1 to a beat where it creates tighter clustering
  for (const alternativeBeat of sameClusterBeats) {
    const suitableBeat = findSuitableBeatForTightClustering(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      [alternativeBeat], 
      isolationDistance,
      maxIntraBeatDistance
    );
    
    if (suitableBeat) {
      // Move customer1 to alternative beat
      const customerIndex = sourceBeat.stops.findIndex(s => s.customerId === customer1.customerId);
      if (customerIndex !== -1) {
        sourceBeat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer1);
        console.log(`✅ Moved customer ${customer1.customerId} from beat ${beatId} to beat ${alternativeBeat.salesmanId} for tighter clustering`);
        return true;
      }
    }
  }
  
  // Try moving customer2 if moving customer1 failed
  for (const alternativeBeat of sameClusterBeats) {
    const suitableBeat = findSuitableBeatForTightClustering(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      [alternativeBeat], 
      isolationDistance,
      maxIntraBeatDistance
    );
    
    if (suitableBeat) {
      // Move customer2 to alternative beat
      const customerIndex = sourceBeat.stops.findIndex(s => s.customerId === customer2.customerId);
      if (customerIndex !== -1) {
        sourceBeat.stops.splice(customerIndex, 1);
        alternativeBeat.stops.push(customer2);
        console.log(`✅ Moved customer ${customer2.customerId} from beat ${beatId} to beat ${alternativeBeat.salesmanId} for tighter clustering`);
        return true;
      }
    }
  }
  
  console.log(`❌ Could not resolve intra-beat violation between ${customer1.customerId} and ${customer2.customerId}`);
  return false;
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
  
  console.log(`🔧 Resolving isolation violation: ${customer1.customerId} (beat ${beat1Id}) ↔ ${customer2.customerId} (beat ${beat2Id}) = ${(violation.distance * 1000).toFixed(0)}m`);
  
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
    const suitableBeat = findSuitableBeatForTightClustering(
      { 
        id: customer1.customerId, 
        latitude: customer1.latitude, 
        longitude: customer1.longitude, 
        clusterId: customer1.clusterId,
        outletName: customer1.outletName 
      }, 
      [alternativeBeat], 
      isolationDistance,
      maxIntraBeatDistance
    );
    
    if (suitableBeat) {
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
    const suitableBeat = findSuitableBeatForTightClustering(
      { 
        id: customer2.customerId, 
        latitude: customer2.latitude, 
        longitude: customer2.longitude, 
        clusterId: customer2.clusterId,
        outletName: customer2.outletName 
      }, 
      [alternativeBeat], 
      isolationDistance,
      maxIntraBeatDistance
    );
    
    if (suitableBeat) {
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
  
  console.log(`❌ Could not resolve isolation violation between ${customer1.customerId} and ${customer2.customerId}`);
  return false;
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

function generateTightClusteringReport(routes: SalesmanRoute[], isolationDistance: number, maxIntraBeatDistance: number): {
  isolationViolations: number;
  intraBeatViolations: number;
  totalViolations: number;
  isolationPercentage: number;
  intraBeatPercentage: number;
  averageIntraBeatDistance: number;
  maxIntraBeatDistanceFound: number;
  tightClusteringScore: number;
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
  
  // Calculate tight clustering score (lower is better)
  const tightClusteringScore = averageIntraBeatDistance * 1000 + intraBeatViolations.length * 100;
  
  return {
    isolationViolations: isolationViolations.length,
    intraBeatViolations: intraBeatViolations.length,
    totalViolations: isolationViolations.length + intraBeatViolations.length,
    isolationPercentage: totalInterBeatPairs > 0 ? (isolationViolations.length / totalInterBeatPairs) * 100 : 0,
    intraBeatPercentage: totalIntraBeatPairs > 0 ? (intraBeatViolations.length / totalIntraBeatPairs) * 100 : 0,
    averageIntraBeatDistance: averageIntraBeatDistance * 1000, // Convert to meters
    maxIntraBeatDistanceFound: maxIntraBeatDistanceFound * 1000, // Convert to meters
    tightClusteringScore
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