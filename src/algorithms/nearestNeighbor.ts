import { LocationData, ClusteredCustomer, RouteStop, SalesmanRoute, AlgorithmResult } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from '../utils/distanceCalculator';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const nearestNeighbor = async (
  locationData: LocationData, 
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const { distributor, customers } = locationData;
  
  console.log(`Starting proximity-constrained nearest neighbor algorithm with ${customers.length} total customers`);
  console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
  console.log(`Proximity constraint: All outlets within 200m of each other in the same beat`);
  
  // CRITICAL: Calculate exact target number of beats
  const TARGET_TOTAL_BEATS = config.totalClusters * config.beatsPerCluster;
  const PROXIMITY_CONSTRAINT = 0.2; // 200 meters in kilometers
  
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
  
  // Process each cluster independently to ensure exactly beatsPerCluster beats
  for (const clusterId of Object.keys(customersByCluster)) {
    const clusterCustomers = [...customersByCluster[Number(clusterId)]];
    const clusterSize = clusterCustomers.length;
    
    console.log(`Processing cluster ${clusterId} with ${clusterCustomers.length} customers`);
    console.log(`Target: exactly ${config.beatsPerCluster} beats for this cluster`);
    
    // CRITICAL: Track assigned customers within this cluster only
    const clusterAssignedIds = new Set<string>();
    
    // Create exactly beatsPerCluster beats with proximity constraints
    const clusterRoutes = createProximityConstrainedBeats(
      clusterCustomers,
      distributor,
      config,
      currentSalesmanId,
      Number(clusterId),
      clusterAssignedIds,
      config.beatsPerCluster,
      PROXIMITY_CONSTRAINT
    );
    
    // Verify all cluster customers are assigned exactly once
    const assignedInCluster = clusterRoutes.reduce((count, route) => count + route.stops.length, 0);
    console.log(`Cluster ${clusterId}: ${assignedInCluster}/${clusterSize} customers assigned in ${clusterRoutes.length} beats`);
    
    if (assignedInCluster !== clusterSize) {
      console.error(`CLUSTER ${clusterId} ERROR: Expected ${clusterSize} customers, got ${assignedInCluster}`);
      
      // Find and assign missing customers with proximity constraints
      const missingCustomers = clusterCustomers.filter(c => !clusterAssignedIds.has(c.id));
      console.log(`Missing customers in cluster ${clusterId}:`, missingCustomers.map(c => c.id));
      
      // Force assign missing customers to compatible beats
      missingCustomers.forEach(customer => {
        const compatibleRoute = findCompatibleRouteWithProximity(customer, clusterRoutes, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
        
        if (compatibleRoute) {
          compatibleRoute.stops.push({
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
          console.log(`Force-assigned missing customer ${customer.id} to route ${compatibleRoute.salesmanId} (proximity satisfied)`);
        } else {
          // Create new beat if no compatible route found
          const newRoute: SalesmanRoute = {
            salesmanId: currentSalesmanId + clusterRoutes.length,
            stops: [{
              customerId: customer.id,
              latitude: customer.latitude,
              longitude: customer.longitude,
              distanceToNext: 0,
              timeToNext: 0,
              visitTime: config.customerVisitTimeMinutes,
              clusterId: customer.clusterId,
              outletName: customer.outletName
            }],
            totalDistance: 0,
            totalTime: 0,
            clusterIds: [Number(clusterId)],
            distributorLat: distributor.latitude,
            distributorLng: distributor.longitude
          };
          clusterRoutes.push(newRoute);
          clusterAssignedIds.add(customer.id);
          console.log(`Created new beat ${newRoute.salesmanId} for customer ${customer.id} (proximity constraint)`);
        }
      });
    }
    
    // Add cluster customers to global tracking
    clusterAssignedIds.forEach(id => globalAssignedCustomerIds.add(id));
    
    routes.push(...clusterRoutes);
    currentSalesmanId += clusterRoutes.length;
    
    console.log(`Cluster ${clusterId} complete: ${clusterRoutes.length} proximity-constrained beats created`);
  }
  
  // CRITICAL: Final verification - ensure ALL customers are assigned exactly once
  const finalAssignedCount = globalAssignedCustomerIds.size;
  const totalCustomers = allCustomers.length;
  
  console.log(`GLOBAL VERIFICATION: ${finalAssignedCount}/${totalCustomers} customers assigned`);
  console.log(`BEAT COUNT VERIFICATION: ${routes.length} beats created (target was ${TARGET_TOTAL_BEATS})`);
  
  if (finalAssignedCount !== totalCustomers) {
    console.error(`CRITICAL ERROR: ${totalCustomers - finalAssignedCount} customers missing from routes!`);
    
    // Emergency assignment of missing customers with proximity constraints
    const missingCustomers = allCustomers.filter(customer => !globalAssignedCustomerIds.has(customer.id));
    console.error('Missing customers:', missingCustomers.map(c => c.id));
    
    missingCustomers.forEach(customer => {
      // Find a compatible route in the same cluster
      const sameClusterRoutes = routes.filter(route => 
        route.clusterIds.includes(customer.clusterId)
      );
      
      const compatibleRoute = findCompatibleRouteWithProximity(customer, sameClusterRoutes, PROXIMITY_CONSTRAINT, config.maxOutletsPerBeat);
      
      if (compatibleRoute) {
        compatibleRoute.stops.push({
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
        console.log(`Emergency assigned customer ${customer.id} to route ${compatibleRoute.salesmanId} (proximity satisfied)`);
      } else {
        // Create emergency route
        const emergencyRoute: SalesmanRoute = {
          salesmanId: routes.length + 1,
          stops: [{
            customerId: customer.id,
            latitude: customer.latitude,
            longitude: customer.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: customer.clusterId,
            outletName: customer.outletName
          }],
          totalDistance: 0,
          totalTime: 0,
          clusterIds: [customer.clusterId],
          distributorLat: distributor.latitude,
          distributorLng: distributor.longitude
        };
        routes.push(emergencyRoute);
        globalAssignedCustomerIds.add(customer.id);
        console.log(`Created emergency beat for customer ${customer.id}`);
      }
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
  
  // FINAL verification and proximity validation
  const finalCustomerCount = finalRoutes.reduce((count, route) => count + route.stops.length, 0);
  const uniqueCustomerIds = new Set(finalRoutes.flatMap(route => route.stops.map(stop => stop.customerId)));
  
  console.log(`FINAL VERIFICATION:`);
  console.log(`- Total customers in routes: ${finalCustomerCount}`);
  console.log(`- Unique customers: ${uniqueCustomerIds.size}`);
  console.log(`- Expected customers: ${totalCustomers}`);
  console.log(`- Total beats created: ${finalRoutes.length}`);
  
  // Validate proximity constraints
  const proximityViolations = validateProximityConstraints(finalRoutes, PROXIMITY_CONSTRAINT);
  console.log(`- Proximity constraint violations: ${proximityViolations}`);
  
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
  
  // Calculate total distance (not optimized, just for reporting)
  const totalDistance = finalRoutes.reduce((total, route) => total + route.totalDistance, 0);
  
  return {
    name: `Proximity-Constrained Nearest Neighbor (${config.totalClusters} Clusters, ${finalRoutes.length} Beats, 200m Constraint)`,
    totalDistance,
    totalSalesmen: finalRoutes.length,
    processingTime: 0,
    routes: finalRoutes
  };
};

function createProximityConstrainedBeats(
  customers: ClusteredCustomer[],
  distributor: { latitude: number; longitude: number },
  config: ClusteringConfig,
  startingSalesmanId: number,
  clusterId: number,
  assignedIds: Set<string>,
  targetBeats: number,
  proximityConstraint: number
): SalesmanRoute[] {
  if (customers.length === 0) return [];
  
  console.log(`Creating proximity-constrained beats for cluster ${clusterId} with ${customers.length} customers`);
  console.log(`Proximity constraint: ${proximityConstraint * 1000}m between all outlets in the same beat`);
  
  const routes: SalesmanRoute[] = [];
  let salesmanId = startingSalesmanId;
  
  // Create a working copy of customers for this cluster
  const remainingCustomers = customers.filter(c => !assignedIds.has(c.id));
  
  // Calculate equal distribution target
  const customersPerBeat = Math.ceil(remainingCustomers.length / targetBeats);
  console.log(`Target customers per beat: ${customersPerBeat} (equal distribution)`);
  
  // Create beats with strict proximity constraints
  while (remainingCustomers.length > 0 && routes.length < targetBeats) {
    const route: SalesmanRoute = {
      salesmanId: salesmanId++,
      stops: [],
      totalDistance: 0,
      totalTime: 0,
      clusterIds: [clusterId],
      distributorLat: distributor.latitude,
      distributorLng: distributor.longitude
    };
    
    // Start with a random customer to ensure equal distribution
    const startIndex = Math.floor(Math.random() * remainingCustomers.length);
    const startCustomer = remainingCustomers.splice(startIndex, 1)[0];
    
    route.stops.push({
      customerId: startCustomer.id,
      latitude: startCustomer.latitude,
      longitude: startCustomer.longitude,
      distanceToNext: 0,
      timeToNext: 0,
      visitTime: config.customerVisitTimeMinutes,
      clusterId: startCustomer.clusterId,
      outletName: startCustomer.outletName
    });
    assignedIds.add(startCustomer.id);
    
    // Add customers that satisfy proximity constraint
    let addedToRoute = true;
    while (addedToRoute && route.stops.length < customersPerBeat && remainingCustomers.length > 0) {
      addedToRoute = false;
      
      // Find customers that satisfy proximity constraint with ALL existing customers in the beat
      for (let i = remainingCustomers.length - 1; i >= 0; i--) {
        const candidate = remainingCustomers[i];
        
        // Check if candidate is within proximity constraint of ALL customers in the current beat
        const satisfiesProximity = route.stops.every(stop => {
          const distance = calculateHaversineDistance(
            candidate.latitude, candidate.longitude,
            stop.latitude, stop.longitude
          );
          return distance <= proximityConstraint;
        });
        
        if (satisfiesProximity) {
          // Add this customer to the beat
          route.stops.push({
            customerId: candidate.id,
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            distanceToNext: 0,
            timeToNext: 0,
            visitTime: config.customerVisitTimeMinutes,
            clusterId: candidate.clusterId,
            outletName: candidate.outletName
          });
          assignedIds.add(candidate.id);
          remainingCustomers.splice(i, 1);
          addedToRoute = true;
          break; // Add one customer at a time to maintain proximity
        }
      }
    }
    
    routes.push(route);
    console.log(`Created proximity-constrained beat ${route.salesmanId} with ${route.stops.length} stops`);
  }
  
  // If we have fewer beats than target, create additional beats for remaining customers
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
    
    // Take remaining customers and apply proximity constraints
    const startCustomer = remainingCustomers.shift()!;
    route.stops.push({
      customerId: startCustomer.id,
      latitude: startCustomer.latitude,
      longitude: startCustomer.longitude,
      distanceToNext: 0,
      timeToNext: 0,
      visitTime: config.customerVisitTimeMinutes,
      clusterId: startCustomer.clusterId,
      outletName: startCustomer.outletName
    });
    assignedIds.add(startCustomer.id);
    
    // Add compatible customers
    for (let i = remainingCustomers.length - 1; i >= 0; i--) {
      const candidate = remainingCustomers[i];
      
      const satisfiesProximity = route.stops.every(stop => {
        const distance = calculateHaversineDistance(
          candidate.latitude, candidate.longitude,
          stop.latitude, stop.longitude
        );
        return distance <= proximityConstraint;
      });
      
      if (satisfiesProximity && route.stops.length < config.maxOutletsPerBeat) {
        route.stops.push({
          customerId: candidate.id,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          distanceToNext: 0,
          timeToNext: 0,
          visitTime: config.customerVisitTimeMinutes,
          clusterId: candidate.clusterId,
          outletName: candidate.outletName
        });
        assignedIds.add(candidate.id);
        remainingCustomers.splice(i, 1);
      }
    }
    
    routes.push(route);
    console.log(`Created additional proximity-constrained beat ${route.salesmanId} with ${route.stops.length} stops`);
  }
  
  console.log(`Cluster ${clusterId}: Created ${routes.length} proximity-constrained beats (target was ${targetBeats})`);
  
  return routes;
}

function findCompatibleRouteWithProximity(
  customer: ClusteredCustomer,
  routes: SalesmanRoute[],
  proximityConstraint: number,
  maxOutletsPerBeat: number
): SalesmanRoute | null {
  for (const route of routes) {
    // Check if route has space
    if (route.stops.length >= maxOutletsPerBeat) continue;
    
    // Check if customer satisfies proximity constraint with ALL customers in the route
    const satisfiesProximity = route.stops.every(stop => {
      const distance = calculateHaversineDistance(
        customer.latitude, customer.longitude,
        stop.latitude, stop.longitude
      );
      return distance <= proximityConstraint;
    });
    
    if (satisfiesProximity) {
      return route;
    }
  }
  
  return null;
}

function validateProximityConstraints(routes: SalesmanRoute[], proximityConstraint: number): number {
  let violations = 0;
  
  routes.forEach(route => {
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const distance = calculateHaversineDistance(
          route.stops[i].latitude, route.stops[i].longitude,
          route.stops[j].latitude, route.stops[j].longitude
        );
        
        if (distance > proximityConstraint) {
          violations++;
          console.warn(`Proximity violation in beat ${route.salesmanId}: ${distance.toFixed(3)}km > ${proximityConstraint}km`);
        }
      }
    }
  });
  
  return violations;
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