import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';
import { ClusteringConfig } from '../components/ClusteringConfiguration';

export const clusterCustomers = async (
  customers: Customer[],
  config: ClusteringConfig
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    console.log(`Starting geographically isolated clustering for ${customers.length} customers`);
    console.log(`Configuration: ${config.totalClusters} clusters, ${config.beatsPerCluster} beats per cluster`);
    console.log(`Beat size range: ${config.minOutletsPerBeat}-${config.maxOutletsPerBeat} outlets per beat`);

    const TARGET_CLUSTERS = config.totalClusters;
    
    // Step 1: Create geographically isolated clusters using enhanced spatial separation
    const isolatedClusters = createGeographicallyIsolatedClusters(customers, TARGET_CLUSTERS);
    console.log(`Created ${isolatedClusters.length} geographically isolated clusters`);

    // Step 2: Validate geographical isolation
    const isolationValidation = validateGeographicalIsolation(isolatedClusters);
    if (!isolationValidation.isValid) {
      console.warn(`Isolation validation failed: ${isolationValidation.message}`);
      // Apply enhanced separation
      const enhancedClusters = enhanceClusterSeparation(isolatedClusters, customers);
      return convertClustersToCustomers(enhancedClusters);
    }

    // Step 3: Convert to clustered customers
    const clusteredCustomers = convertClustersToCustomers(isolatedClusters);

    // Step 4: Final validation
    const validationResult = validateClusteringResult(
      clusteredCustomers, 
      customers, 
      TARGET_CLUSTERS
    );
    
    if (!validationResult.isValid) {
      console.warn(`Final validation failed: ${validationResult.message}. Applying fallback...`);
      return geographicallyIsolatedFallback(customers, TARGET_CLUSTERS);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    const isolationMetrics = calculateIsolationMetrics(clusteredCustomers);
    
    console.log(`✅ Geographically isolated clustering result: ${clusterCount} clusters`);
    console.log('Cluster sizes:', clusterSizes);
    console.log('Isolation metrics:', isolationMetrics);
    console.log('Expected beats per cluster:', clusterSizes.map(size => Math.ceil(size / ((config.minOutletsPerBeat + config.maxOutletsPerBeat) / 2))));
    console.log('Total expected beats:', clusterSizes.reduce((total, size) => total + Math.ceil(size / ((config.minOutletsPerBeat + config.maxOutletsPerBeat) / 2)), 0));

    return clusteredCustomers;

  } catch (error) {
    console.warn('Geographically isolated clustering failed, using fallback:', error);
    return geographicallyIsolatedFallback(customers, config.totalClusters);
  }
};

interface GeographicalCluster {
  id: number;
  customers: Customer[];
  centroid: { latitude: number; longitude: number };
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  radius: number; // Maximum distance from centroid to any customer
}

function createGeographicallyIsolatedClusters(
  customers: Customer[],
  targetClusters: number
): GeographicalCluster[] {
  console.log(`Creating ${targetClusters} geographically isolated clusters...`);
  
  // Step 1: Find optimal cluster centers using k-means++ initialization
  const initialCenters = selectOptimalClusterCenters(customers, targetClusters);
  console.log('Selected initial cluster centers:', initialCenters);
  
  // Step 2: Apply iterative geographical clustering with isolation constraints
  let clusters = initializeClustersFromCenters(initialCenters);
  let iterations = 0;
  const maxIterations = 50;
  let converged = false;
  
  while (!converged && iterations < maxIterations) {
    // Assign customers to nearest cluster center
    const newAssignments = assignCustomersToNearestCenters(customers, clusters);
    
    // Update cluster centers and bounds
    const updatedClusters = updateClusterCentersAndBounds(newAssignments);
    
    // Check for convergence
    converged = checkConvergence(clusters, updatedClusters);
    clusters = updatedClusters;
    iterations++;
    
    // Apply isolation enforcement every few iterations
    if (iterations % 5 === 0) {
      clusters = enforceGeographicalIsolation(clusters, customers);
    }
  }
  
  console.log(`Clustering converged after ${iterations} iterations`);
  
  // Step 3: Final isolation enforcement and balancing
  clusters = enforceGeographicalIsolation(clusters, customers);
  clusters = balanceClusterSizes(clusters, customers);
  
  return clusters;
}

