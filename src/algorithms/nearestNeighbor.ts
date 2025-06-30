import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting Nearest Neighbor with TIGHT CLUSTERING (50m isolation + 200m max intra-beat) for ${customers.length} customers`);
  console.log(`Target: ${config.totalClusters} clusters × ${config.beatsPerCluster} beats = ${config.totalClusters * config.beatsPerCluster} total beats`);
  
  const startTime = Date.now();
  
  try {
    const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
    const STRICT_ISOLATION_DISTANCE = 0.05; // 50m minimum separation between beats
    const MAX_INTRA_BEAT_DISTANCE = 0.2; // 200m maximum distance within a beat
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
    
    // Process each cluster independently with TIGHT CLUSTERING
    for (const clusterId of Object.keys(customersByCluster)) {
      const clusterCustomers = [...customersByCluster[Number(clusterId)]];
      const clusterSize = clusterCustomers.length;
      
      console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
      console.log(`Target: exactly ${config.beatsPerCluster} beats for this cluster`);
      
      const clusterAssignedIds = new Set<string>();
      
      // Create exactly beatsPerCluster beats with TIGHT CLUSTERING
      const clusterRoutes = createTightClusteredBeatsNearestNeighbor(
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
        
        // Find and assign missing customers with TIGHT CLUSTERING constraints
        const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
        console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
        
        // Force assign missing customers to suitable beats
        missingCustomers.forEach(customer => {
          const suitableBeat = findSuitableBeatForTightClustering(customer, clusterRoutes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
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
    
    // Apply comprehensive TIGHT CLUSTERING optimization
    console.log('🔧 Applying TIGHT CLUSTERING optimization...');
    const optimizedRoutes = await enforceTightClusteringNN(routes, config, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    
    // Update route metrics for all routes
    optimizedRoutes.forEach(route => {
      updateRouteMetrics(route, distributor, config);
    });
    
    // Reassign beat IDs sequentially
    const finalRoutes = optimizedRoutes.map((route, index) => ({
      ...route,
      salesmanId: index + 1
    }));
    
    // Generate tight clustering report
    const constraintReport = generateTightClusteringReport(finalRoutes, STRICT_ISOLATION_DISTANCE, MAX_INTRA_BEAT_DISTANCE);
    console.log('📊 Final Tight Clustering Report:', constraintReport);
    
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
    console.log(`📏 Max intra-beat distance found: ${constraintReport.maxIntraBeatDistanceFound.toFixed(0)}m (limit: 200m)`);
    console.log(`📊 Avg intra-beat distance: ${constraintReport.averageIntraBeatDistance.toFixed(0)}m (target: <100m)`);
    
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
      name: `Nearest Neighbor Tight Clustering (${config.totalClusters} Clusters, ${finalRoutes.length} Beats, 50m+200m)`,
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

function createTightClusteredBeatsNearestNeighbor(
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
  
  console.log(`Creating exactly ${targetBeats} TIGHTLY CLUSTERED beats for cluster ${clusterId} with ${customers.length} customers`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  // STEP 1: Create geographical sub-clusters for tight clustering
  const subClusters = createGeographicalSubClusters(remainingCustomers, maxIntraBeatDistance, targetBeats);
  console.log(`Created ${subClusters.length} geographical sub-clusters for tight clustering`);
  
  // STEP 2: Create exactly targetBeats number of beats
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
    routes.push(route);
  }
  
  // STEP 3: Assign sub-clusters to beats for tight clustering
  let beatIndex = 0;
  for (const subCluster of subClusters) {
    const targetBeat = routes[beatIndex % targetBeats];
    
    // Try to add entire sub-cluster to maintain tight clustering
    let canAddEntireSubCluster = true;
    
    for (const customer of subCluster) {
      if (!canAddCustomerWithIsolation(customer, targetBeat, routes, isolationDistance)) {
        canAddEntireSubCluster = false;
        break;
      }
    }
    
    if (canAddEntireSubCluster) {
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
        
        // Remove from remaining customers
        const index = remainingCustomers.findIndex(c => c.id === customer.id);
        if (index !== -1) {
          remainingCustomers.splice(index, 1);
        }
      }
      console.log(`✅ Added tight sub-cluster of ${subCluster.length} customers to beat ${targetBeat.salesmanId}`);
    } else {
      // Add customers individually using nearest neighbor within tight clustering constraints
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
          
          // Remove from remaining customers
          const index = remainingCustomers.findIndex(c => c.id === customer.id);
          if (index !== -1) {
            remainingCustomers.splice(index, 1);
          }
        }
      }
    }
    
    beatIndex++;
  }
  
  // STEP 4: Handle any remaining customers using nearest neighbor with tight clustering
  while (remainingCustomers.length > 0) {
    const customer = remainingCustomers.shift()!;
    
    if (assignedIds.has(customer.id)) {
      continue; // Already assigned
    }
    
    // Find the beat where this customer creates the tightest clustering
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
      console.log(`Added remaining customer ${customer.id} to route ${targetRoute.salesmanId} for tight clustering`);
    }
  }
  
  console.log(`Cluster ${clusterId}: Created exactly ${routes.length} tightly clustered beats as required`);
  console.log(`Beat sizes: ${routes.map(r => r.stops.length).join(', ')}`);
  
  return routes;
}

function createGeographicalSubClusters(
  customers: ClusteredCustomer[],
  maxDistance: number,
  targetClusters: number
): ClusteredCustomer[][] {
  console.log(`Creating geographical sub-clusters with max distance ${maxDistance * 1000}m for tight clustering`);
  
  const subClusters: ClusteredCustomer[][] = [];
  const processed = new Set<string>();
  
  // Sort customers by geographical density for better clustering
  const customerDensities = customers.map(customer => {
    const nearbyCount = customers.filter(other => {
      if (other.id === customer.id) return false;
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        other.latitude, other.longitude
      );
      return distance <= maxDistance * 0.5; // Use half the max distance for density calculation
    }).length;
    
    return { customer, density: nearbyCount };
  });
  
  // Sort by density (highest first) to start with densest areas for tight clustering
  customerDensities.sort((a, b) => b.density - a.density);
  
  for (const { customer } of customerDensities) {
    if (processed.has(customer.id)) continue;
    
    // Start a new tight sub-cluster with this customer
    const subCluster: ClusteredCustomer[] = [customer];
    processed.add(customer.id);
    
    // Find all customers within tight clustering distance
    const queue = [customer];
    
    while (queue.length > 0) {
      const currentCustomer = queue.shift()!;
      
      for (const candidateCustomer of customers) {
        if (processed.has(candidateCustomer.id)) continue;
        
        const distance = calculateHaversineDistance(
          currentCustomer.latitude, currentCustomer.longitude,
          candidateCustomer.latitude, candidateCustomer.longitude
        );
        
        // Use a tighter distance for sub-clustering to ensure tight beats
        if (distance <= maxDistance * 0.7) { // 70% of max distance for tighter clustering
          subCluster.push(candidateCustomer);
          processed.add(candidateCustomer.id);
          queue.push(candidateCustomer);
        }
      }
    }
    
    subClusters.push(subCluster);
    console.log(`Created tight sub-cluster with ${subCluster.length} customers`);
  }
  
  // If we have too many sub-clusters, merge the smallest ones for better distribution
  while (subClusters.length > targetClusters * 1.5) {
    subClusters.sort((a, b) => a.length - b.length);
    const smallest = subClusters.shift()!;
    const secondSmallest = subClusters.shift()!;
    
    // Check if merging would violate tight clustering
    let canMerge = true;
    for (const customer1 of smallest) {
      for (const customer2 of secondSmallest) {
        const distance = calculateHaversineDistance(
          customer1.latitude, customer1.longitude,
          customer2.latitude, customer2.longitude
        );
        if (distance > maxDistance) {
          canMerge = false;
          break;
        }
      }
      if (!canMerge) break;
    }
    
    if (canMerge) {
      const merged = [...smallest, ...secondSmallest];
      subClusters.push(merged);
      console.log(`Merged two tight sub-clusters: ${smallest.length} + ${secondSmallest.length} = ${merged.length}`);
    } else {
      // Can't merge without violating tight clustering, put them back
      subClusters.push(smallest, secondSmallest);
      break;
    }
  }
  
  console.log(`Final tight sub-clusters: ${subClusters.map(sc => sc.length).join(', ')}`);
  
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
    
    // Check intra-beat distance constraint for tight clustering
    let maxDistanceInBeat = 0;
    let violatesIntraBeat = false;
    let totalDistanceInBeat = 0;
    
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
      totalDistanceInBeat += distance;
    }
    
    if (violatesIntraBeat) continue;
    
    // Calculate tight clustering score (prefer beats where customer fits very tightly)
    const avgDistanceInBeat = route.stops.length > 0 ? totalDistanceInBeat / route.stops.length : 0;
    
    // Score: heavily favor tight clustering (smaller average distance)
    const tightClusteringScore = avgDistanceInBeat * 2000 + maxDistanceInBeat * 1000 + route.stops.length * 10;
    
    if (tightClusteringScore < bestScore) {
      bestScore = tightClusteringScore;
      bestBeat = route;
    }
  }
  
  if (bestBeat) {
    const avgDistance = bestBeat.stops.length > 0 ? 
      bestBeat.stops.reduce((sum, stop) => {
        return sum + calculateHaversineDistance(
          customer.latitude, customer.longitude,
          stop.latitude, stop.longitude
        );
      }, 0) / bestBeat.stops.length : 0;
    
    console.log(`🎯 Found tight clustering beat for customer ${customer.id}: Beat ${bestBeat.salesmanId} (avg distance: ${(avgDistance * 1000).toFixed(0)}m)`);
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
    let avgDistanceInBeat = 0;
    
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
    
    // Count intra-beat distance violations and calculate average distance for tight clustering
    let totalDistanceInBeat = 0;
    for (const stop of route.stops) {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      
      totalDistanceInBeat += distance;
      
      if (distance > maxIntraBeatDistance) {
        intraBeatViolations++;
        totalViolationDistance += (distance - maxIntraBeatDistance);
      }
    }
    
    avgDistanceInBeat = route.stops.length > 0 ? totalDistanceInBeat / route.stops.length : 0;
    
    // Calculate violation score: prioritize isolation violations, then intra-beat violations, then tight clustering
    const violationScore = isolationViolations * 3000 + intraBeatViolations * 2000 + avgDistanceInBeat * 1000 + totalViolationDistance * 100 + route.stops.length;
    
    if (violationScore < minViolationScore) {
      minViolationScore = violationScore;
      bestBeat = route;
    }
  }
  
  return bestBeat;
}

async function enforceTightClusteringNN(
  routes: SalesmanRoute[],
  config: ClusteringConfig,
  isolationDistance: number,
  maxIntraBeatDistance: number
): Promise<SalesmanRoute[]> {
  console.log(`🔧 Enforcing tight clustering: ${isolationDistance * 1000}m isolation + ${maxIntraBeatDistance * 1000}m max intra-beat...`);
  
  const MAX_ITERATIONS = 15;
  const MAX_MOVES_PER_ITERATION = 40;
  
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
    
    // Prioritize resolving intra-beat violations for tight clustering
    const prioritizedViolations = [
      ...intraBeatViolations.map(v => ({ ...v, type: 'intra-beat', priority: 1 })),
      ...isolationViolations.map(v => ({ ...v, type: 'isolation', priority: 2 }))
    ].sort((a, b) => a.priority - b.priority || b.distance - a.distance); // Largest distances first for tight clustering
    
    const maxMovesThisIteration = Math.min(prioritizedViolations.length, MAX_MOVES_PER_ITERATION);
    
    // Attempt to resolve violations by moving customers
    for (let i = 0; i < maxMovesThisIteration; i++) {
      const violation = prioritizedViolations[i];
      
      if (violation.type === 'intra-beat') {
        if (attemptIntraBeatViolationResolutionForTightClustering(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
          movesMade++;
        }
      } else {
        if (attemptIsolationViolationResolutionForTightClustering(violation, optimizedRoutes, isolationDistance, maxIntraBeatDistance)) {
          movesMade++;
        }
      }
    }
    
    console.log(`📊 Iteration ${iteration + 1}: Resolved ${movesMade}/${maxMovesThisIteration} violations`);
    
    if (movesMade === 0) {
      console.log('⚠️ No more beneficial moves possible for tight clustering');
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

function attemptIsolationViolationResolutionForTightClustering(
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
  
  // Try moving customer1 to maintain tight clustering
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
        console.log(`🔄 Moved customer ${customer1.customerId} from beat ${beat1Id} to beat ${alternativeBeat.salesmanId} for tight clustering`);
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
        console.log(`🔄 Moved customer ${customer2.customerId} from beat ${beat2Id} to beat ${alternativeBeat.salesmanId} for tight clustering`);
        return true;
      }
    }
  }
  
  return false; // Could not resolve this violation
}

function attemptIntraBeatViolationResolutionForTightClustering(
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
  
  console.log(`🔧 Resolving intra-beat violation for tight clustering: ${customer1.customerId} ↔ ${customer2.customerId} in beat ${beatId} = ${(violation.distance * 1000).toFixed(0)}m`);
  
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
  
  console.log(`❌ Could not resolve intra-beat violation between ${customer1.customerId} and ${customer2.customerId} for tight clustering`);
  return false;
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