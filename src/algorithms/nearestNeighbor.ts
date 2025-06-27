import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting equal-distribution nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  
  // Calculate target outlets per beat and cluster with 5% deviation tolerance
  const totalBeats = config.totalClusters * config.beatsPerCluster;
  const targetOutletsPerBeat = Math.floor(customers.length / totalBeats);
  const targetOutletsPerCluster = Math.floor(customers.length / config.totalClusters);
  const maxDeviation = Math.ceil(targetOutletsPerBeat * 0.05); // 5% deviation
  
  const minOutletsPerBeat = Math.max(1, targetOutletsPerBeat - maxDeviation);
  const maxOutletsPerBeat = targetOutletsPerBeat + maxDeviation;
  const minOutletsPerCluster = Math.max(1, targetOutletsPerCluster - maxDeviation);
  const maxOutletsPerCluster = targetOutletsPerCluster + maxDeviation;
  
  console.log(`Target distribution: ${targetOutletsPerBeat} outlets per beat (${minOutletsPerBeat}-${maxOutletsPerBeat})`);
  console.log(`Target distribution: ${targetOutletsPerCluster} outlets per cluster (${minOutletsPerCluster}-${maxOutletsPerCluster})`);
  
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
  
  // Process each cluster independently to ensure equal distribution
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    
    // Ensure cluster size is within 5% deviation
    if (clusterSize < minOutletsPerCluster || clusterSize > maxOutletsPerCluster) {
      console.warn(`Cluster ${clusterId} size ${clusterSize} outside target range ${minOutletsPerCluster}-${maxOutletsPerCluster}`);
    }
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create equal-distribution routes within the cluster
    const clusterRoutes = createEqualDistributionRoutesInCluster(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds,
      targetOutletsPerBeat,
      minOutletsPerBeat,
      maxOutletsPerBeat
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned`);
    
    if (assignedInCluster !== clusterSize) {
      console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
      
      // Find and assign missing customers
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
      
      // Force assign missing customers to maintain equal distribution
      missingCustomers.forEach(customer => {
        const targetRoute = clusterRoutes.reduce((min, route) => 
          route.stops.length < min.stops.length ? route : min
        );
        
        if (targetRoute && targetRoute.stops.length < maxOutletsPerBeat) {
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
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} equal-distribution beats created`);
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
        route.stops.length < maxOutletsPerBeat
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
  
  // Update route metrics for all routes (focusing on first-to-last outlet distance)
  routes.forEach(route => {
    updateRouteMetricsWithFirstToLastFocus(route, distributor, config);
  });
  
  // Reassign beat IDs sequentially
  const finalRoutes = routes.map((route, index) => ({
    ...route,
    salesmanId: index + 1
  }));
  
  // FINAL verification and distribution check
  const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(finalRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`FINAL VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  console.log(`- Total beats created: ${finalRoutes.length}`);
  
  // Check distribution equality
  const beatSizes = finalRoutes.map(route => route.stops.length);
  const minBeatSize = Math.min(...beatSizes);
  const maxBeatSize = Math.max(...beatSizes);
  const avgBeatSize = beatSizes.reduce((sum, size) => sum + size, 0) / beatSizes.length;
  const deviation = ((maxBeatSize - minBeatSize) / avgBeatSize) * 100;
  
  console.log(`DISTRIBUTION ANALYSIS:`);
  console.log(`- Beat sizes: min=${minBeatSize}, max=${maxBeatSize}, avg=${avgBeatSize.toFixed(1)}`);
  console.log(`- Deviation: ${deviation.toFixed(1)}% (target: ≤5%)`);
  
  if (deviation > 5) {
    console.warn(`Distribution deviation ${deviation.toFixed(1)}% exceeds 5% target`);
  }
  
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
  
  // Calculate total distance (sum of first-to-last distances for all beats)
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Equal-Distribution Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats, ${deviation.toFixed(1)}% deviation)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function createEqualDistributionRoutesInCluster(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetOutletsPerBeat: number,
  minOutletsPerBeat: number,
  maxOutletsPerBeat: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating equal-distribution routes for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`Target: ${targetOutletsPerBeat} outlets per beat (${minOutletsPerBeat}-${maxOutletsPerBeat})`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Calculate exact number of beats needed for equal distribution
  const beatsNeeded = Math.ceil(customers.length / targetOutletsPerBeat);
  console.log(`Creating exactly ${beatsNeeded} beats for equal distribution`);
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = [...customers];
  
  // Create beats with equal distribution
  for (let beatIndex = 0; beatIndex < beatsNeeded && remainingCustomers.length > 0; beatIndex++) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Calculate exact size for this beat to ensure equal distribution
    const remainingBeats = beatsNeeded - beatIndex;
    const remainingCustomersCount = remainingCustomers.length;
    const beatSize = Math.min(
      Math.ceil(remainingCustomersCount / remainingBeats),
      maxOutletsPerBeat
    );
    
    console.log(`Creating beat ${route.salesmanId}: targeting ${beatSize} outlets from ${remainingCustomersCount} remaining`);
    
    // Build route using first-to-last distance optimization
    const selectedCustomers = selectCustomersForMinimalFirstToLastDistance(
      remainingCustomers,
      beatSize,
      distributor
    );
    
    // Remove selected customers from remaining pool
    selectedCustomers.forEach(customer => {
      const index = remainingCustomers.findIndex(c => c.id === customer.id);
      if (index !== -1) {
        remainingCustomers.splice(index, 1);
        assignedIds.add(customer.id);
      }
    });
    
    // Add customers to route in optimal order for minimal first-to-last distance
    const optimizedOrder = optimizeOrderForMinimalFirstToLastDistance(selectedCustomers, distributor);
    
    optimizedOrder.forEach(customer => {
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
    });
    
    if (route.stops.length > 0) {
      routes.push(route);
      console.log(`Created equal-distribution beat ${route.salesmanId} with ${route.stops.length} stops`);
    }
  }
  
  // Handle any remaining customers by distributing them evenly
  if (remainingCustomers.length > 0) {
    console.log(`Distributing ${remainingCustomers.length} remaining customers evenly across existing routes...`);
    
    remainingCustomers.forEach((customer, index) => {
      const targetRouteIndex = index % routes.length;
      const targetRoute = routes[targetRouteIndex];
      
      if (targetRoute && targetRoute.stops.length < maxOutletsPerBeat) {
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
  
  return routes;
}

function selectCustomersForMinimalFirstToLastDistance(
  customers: ClusteredCustomer[],
  targetSize: number,
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[] {
  if (customers.length <= targetSize) {
    return [...customers];
  }
  
  // Try different combinations to find the one with minimal first-to-last distance
  let bestCombination: ClusteredCustomer[] = [];
  let minFirstToLastDistance = Infinity;
  
  // For performance, limit the number of combinations we try
  const maxAttempts = Math.min(100, customers.length);
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Randomly select customers
    const shuffled = [...customers].sort(() => Math.random() - 0.5);
    const combination = shuffled.slice(0, targetSize);
    
    // Calculate first-to-last distance for this combination
    const optimizedOrder = optimizeOrderForMinimalFirstToLastDistance(combination, distributor);
    if (optimizedOrder.length >= 2) {
      const firstCustomer = optimizedOrder[0];
      const lastCustomer = optimizedOrder[optimizedOrder.length - 1];
      const firstToLastDistance = calculateHaversineDistance(
        firstCustomer.latitude, firstCustomer.longitude,
        lastCustomer.latitude, lastCustomer.longitude
      );
      
      if (firstToLastDistance < minFirstToLastDistance) {
        minFirstToLastDistance = firstToLastDistance;
        bestCombination = combination;
      }
    }
  }
  
  return bestCombination.length > 0 ? bestCombination : customers.slice(0, targetSize);
}

function optimizeOrderForMinimalFirstToLastDistance(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number }
): ClusteredCustomer[] {
  if (customers.length <= 2) return customers;
  
  // Use nearest neighbor starting from distributor, but optimize for minimal first-to-last distance
  const optimized: ClusteredCustomer[] = [];
  const remaining = [...customers];
  
  // Find the customer closest to distributor as starting point
  let currentLat = distributor.latitude;
  let currentLng = distributor.longitude;
  
  // Select first customer (closest to distributor)
  let nearestIndex = 0;
  let shortestDistance = Infinity;
  
  for (let i = 0; i < remaining.length; i++) {
    const distance = calculateHaversineDistance(
      currentLat, currentLng,
      remaining[i].latitude, remaining[i].longitude
    );
    
    if (distance < shortestDistance) {
      shortestDistance = distance;
      nearestIndex = i;
    }
  }
  
  const firstCustomer = remaining.splice(nearestIndex, 1)[0];
  optimized.push(firstCustomer);
  currentLat = firstCustomer.latitude;
  currentLng = firstCustomer.longitude;
  
  // For the remaining customers, use nearest neighbor but consider the impact on first-to-last distance
  while (remaining.length > 1) {
    let bestNextIndex = 0;
    let bestScore = Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      
      // Calculate immediate distance (nearest neighbor component)
      const immediateDistance = calculateHaversineDistance(
        currentLat, currentLng,
        candidate.latitude, candidate.longitude
      );
      
      // Calculate potential first-to-last distance if we add this customer
      const potentialLastDistance = calculateHaversineDistance(
        firstCustomer.latitude, firstCustomer.longitude,
        candidate.latitude, candidate.longitude
      );
      
      // Combine both factors (weight immediate distance more heavily)
      const score = immediateDistance * 0.7 + potentialLastDistance * 0.3;
      
      if (score < bestScore) {
        bestScore = score;
        bestNextIndex = i;
      }
    }
    
    const nextCustomer = remaining.splice(bestNextIndex, 1)[0];
    optimized.push(nextCustomer);
    currentLat = nextCustomer.latitude;
    currentLng = nextCustomer.longitude;
  }
  
  // Add the last customer
  if (remaining.length === 1) {
    optimized.push(remaining[0]);
  }
  
  return optimized;
}

function updateRouteMetricsWithFirstToLastFocus(
  route: SalesmanRoute, 
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig
): void {
  route.totalTime = 0;
  
  if (route.stops.length === 0) {
    route.totalDistance = 0;
    return;
  }
  
  // Calculate first-to-last distance (the primary metric we're optimizing)
  if (route.stops.length >= 2) {
    const firstStop = route.stops[0];
    const lastStop = route.stops[route.stops.length - 1];
    route.totalDistance = calculateHaversineDistance(
      firstStop.latitude, firstStop.longitude,
      lastStop.latitude, lastStop.longitude
    );
  } else {
    route.totalDistance = 0;
  }
  
  // Calculate time and distance metrics for each stop
  let prevLat = distributor.latitude;
  let prevLng = distributor.longitude;
  
  for (let i = 0; i < route.stops.length; i++) {
    const stop = route.stops[i];
    const distance = calculateHaversineDistance(
      prevLat, prevLng,
      stop.latitude, stop.longitude
    );
    
    const travelTime = calculateTravelTime(distance, config.travelSpeedKmh);
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