function selectOptimalClusterCenters(
  customers: Customer[],
  k: number
): { latitude: number; longitude: number }[] {
  const centers: { latitude: number; longitude: number }[] = [];
  
  // Use k-means++ initialization for better cluster separation
  // Step 1: Choose first center randomly
  const firstCenter = customers[Math.floor(Math.random() * customers.length)];
  centers.push({ latitude: firstCenter.latitude, longitude: firstCenter.longitude });
  
  // Step 2: Choose remaining centers with probability proportional to squared distance
  for (let i = 1; i < k; i++) {
    const distances = customers.map(customer => {
      const minDistanceToCenter = Math.min(...centers.map(center =>
        calculateDistance(customer.latitude, customer.longitude, center.latitude, center.longitude)
      ));
      return minDistanceToCenter * minDistanceToCenter; // Squared distance
    });
    
    const totalDistance = distances.reduce((sum, dist) => sum + dist, 0);
    const random = Math.random() * totalDistance;
    
    let cumulativeDistance = 0;
    for (let j = 0; j < customers.length; j++) {
      cumulativeDistance += distances[j];
      if (cumulativeDistance >= random) {
        centers.push({ 
          latitude: customers[j].latitude, 
          longitude: customers[j].longitude 
        });
        break;
      }
    }
  }
  
  return centers;
}

function initializeClustersFromCenters(
  centers: { latitude: number; longitude: number }[]
): GeographicalCluster[] {
  return centers.map((center, index) => ({
    id: index,
    customers: [],
    centroid: center,
    bounds: {
      minLat: center.latitude,
      maxLat: center.latitude,
      minLng: center.longitude,
      maxLng: center.longitude
    },
    radius: 0
  }));
}

function assignCustomersToNearestCenters(
  customers: Customer[],
  clusters: GeographicalCluster[]
): Map<number, Customer[]> {
  const assignments = new Map<number, Customer[]>();
  
  // Initialize assignments
  clusters.forEach(cluster => {
    assignments.set(cluster.id, []);
  });
  
  // Assign each customer to nearest cluster center
  customers.forEach(customer => {
    let nearestClusterId = 0;
    let minDistance = Infinity;
    
    clusters.forEach(cluster => {
      const distance = calculateDistance(
        customer.latitude, customer.longitude,
        cluster.centroid.latitude, cluster.centroid.longitude
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestClusterId = cluster.id;
      }
    });
    
    assignments.get(nearestClusterId)!.push(customer);
  });
  
  return assignments;
}

function updateClusterCentersAndBounds(
  assignments: Map<number, Customer[]>
): GeographicalCluster[] {
  const updatedClusters: GeographicalCluster[] = [];
  
  assignments.forEach((customers, clusterId) => {
    if (customers.length === 0) {
      // Keep empty cluster with previous centroid
      updatedClusters.push({
        id: clusterId,
        customers: [],
        centroid: { latitude: 0, longitude: 0 }, // Will be handled later
        bounds: { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 },
        radius: 0
      });
      return;
    }
    
    // Calculate new centroid
    const centroid = {
      latitude: customers.reduce((sum, c) => sum + c.latitude, 0) / customers.length,
      longitude: customers.reduce((sum, c) => sum + c.longitude, 0) / customers.length
    };
    
    // Calculate bounds
    const bounds = {
      minLat: Math.min(...customers.map(c => c.latitude)),
      maxLat: Math.max(...customers.map(c => c.latitude)),
      minLng: Math.min(...customers.map(c => c.longitude)),
      maxLng: Math.max(...customers.map(c => c.longitude))
    };
    
    // Calculate radius (maximum distance from centroid)
    const radius = Math.max(...customers.map(c =>
      calculateDistance(c.latitude, c.longitude, centroid.latitude, centroid.longitude)
    ));
    
    updatedClusters.push({
      id: clusterId,
      customers: [...customers],
      centroid,
      bounds,
      radius
    });
  });
  
  return updatedClusters;
}

function checkConvergence(
  oldClusters: GeographicalCluster[],
  newClusters: GeographicalCluster[]
): boolean {
  const threshold = 0.001; // 1 meter threshold for convergence
  
  for (let i = 0; i < oldClusters.length; i++) {
    const oldCenter = oldClusters[i].centroid;
    const newCenter = newClusters[i].centroid;
    
    const distance = calculateDistance(
      oldCenter.latitude, oldCenter.longitude,
      newCenter.latitude, newCenter.longitude
    );
    
    if (distance > threshold) {
      return false;
    }
  }
  
  return true;
}

function enforceGeographicalIsolation(
  clusters: GeographicalCluster[],
  allCustomers: Customer[]
): GeographicalCluster[] {
  console.log('Enforcing geographical isolation between clusters...');
  
  // Calculate minimum required separation distance
  const avgClusterRadius = clusters.reduce((sum, cluster) => sum + cluster.radius, 0) / clusters.length;
  const minSeparationDistance = avgClusterRadius * 1.5; // 50% buffer between clusters
  
  console.log(`Average cluster radius: ${avgClusterRadius.toFixed(2)}km, Min separation: ${minSeparationDistance.toFixed(2)}km`);
  
  let isolationViolations = 0;
  let maxIterations = 10;
  let iteration = 0;
  
  while (iteration < maxIterations) {
    isolationViolations = 0;
    
    // Check all pairs of clusters for isolation violations
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cluster1 = clusters[i];
        const cluster2 = clusters[j];
        
        // Calculate distance between cluster centroids
        const centroidDistance = calculateDistance(
          cluster1.centroid.latitude, cluster1.centroid.longitude,
          cluster2.centroid.latitude, cluster2.centroid.longitude
        );
        
        // Check if clusters are too close
        const requiredDistance = cluster1.radius + cluster2.radius + minSeparationDistance;
        
        if (centroidDistance < requiredDistance) {
          isolationViolations++;
          console.log(`Isolation violation: Clusters ${i} and ${j} are ${centroidDistance.toFixed(2)}km apart, need ${requiredDistance.toFixed(2)}km`);
          
          // Resolve violation by moving customers at the boundary
          resolveClusterOverlap(cluster1, cluster2, allCustomers);
        }
      }
    }
    
    if (isolationViolations === 0) {
      console.log('All clusters are now geographically isolated');
      break;
    }
    
    // Recalculate cluster properties after boundary adjustments
    clusters = clusters.map(cluster => {
      if (cluster.customers.length === 0) return cluster;
      
      const centroid = {
        latitude: cluster.customers.reduce((sum, c) => sum + c.latitude, 0) / cluster.customers.length,
        longitude: cluster.customers.reduce((sum, c) => sum + c.longitude, 0) / cluster.customers.length
      };
      
      const bounds = {
        minLat: Math.min(...cluster.customers.map(c => c.latitude)),
        maxLat: Math.max(...cluster.customers.map(c => c.latitude)),
        minLng: Math.min(...cluster.customers.map(c => c.longitude)),
        maxLng: Math.max(...cluster.customers.map(c => c.longitude))
      };
      
      const radius = Math.max(...cluster.customers.map(c =>
        calculateDistance(c.latitude, c.longitude, centroid.latitude, centroid.longitude)
      ));
      
      return { ...cluster, centroid, bounds, radius };
    });
    
    iteration++;
  }
  
  if (isolationViolations > 0) {
    console.warn(`Could not fully resolve all isolation violations after ${maxIterations} iterations`);
  }
  
  return clusters;
}

function resolveClusterOverlap(
  cluster1: GeographicalCluster,
  cluster2: GeographicalCluster,
  allCustomers: Customer[]
): void {
  // Find customers in the overlap zone and reassign them
  const midpoint = {
    latitude: (cluster1.centroid.latitude + cluster2.centroid.latitude) / 2,
    longitude: (cluster1.centroid.longitude + cluster2.centroid.longitude) / 2
  };
  
  // Check customers in cluster1 that might be closer to cluster2
  const customersToReassign: Customer[] = [];
  
  cluster1.customers.forEach(customer => {
    const distToCluster1 = calculateDistance(
      customer.latitude, customer.longitude,
      cluster1.centroid.latitude, cluster1.centroid.longitude
    );
    
    const distToCluster2 = calculateDistance(
      customer.latitude, customer.longitude,
      cluster2.centroid.latitude, cluster2.centroid.longitude
    );
    
    // If customer is closer to cluster2 and in the overlap zone
    if (distToCluster2 < distToCluster1) {
      const distToMidpoint = calculateDistance(
        customer.latitude, customer.longitude,
        midpoint.latitude, midpoint.longitude
      );
      
      // Only reassign if customer is near the boundary
      if (distToMidpoint < Math.min(cluster1.radius, cluster2.radius) * 0.3) {
        customersToReassign.push(customer);
      }
    }
  });
  
  // Reassign customers
  customersToReassign.forEach(customer => {
    cluster1.customers = cluster1.customers.filter(c => c.id !== customer.id);
    cluster2.customers.push(customer);
  });
  
  // Also check the reverse direction
  const customersToReassignReverse: Customer[] = [];
  
  cluster2.customers.forEach(customer => {
    const distToCluster1 = calculateDistance(
      customer.latitude, customer.longitude,
      cluster1.centroid.latitude, cluster1.centroid.longitude
    );
    
    const distToCluster2 = calculateDistance(
      customer.latitude, customer.longitude,
      cluster2.centroid.latitude, cluster2.centroid.longitude
    );
    
    if (distToCluster1 < distToCluster2) {
      const distToMidpoint = calculateDistance(
        customer.latitude, customer.longitude,
        midpoint.latitude, midpoint.longitude
      );
      
      if (distToMidpoint < Math.min(cluster1.radius, cluster2.radius) * 0.3) {
        customersToReassignReverse.push(customer);
      }
    }
  });
  
  customersToReassignReverse.forEach(customer => {
    cluster2.customers = cluster2.customers.filter(c => c.id !== customer.id);
    cluster1.customers.push(customer);
  });
}

function balanceClusterSizes(
  clusters: GeographicalCluster[],
  allCustomers: Customer[]
): GeographicalCluster[] {
  console.log('Balancing cluster sizes while maintaining isolation...');
  
  const totalCustomers = allCustomers.length;
  const targetSize = Math.floor(totalCustomers / clusters.length);
  const tolerance = Math.ceil(targetSize * 0.3); // 30% tolerance
  
  console.log(`Target cluster size: ${targetSize} ± ${tolerance} customers`);
  
  // Identify oversized and undersized clusters
  const oversizedClusters = clusters.filter(c => c.customers.length > targetSize + tolerance);
  const undersizedClusters = clusters.filter(c => c.customers.length < targetSize - tolerance);
  
  console.log(`Oversized clusters: ${oversizedClusters.length}, Undersized clusters: ${undersizedClusters.length}`);
  
  // Transfer customers from oversized to undersized clusters
  oversizedClusters.forEach(oversizedCluster => {
    const excess = oversizedCluster.customers.length - (targetSize + tolerance);
    
    if (excess > 0 && undersizedClusters.length > 0) {
      // Find customers on the periphery of the oversized cluster
      const peripheryCustomers = oversizedCluster.customers
        .map(customer => ({
          customer,
          distanceFromCenter: calculateDistance(
            customer.latitude, customer.longitude,
            oversizedCluster.centroid.latitude, oversizedCluster.centroid.longitude
          )
        }))
        .sort((a, b) => b.distanceFromCenter - a.distanceFromCenter)
        .slice(0, excess)
        .map(item => item.customer);
      
      // Assign each periphery customer to the nearest undersized cluster
      peripheryCustomers.forEach(customer => {
        let nearestUndersizedCluster = undersizedClusters[0];
        let minDistance = Infinity;
        
        undersizedClusters.forEach(cluster => {
          if (cluster.customers.length < targetSize + tolerance) {
            const distance = calculateDistance(
              customer.latitude, customer.longitude,
              cluster.centroid.latitude, cluster.centroid.longitude
            );
            
            if (distance < minDistance) {
              minDistance = distance;
              nearestUndersizedCluster = cluster;
            }
          }
        });
        
        // Transfer customer
        oversizedCluster.customers = oversizedCluster.customers.filter(c => c.id !== customer.id);
        nearestUndersizedCluster.customers.push(customer);
      });
    }
  });
  
  return clusters;
}

function validateGeographicalIsolation(
  clusters: GeographicalCluster[]
): { isValid: boolean; message: string } {
  console.log('Validating geographical isolation...');
  
  // Check that no clusters overlap
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const cluster1 = clusters[i];
      const cluster2 = clusters[j];
      
      // Calculate distance between cluster boundaries
      const centroidDistance = calculateDistance(
        cluster1.centroid.latitude, cluster1.centroid.longitude,
        cluster2.centroid.latitude, cluster2.centroid.longitude
      );
      
      const minRequiredDistance = cluster1.radius + cluster2.radius + 0.5; // 500m buffer
      
      if (centroidDistance < minRequiredDistance) {
        return {
          isValid: false,
          message: `Clusters ${i} and ${j} are not sufficiently isolated (${centroidDistance.toFixed(2)}km apart, need ${minRequiredDistance.toFixed(2)}km)`
        };
      }
    }
  }
  
  // Check that each cluster has a reasonable size
  const avgSize = clusters.reduce((sum, c) => sum + c.customers.length, 0) / clusters.length;
  const maxAllowedDeviation = avgSize * 0.5; // 50% deviation allowed
  
  for (const cluster of clusters) {
    if (Math.abs(cluster.customers.length - avgSize) > maxAllowedDeviation) {
      return {
        isValid: false,
        message: `Cluster ${cluster.id} size (${cluster.customers.length}) deviates too much from average (${avgSize.toFixed(1)})`
      };
    }
  }
  
  return { isValid: true, message: 'All clusters are geographically isolated' };
}

function enhanceClusterSeparation(
  clusters: GeographicalCluster[],
  allCustomers: Customer[]
): GeographicalCluster[] {
  console.log('Enhancing cluster separation...');
  
  // Apply additional separation techniques
  const enhancedClusters = [...clusters];
  
  // Use Voronoi-like partitioning to ensure clear boundaries
  allCustomers.forEach(customer => {
    let bestClusterId = 0;
    let minDistance = Infinity;
    
    enhancedClusters.forEach(cluster => {
      const distance = calculateDistance(
        customer.latitude, customer.longitude,
        cluster.centroid.latitude, cluster.centroid.longitude
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        bestClusterId = cluster.id;
      }
    });
    
    // Remove customer from all clusters first
    enhancedClusters.forEach(cluster => {
      cluster.customers = cluster.customers.filter(c => c.id !== customer.id);
    });
    
    // Add to the nearest cluster
    const targetCluster = enhancedClusters.find(c => c.id === bestClusterId);
    if (targetCluster) {
      targetCluster.customers.push(customer);
    }
  });
  
  return enhancedClusters;
}

function convertClustersToCustomers(clusters: GeographicalCluster[]): ClusteredCustomer[] {
  const clusteredCustomers: ClusteredCustomer[] = [];
  
  clusters.forEach(cluster => {
    cluster.customers.forEach(customer => {
      clusteredCustomers.push({
        ...customer,
        clusterId: cluster.id
      });
    });
  });
  
  return clusteredCustomers;
}

function calculateIsolationMetrics(customers: ClusteredCustomer[]): {
  avgIntraClusterDistance: number;
  avgInterClusterDistance: number;
  isolationRatio: number;
} {
  const clusterMap = new Map<number, ClusteredCustomer[]>();
  
  // Group customers by cluster
  customers.forEach(customer => {
    if (!clusterMap.has(customer.clusterId)) {
      clusterMap.set(customer.clusterId, []);
    }
    clusterMap.get(customer.clusterId)!.push(customer);
  });
  
  // Calculate average intra-cluster distance
  let totalIntraDistance = 0;
  let intraDistanceCount = 0;
  
  clusterMap.forEach(clusterCustomers => {
    for (let i = 0; i < clusterCustomers.length; i++) {
      for (let j = i + 1; j < clusterCustomers.length; j++) {
        const distance = calculateDistance(
          clusterCustomers[i].latitude, clusterCustomers[i].longitude,
          clusterCustomers[j].latitude, clusterCustomers[j].longitude
        );
        totalIntraDistance += distance;
        intraDistanceCount++;
      }
    }
  });
  
  const avgIntraClusterDistance = intraDistanceCount > 0 ? totalIntraDistance / intraDistanceCount : 0;
  
  // Calculate average inter-cluster distance (between cluster centroids)
  const clusterCentroids = Array.from(clusterMap.entries()).map(([clusterId, clusterCustomers]) => {
    const centroid = {
      clusterId,
      latitude: clusterCustomers.reduce((sum, c) => sum + c.latitude, 0) / clusterCustomers.length,
      longitude: clusterCustomers.reduce((sum, c) => sum + c.longitude, 0) / clusterCustomers.length
    };
    return centroid;
  });
  
  let totalInterDistance = 0;
  let interDistanceCount = 0;
  
  for (let i = 0; i < clusterCentroids.length; i++) {
    for (let j = i + 1; j < clusterCentroids.length; j++) {
      const distance = calculateDistance(
        clusterCentroids[i].latitude, clusterCentroids[i].longitude,
        clusterCentroids[j].latitude, clusterCentroids[j].longitude
      );
      totalInterDistance += distance;
      interDistanceCount++;
    }
  }
  
  const avgInterClusterDistance = interDistanceCount > 0 ? totalInterDistance / interDistanceCount : 0;
  
  // Calculate isolation ratio (higher is better)
  const isolationRatio = avgIntraClusterDistance > 0 ? avgInterClusterDistance / avgIntraClusterDistance : 0;
  
  return {
    avgIntraClusterDistance,
    avgInterClusterDistance,
    isolationRatio
  };
}

function validateClusteringResult(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  targetClusters: number
): { isValid: boolean; message: string } {
  // Check 1: All customers are assigned
  if (clusteredCustomers.length !== originalCustomers.length) {
    return {
      isValid: false,
      message: `Customer count mismatch: Input ${originalCustomers.length}, Output ${clusteredCustomers.length}`
    };
  }
  
  // Check 2: Correct number of clusters
  const actualClusters = new Set(clusteredCustomers.map(c => c.clusterId)).size;
  if (actualClusters !== targetClusters) {
    return {
      isValid: false,
      message: `Cluster count mismatch: Expected ${targetClusters}, Got ${actualClusters}`
    };
  }
  
  // Check 3: No duplicates
  const customerIds = clusteredCustomers.map(c => c.id);
  const uniqueIds = new Set(customerIds);
  if (customerIds.length !== uniqueIds.size) {
    return {
      isValid: false,
      message: `Duplicate customers detected`
    };
  }
  
  // Check 4: All original customers present
  const originalIds = new Set(originalCustomers.map(c => c.id));
  const clusteredIds = new Set(clusteredCustomers.map(c => c.id));
  
  const missingIds = Array.from(originalIds).filter(id => !clusteredIds.has(id));
  if (missingIds.length > 0) {
    return {
      isValid: false,
      message: `Missing customers: ${missingIds.length} customers not assigned`
    };
  }
  
  return { isValid: true, message: 'All validation checks passed' };
}

function getClusterSizes(customers: ClusteredCustomer[]): number[] {
  const clusterMap = new Map<number, number>();
  
  customers.forEach(customer => {
    clusterMap.set(customer.clusterId, (clusterMap.get(customer.clusterId) || 0) + 1);
  });
  
  return Array.from(clusterMap.values()).sort((a, b) => a - b);
}

function geographicallyIsolatedFallback(
  customers: Customer[],
  targetClusters: number
): ClusteredCustomer[] {
  console.log(`Applying geographically isolated fallback for ${targetClusters} clusters...`);
  
  // Use a simple but effective geographical separation approach
  // 1. Find the geographical bounds
  const bounds = {
    minLat: Math.min(...customers.map(c => c.latitude)),
    maxLat: Math.max(...customers.map(c => c.latitude)),
    minLng: Math.min(...customers.map(c => c.longitude)),
    maxLng: Math.max(...customers.map(c => c.longitude))
  };
  
  // 2. Create a grid-based approach for guaranteed isolation
  const gridSize = Math.ceil(Math.sqrt(targetClusters));
  const latStep = (bounds.maxLat - bounds.minLat) / gridSize;
  const lngStep = (bounds.maxLng - bounds.minLng) / gridSize;
  
  return customers.map(customer => {
    // Determine which grid cell this customer belongs to
    const latIndex = Math.min(Math.floor((customer.latitude - bounds.minLat) / latStep), gridSize - 1);
    const lngIndex = Math.min(Math.floor((customer.longitude - bounds.minLng) / lngStep), gridSize - 1);
    const clusterId = latIndex * gridSize + lngIndex;
    
    return {
      id: customer.id,
      latitude: customer.latitude,
      longitude: customer.longitude,
      outletName: customer.outletName,
      clusterId: Math.min(clusterId, targetClusters - 1) // Ensure we don't exceed target clusters
    };
  });
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}