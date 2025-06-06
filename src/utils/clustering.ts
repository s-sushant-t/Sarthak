import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    const TARGET_MIN_SIZE = 180; // Enforced minimum
    const TARGET_MAX_SIZE = 210;

    console.log(`Starting clustering for ${customers.length} customers with minimum ${TARGET_MIN_SIZE} outlets per cluster`);

    // Step 1: Compute median coordinates as central reference point
    const { medianLat, medianLng } = computeMedianCoordinates(customers);
    console.log(`Central reference point: (${medianLat.toFixed(6)}, ${medianLng.toFixed(6)})`);

    // Step 2: Analyze spatial distribution to determine partitioning strategy
    const spatialAnalysis = analyzeSpatialDistribution(customers, medianLat, medianLng, TARGET_MIN_SIZE);
    console.log('Spatial analysis:', spatialAnalysis);

    // Step 3: Create non-overlapping spatial partitions
    const partitions = createNonOverlappingSpatialPartitions(customers, medianLat, medianLng, spatialAnalysis);
    console.log(`Created ${partitions.length} non-overlapping spatial partitions`);

    // Step 4: Apply DBSCAN within each partition with strict size enforcement
    const clusteredCustomers = await clusterWithinPartitionsStrict(partitions, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    // Step 5: Enforce minimum cluster size constraint
    const finalClusters = enforceMinimumClusterSize(clusteredCustomers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    // Step 6: Validate non-overlapping nature
    validateNonOverlapping(finalClusters);

    // Step 7: Critical validation - ensure no customers are lost
    if (finalClusters.length !== customers.length) {
      console.error(`CRITICAL: Clustering lost customers! Input: ${customers.length}, Output: ${finalClusters.length}`);
      
      // Find missing customers
      const inputIds = new Set(customers.map(c => c.id));
      const outputIds = new Set(finalClusters.map(c => c.id));
      const missingIds = Array.from(inputIds).filter(id => !outputIds.has(id));
      
      if (missingIds.length > 0) {
        console.error('Missing customers after clustering:', missingIds);
      }
      
      // Fallback to strict size-based clustering to preserve all customers
      return strictFallbackClustering(customers, TARGET_MIN_SIZE);
    }

    const clusterCount = new Set(finalClusters.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(finalClusters);
    
    console.log(`Final clustering result: ${clusterCount} clusters`);
    console.log('Cluster sizes:', clusterSizes);
    console.log('All clusters meet minimum size requirement:', clusterSizes.every(size => size >= TARGET_MIN_SIZE));

    return finalClusters;

  } catch (error) {
    console.error('Enhanced clustering error:', error);
    // Fallback to strict size-based clustering
    return strictFallbackClustering(customers, 180);
  }
};

interface SpatialAnalysis {
  spread: number;
  density: number;
  aspectRatio: number;
  outlierThreshold: number;
  recommendedPartitions: number;
  partitioningStrategy: 'radial' | 'grid' | 'adaptive';
  minPartitionSize: number;
}

interface SpatialPartition {
  id: number;
  customers: Customer[];
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  center: {
    lat: number;
    lng: number;
  };
  isLocked: boolean; // Prevents overlap
}

function computeMedianCoordinates(customers: Customer[]): { medianLat: number; medianLng: number } {
  const sortedByLat = [...customers].sort((a, b) => a.latitude - b.latitude);
  const sortedByLng = [...customers].sort((a, b) => a.longitude - b.longitude);
  
  const medianLat = getMedian(sortedByLat.map(c => c.latitude));
  const medianLng = getMedian(sortedByLng.map(c => c.longitude));
  
  return { medianLat, medianLng };
}

function getMedian(values: number[]): number {
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 
    ? (values[mid - 1] + values[mid]) / 2 
    : values[mid];
}

function analyzeSpatialDistribution(
  customers: Customer[], 
  medianLat: number, 
  medianLng: number,
  minClusterSize: number
): SpatialAnalysis {
  // Calculate distances from median point
  const distances = customers.map(customer => 
    calculateDistance(medianLat, medianLng, customer.latitude, customer.longitude)
  );
  
  // Calculate spatial spread
  const maxDistance = Math.max(...distances);
  const avgDistance = distances.reduce((sum, d) => sum + d, 0) / distances.length;
  const spread = maxDistance;
  
  // Calculate density (customers per square km)
  const area = Math.PI * Math.pow(maxDistance, 2);
  const density = customers.length / area;
  
  // Calculate aspect ratio (elongation of distribution)
  const latRange = Math.max(...customers.map(c => c.latitude)) - Math.min(...customers.map(c => c.latitude));
  const lngRange = Math.max(...customers.map(c => c.longitude)) - Math.min(...customers.map(c => c.longitude));
  const aspectRatio = Math.max(latRange, lngRange) / Math.min(latRange, lngRange);
  
  // Determine outlier threshold (95th percentile of distances)
  const sortedDistances = [...distances].sort((a, b) => a - b);
  const outlierThreshold = sortedDistances[Math.floor(sortedDistances.length * 0.95)];
  
  // Calculate maximum possible clusters based on minimum size constraint
  const maxPossibleClusters = Math.floor(customers.length / minClusterSize);
  
  // Recommend number of partitions ensuring each can meet minimum size
  let recommendedPartitions: number;
  let partitioningStrategy: 'radial' | 'grid' | 'adaptive';
  
  if (customers.length < minClusterSize * 2) {
    // Too few customers for multiple clusters
    recommendedPartitions = 1;
    partitioningStrategy = 'adaptive';
  } else if (aspectRatio > 2.5) {
    // Elongated distribution - use grid approach
    const gridSize = Math.ceil(Math.sqrt(maxPossibleClusters));
    recommendedPartitions = Math.min(gridSize * gridSize, maxPossibleClusters);
    partitioningStrategy = 'grid';
  } else if (density > 15) {
    // High density - use radial sectors
    recommendedPartitions = Math.min(8, maxPossibleClusters);
    partitioningStrategy = 'radial';
  } else {
    // Adaptive approach for complex distributions
    recommendedPartitions = Math.min(6, maxPossibleClusters);
    partitioningStrategy = 'adaptive';
  }
  
  // Ensure we don't create too many partitions
  recommendedPartitions = Math.max(1, Math.min(recommendedPartitions, maxPossibleClusters));
  
  return {
    spread,
    density,
    aspectRatio,
    outlierThreshold,
    recommendedPartitions,
    partitioningStrategy,
    minPartitionSize: minClusterSize
  };
}

function createNonOverlappingSpatialPartitions(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  analysis: SpatialAnalysis
): SpatialPartition[] {
  // Ensure partitions are non-overlapping by using strict boundaries
  switch (analysis.partitioningStrategy) {
    case 'radial':
      return createNonOverlappingRadialPartitions(customers, medianLat, medianLng, analysis);
    case 'grid':
      return createNonOverlappingGridPartitions(customers, medianLat, medianLng, analysis);
    case 'adaptive':
      return createNonOverlappingAdaptivePartitions(customers, medianLat, medianLng, analysis);
    default:
      return createNonOverlappingRadialPartitions(customers, medianLat, medianLng, analysis);
  }
}

function createNonOverlappingRadialPartitions(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  analysis: SpatialAnalysis
): SpatialPartition[] {
  const partitions: SpatialPartition[] = [];
  const sectorCount = analysis.recommendedPartitions;
  const sectorAngle = (2 * Math.PI) / sectorCount;
  
  // Create non-overlapping radial sectors
  for (let i = 0; i < sectorCount; i++) {
    const startAngle = i * sectorAngle;
    const endAngle = (i + 1) * sectorAngle;
    
    const sectorCustomers = customers.filter(customer => {
      const angle = Math.atan2(
        customer.latitude - medianLat,
        customer.longitude - medianLng
      );
      const normalizedAngle = angle < 0 ? angle + 2 * Math.PI : angle;
      
      // Strict boundary check - no overlap
      return normalizedAngle >= startAngle && normalizedAngle < endAngle;
    });
    
    if (sectorCustomers.length >= analysis.minPartitionSize) {
      partitions.push(createPartition(i, sectorCustomers, true));
    }
  }
  
  // Handle customers not assigned to any partition
  const assignedCustomers = new Set(partitions.flatMap(p => p.customers.map(c => c.id)));
  const unassignedCustomers = customers.filter(c => !assignedCustomers.has(c.id));
  
  if (unassignedCustomers.length > 0) {
    // Assign to nearest partition or create new one if large enough
    if (unassignedCustomers.length >= analysis.minPartitionSize) {
      partitions.push(createPartition(partitions.length, unassignedCustomers, true));
    } else {
      // Distribute to existing partitions
      distributeToNearestPartitions(unassignedCustomers, partitions);
    }
  }
  
  return partitions;
}

function createNonOverlappingGridPartitions(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  analysis: SpatialAnalysis
): SpatialPartition[] {
  const partitions: SpatialPartition[] = [];
  const gridSize = Math.ceil(Math.sqrt(analysis.recommendedPartitions));
  
  // Calculate bounds
  const minLat = Math.min(...customers.map(c => c.latitude));
  const maxLat = Math.max(...customers.map(c => c.latitude));
  const minLng = Math.min(...customers.map(c => c.longitude));
  const maxLng = Math.max(...customers.map(c => c.longitude));
  
  const latStep = (maxLat - minLat) / gridSize;
  const lngStep = (maxLng - minLng) / gridSize;
  
  let partitionId = 0;
  
  // Create non-overlapping grid cells
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const cellMinLat = minLat + i * latStep;
      const cellMaxLat = minLat + (i + 1) * latStep;
      const cellMinLng = minLng + j * lngStep;
      const cellMaxLng = minLng + (j + 1) * lngStep;
      
      const cellCustomers = customers.filter(customer =>
        customer.latitude >= cellMinLat &&
        customer.latitude < cellMaxLat &&
        customer.longitude >= cellMinLng &&
        customer.longitude < cellMaxLng
      );
      
      if (cellCustomers.length >= analysis.minPartitionSize) {
        partitions.push(createPartition(partitionId++, cellCustomers, true));
      }
    }
  }
  
  // Handle small cells by merging with adjacent cells
  const assignedCustomers = new Set(partitions.flatMap(p => p.customers.map(c => c.id)));
  const unassignedCustomers = customers.filter(c => !assignedCustomers.has(c.id));
  
  if (unassignedCustomers.length > 0) {
    if (unassignedCustomers.length >= analysis.minPartitionSize) {
      partitions.push(createPartition(partitionId, unassignedCustomers, true));
    } else {
      distributeToNearestPartitions(unassignedCustomers, partitions);
    }
  }
  
  return partitions;
}

function createNonOverlappingAdaptivePartitions(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  analysis: SpatialAnalysis
): SpatialPartition[] {
  // Use modified k-means with minimum size constraints
  const k = analysis.recommendedPartitions;
  const maxIterations = 15;
  const minPartitionSize = analysis.minPartitionSize;
  
  // Initialize centroids using k-means++
  let centroids = initializeRandomCentroids(customers, k);
  
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Assign customers to nearest centroid
    const assignments = customers.map(customer => {
      let nearestCentroid = 0;
      let minDistance = Infinity;
      
      centroids.forEach((centroid, index) => {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          centroid.lat, centroid.lng
        );
        if (distance < minDistance) {
          minDistance = distance;
          nearestCentroid = index;
        }
      });
      
      return nearestCentroid;
    });
    
    // Check partition sizes and redistribute if necessary
    const partitionSizes = new Array(k).fill(0);
    assignments.forEach(assignment => partitionSizes[assignment]++);
    
    // Redistribute customers from oversized partitions to undersized ones
    const redistributedAssignments = redistributeForMinimumSize(
      customers, assignments, partitionSizes, minPartitionSize
    );
    
    // Update centroids based on redistributed assignments
    const newCentroids = centroids.map((_, index) => {
      const assignedCustomers = customers.filter((_, i) => redistributedAssignments[i] === index);
      if (assignedCustomers.length === 0) return centroids[index];
      
      const avgLat = assignedCustomers.reduce((sum, c) => sum + c.latitude, 0) / assignedCustomers.length;
      const avgLng = assignedCustomers.reduce((sum, c) => sum + c.longitude, 0) / assignedCustomers.length;
      
      return { lat: avgLat, lng: avgLng };
    });
    
    // Check for convergence
    const converged = centroids.every((centroid, index) => {
      const distance = calculateDistance(
        centroid.lat, centroid.lng,
        newCentroids[index].lat, newCentroids[index].lng
      );
      return distance < 0.001; // 1 meter threshold
    });
    
    centroids = newCentroids;
    
    if (converged) break;
  }
  
  // Create final partitions with strict non-overlap
  const finalAssignments = customers.map(customer => {
    let nearestCentroid = 0;
    let minDistance = Infinity;
    
    centroids.forEach((centroid, index) => {
      const distance = calculateDistance(
        customer.latitude, customer.longitude,
        centroid.lat, centroid.lng
      );
      if (distance < minDistance) {
        minDistance = distance;
        nearestCentroid = index;
      }
    });
    
    return nearestCentroid;
  });
  
  const partitions: SpatialPartition[] = [];
  
  centroids.forEach((centroid, index) => {
    const partitionCustomers = customers.filter((_, i) => finalAssignments[i] === index);
    
    if (partitionCustomers.length >= minPartitionSize) {
      partitions.push(createPartition(index, partitionCustomers, true));
    }
  });
  
  return partitions;
}

function redistributeForMinimumSize(
  customers: Customer[],
  assignments: number[],
  partitionSizes: number[],
  minPartitionSize: number
): number[] {
  const redistributed = [...assignments];
  
  // Find undersized and oversized partitions
  const undersized = partitionSizes
    .map((size, index) => ({ index, size, deficit: minPartitionSize - size }))
    .filter(p => p.deficit > 0);
  
  const oversized = partitionSizes
    .map((size, index) => ({ index, size, surplus: size - minPartitionSize }))
    .filter(p => p.surplus > 0);
  
  // Redistribute from oversized to undersized
  for (const under of undersized) {
    let needed = under.deficit;
    
    for (const over of oversized) {
      if (needed <= 0 || over.surplus <= 0) continue;
      
      // Find customers in oversized partition closest to undersized partition centroid
      const oversizedCustomers = customers
        .map((customer, index) => ({ customer, index }))
        .filter(({ index }) => redistributed[index] === over.index);
      
      const undersizedCustomers = customers
        .filter((_, index) => redistributed[index] === under.index);
      
      if (undersizedCustomers.length === 0) continue;
      
      const underCentroid = calculateCentroid(undersizedCustomers);
      
      // Sort by distance to undersized centroid
      oversizedCustomers.sort((a, b) => {
        const distA = calculateDistance(
          a.customer.latitude, a.customer.longitude,
          underCentroid.lat, underCentroid.lng
        );
        const distB = calculateDistance(
          b.customer.latitude, b.customer.longitude,
          underCentroid.lat, underCentroid.lng
        );
        return distA - distB;
      });
      
      // Transfer closest customers
      const toTransfer = Math.min(needed, over.surplus);
      for (let i = 0; i < toTransfer; i++) {
        redistributed[oversizedCustomers[i].index] = under.index;
        needed--;
        over.surplus--;
      }
    }
  }
  
  return redistributed;
}

function calculateCentroid(customers: Customer[]): { lat: number; lng: number } {
  const avgLat = customers.reduce((sum, c) => sum + c.latitude, 0) / customers.length;
  const avgLng = customers.reduce((sum, c) => sum + c.longitude, 0) / customers.length;
  return { lat: avgLat, lng: avgLng };
}

function distributeToNearestPartitions(unassignedCustomers: Customer[], partitions: SpatialPartition[]): void {
  unassignedCustomers.forEach(customer => {
    let nearestPartition = partitions[0];
    let minDistance = Infinity;
    
    partitions.forEach(partition => {
      const distance = calculateDistance(
        customer.latitude, customer.longitude,
        partition.center.lat, partition.center.lng
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestPartition = partition;
      }
    });
    
    nearestPartition.customers.push(customer);
    // Update partition bounds and center
    updatePartitionBounds(nearestPartition);
  });
}

function updatePartitionBounds(partition: SpatialPartition): void {
  const lats = partition.customers.map(c => c.latitude);
  const lngs = partition.customers.map(c => c.longitude);
  
  partition.bounds = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs)
  };
  
  partition.center = {
    lat: lats.reduce((sum, lat) => sum + lat, 0) / lats.length,
    lng: lngs.reduce((sum, lng) => sum + lng, 0) / lngs.length
  };
}

function initializeRandomCentroids(customers: Customer[], k: number): { lat: number; lng: number }[] {
  const centroids: { lat: number; lng: number }[] = [];
  
  // Use k-means++ initialization for better initial placement
  const firstCustomer = customers[Math.floor(Math.random() * customers.length)];
  centroids.push({ lat: firstCustomer.latitude, lng: firstCustomer.longitude });
  
  for (let i = 1; i < k; i++) {
    const distances = customers.map(customer => {
      let minDistance = Infinity;
      centroids.forEach(centroid => {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          centroid.lat, centroid.lng
        );
        minDistance = Math.min(minDistance, distance);
      });
      return minDistance;
    });
    
    const totalDistance = distances.reduce((sum, d) => sum + d * d, 0);
    const random = Math.random() * totalDistance;
    
    let cumulativeDistance = 0;
    for (let j = 0; j < customers.length; j++) {
      cumulativeDistance += distances[j] * distances[j];
      if (cumulativeDistance >= random) {
        centroids.push({ lat: customers[j].latitude, lng: customers[j].longitude });
        break;
      }
    }
  }
  
  return centroids;
}

function createPartition(id: number, customers: Customer[], isLocked: boolean = false): SpatialPartition {
  const lats = customers.map(c => c.latitude);
  const lngs = customers.map(c => c.longitude);
  
  return {
    id,
    customers,
    bounds: {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs)
    },
    center: {
      lat: lats.reduce((sum, lat) => sum + lat, 0) / lats.length,
      lng: lngs.reduce((sum, lng) => sum + lng, 0) / lngs.length
    },
    isLocked
  };
}

async function clusterWithinPartitionsStrict(
  partitions: SpatialPartition[],
  targetMinSize: number,
  targetMaxSize: number
): Promise<ClusteredCustomer[]> {
  const clusteredCustomers: ClusteredCustomer[] = [];
  let globalClusterId = 0;
  
  for (const partition of partitions) {
    console.log(`Processing partition ${partition.id} with ${partition.customers.length} customers`);
    
    if (partition.customers.length >= targetMinSize && partition.customers.length <= targetMaxSize) {
      // Partition is already optimal size - treat as single cluster
      partition.customers.forEach(customer => {
        clusteredCustomers.push({
          ...customer,
          clusterId: globalClusterId
        });
      });
      globalClusterId++;
    } else if (partition.customers.length < targetMinSize) {
      // Partition too small - this should be handled in partition creation
      console.warn(`Partition ${partition.id} has only ${partition.customers.length} customers (< ${targetMinSize})`);
      partition.customers.forEach(customer => {
        clusteredCustomers.push({
          ...customer,
          clusterId: globalClusterId
        });
      });
      globalClusterId++;
    } else {
      // Large partition - split into multiple clusters
      const partitionClusters = await splitPartitionIntoValidClusters(partition, targetMinSize, targetMaxSize);
      
      partitionClusters.forEach(cluster => {
        cluster.forEach(customer => {
          clusteredCustomers.push({
            ...customer,
            clusterId: globalClusterId
          });
        });
        globalClusterId++;
      });
    }
    
    // Yield to prevent blocking
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  return clusteredCustomers;
}

async function splitPartitionIntoValidClusters(
  partition: SpatialPartition,
  targetMinSize: number,
  targetMaxSize: number
): Promise<Customer[][]> {
  const customers = partition.customers;
  
  // Calculate optimal number of clusters
  const optimalClusterCount = Math.ceil(customers.length / targetMaxSize);
  const customersPerCluster = Math.ceil(customers.length / optimalClusterCount);
  
  // Ensure each cluster meets minimum size
  if (customersPerCluster < targetMinSize) {
    // Reduce cluster count to meet minimum size requirement
    const adjustedClusterCount = Math.floor(customers.length / targetMinSize);
    if (adjustedClusterCount === 0) {
      // Return as single cluster if we can't meet minimum
      return [customers];
    }
    
    const adjustedCustomersPerCluster = Math.ceil(customers.length / adjustedClusterCount);
    return createEvenClusters(customers, adjustedClusterCount, adjustedCustomersPerCluster);
  }
  
  // Try DBSCAN first
  try {
    const dbscanClusters = await applyDBSCANToPartitionStrict(partition, targetMinSize, targetMaxSize);
    
    // Critical fix: Ensure ALL customers are accounted for
    const totalCustomersInClusters = dbscanClusters.reduce((sum, cluster) => sum + cluster.length, 0);
    
    if (dbscanClusters.length > 0 && 
        dbscanClusters.every(cluster => cluster.length >= targetMinSize) &&
        totalCustomersInClusters === customers.length) { // This is the key fix
      return dbscanClusters;
    }
    
    console.warn(`DBSCAN failed validation: clusters=${dbscanClusters.length}, total customers in clusters=${totalCustomersInClusters}, original=${customers.length}`);
  } catch (error) {
    console.warn('DBSCAN failed, falling back to even split');
  }
  
  // Fallback to even split which guarantees all customers are included
  return createEvenClusters(customers, optimalClusterCount, customersPerCluster);
}

function createEvenClusters(customers: Customer[], clusterCount: number, customersPerCluster: number): Customer[][] {
  const clusters: Customer[][] = [];
  
  // Sort customers geographically for better coherence
  const sortedCustomers = [...customers].sort((a, b) => {
    // Sort by latitude first, then longitude
    if (Math.abs(a.latitude - b.latitude) > 0.001) {
      return a.latitude - b.latitude;
    }
    return a.longitude - b.longitude;
  });
  
  for (let i = 0; i < clusterCount; i++) {
    const start = i * customersPerCluster;
    const end = Math.min(start + customersPerCluster, sortedCustomers.length);
    
    if (start < sortedCustomers.length) {
      clusters.push(sortedCustomers.slice(start, end));
    }
  }
  
  return clusters;
}

async function applyDBSCANToPartitionStrict(
  partition: SpatialPartition,
  targetMinSize: number,
  targetMaxSize: number
): Promise<Customer[][]> {
  const customers = partition.customers;
  let maxDistance = 1.5; // Start with 1.5km radius
  let attempts = 0;
  const MAX_ATTEMPTS = 3;
  
  while (attempts < MAX_ATTEMPTS) {
    // Convert to GeoJSON points
    const points = customers.map(customer => 
      point([customer.longitude, customer.latitude], { 
        customerId: customer.id 
      })
    );
    
    const pointCollection = featureCollection(points);
    
    // Apply DBSCAN
    const clustered = clustersDbscan(pointCollection, maxDistance, {
      minPoints: Math.max(5, Math.floor(targetMinSize * 0.1)),
      units: 'kilometers'
    });
    
    // Group by cluster
    const clusterMap = new Map<number, Customer[]>();
    
    clustered.features.forEach((feature, index) => {
      const clusterNum = feature.properties?.cluster ?? -1;
      if (!clusterMap.has(clusterNum)) {
        clusterMap.set(clusterNum, []);
      }
      clusterMap.get(clusterNum)!.push(customers[index]);
    });
    
    // Filter valid clusters (excluding noise cluster -1)
    const validClusters = Array.from(clusterMap.entries())
      .filter(([clusterId, cluster]) => clusterId !== -1 && cluster.length >= targetMinSize && cluster.length <= targetMaxSize)
      .map(([_, cluster]) => cluster);
    
    // Check if we've assigned ALL customers to valid clusters
    const assignedCount = validClusters.reduce((sum, cluster) => sum + cluster.length, 0);
    
    if (validClusters.length > 0 && assignedCount === customers.length) {
      return validClusters;
    }
    
    // Adjust parameters
    maxDistance *= 1.3;
    attempts++;
  }
  
  throw new Error('DBSCAN failed to create valid clusters that include all customers');
}

function enforceMinimumClusterSize(
  customers: ClusteredCustomer[],
  targetMinSize: number,
  targetMaxSize: number
): ClusteredCustomer[] {
  const clusterMap = new Map<number, ClusteredCustomer[]>();
  
  // Group by cluster ID
  customers.forEach(customer => {
    if (!clusterMap.has(customer.clusterId)) {
      clusterMap.set(customer.clusterId, []);
    }
    clusterMap.get(customer.clusterId)!.push(customer);
  });
  
  const optimizedCustomers: ClusteredCustomer[] = [];
  let nextClusterId = 0;
  
  const clusters = Array.from(clusterMap.values());
  const smallClusters: ClusteredCustomer[][] = [];
  
  // Process clusters
  clusters.forEach(cluster => {
    if (cluster.length >= targetMinSize && cluster.length <= targetMaxSize) {
      // Cluster meets requirements
      cluster.forEach(customer => {
        optimizedCustomers.push({
          ...customer,
          clusterId: nextClusterId
        });
      });
      nextClusterId++;
    } else if (cluster.length < targetMinSize) {
      // Store small clusters for merging
      smallClusters.push(cluster);
    } else {
      // Split large cluster
      const subClusters = splitLargeCluster(cluster, targetMinSize, targetMaxSize);
      subClusters.forEach(subCluster => {
        subCluster.forEach(customer => {
          optimizedCustomers.push({
            ...customer,
            clusterId: nextClusterId
          });
        });
        nextClusterId++;
      });
    }
  });
  
  // Merge small clusters
  const mergedClusters = mergeSmallClusters(smallClusters, targetMinSize, targetMaxSize);
  mergedClusters.forEach(mergedCluster => {
    mergedCluster.forEach(customer => {
      optimizedCustomers.push({
        ...customer,
        clusterId: nextClusterId
      });
    });
    nextClusterId++;
  });
  
  return optimizedCustomers;
}

function splitLargeCluster(
  cluster: ClusteredCustomer[],
  targetMinSize: number,
  targetMaxSize: number
): ClusteredCustomer[][] {
  const subClusterCount = Math.ceil(cluster.length / targetMaxSize);
  const customersPerSubCluster = Math.ceil(cluster.length / subClusterCount);
  
  // Ensure each sub-cluster meets minimum size
  const adjustedSubClusterCount = Math.max(1, Math.floor(cluster.length / targetMinSize));
  const adjustedCustomersPerSubCluster = Math.ceil(cluster.length / adjustedSubClusterCount);
  
  const subClusters: ClusteredCustomer[][] = [];
  
  // Sort customers geographically within cluster
  const sortedCluster = [...cluster].sort((a, b) => {
    if (Math.abs(a.latitude - b.latitude) > 0.001) {
      return a.latitude - b.latitude;
    }
    return a.longitude - b.longitude;
  });
  
  for (let i = 0; i < adjustedSubClusterCount; i++) {
    const start = i * adjustedCustomersPerSubCluster;
    const end = Math.min(start + adjustedCustomersPerSubCluster, sortedCluster.length);
    
    if (start < sortedCluster.length) {
      subClusters.push(sortedCluster.slice(start, end));
    }
  }
  
  return subClusters;
}

function mergeSmallClusters(
  smallClusters: ClusteredCustomer[][],
  targetMinSize: number,
  targetMaxSize: number
): ClusteredCustomer[][] {
  if (smallClusters.length === 0) return [];
  
  const mergedClusters: ClusteredCustomer[][] = [];
  let currentMerge: ClusteredCustomer[] = [];
  
  // Sort small clusters by geographic proximity
  const sortedSmallClusters = [...smallClusters].sort((a, b) => {
    const centroidA = calculateClusterCentroid(a);
    const centroidB = calculateClusterCentroid(b);
    return centroidA.lat - centroidB.lat;
  });
  
  for (const cluster of sortedSmallClusters) {
    if (currentMerge.length + cluster.length <= targetMaxSize) {
      currentMerge.push(...cluster);
    } else {
      if (currentMerge.length >= targetMinSize) {
        mergedClusters.push(currentMerge);
      }
      currentMerge = [...cluster];
    }
  }
  
  // Handle remaining merge
  if (currentMerge.length > 0) {
    if (currentMerge.length >= targetMinSize) {
      mergedClusters.push(currentMerge);
    } else if (mergedClusters.length > 0) {
      // Add to last cluster if it doesn't exceed max size
      const lastCluster = mergedClusters[mergedClusters.length - 1];
      if (lastCluster.length + currentMerge.length <= targetMaxSize) {
        lastCluster.push(...currentMerge);
      } else {
        mergedClusters.push(currentMerge);
      }
    } else {
      mergedClusters.push(currentMerge);
    }
  }
  
  return mergedClusters;
}

function calculateClusterCentroid(cluster: ClusteredCustomer[]): { lat: number; lng: number } {
  const avgLat = cluster.reduce((sum, c) => sum + c.latitude, 0) / cluster.length;
  const avgLng = cluster.reduce((sum, c) => sum + c.longitude, 0) / cluster.length;
  return { lat: avgLat, lng: avgLng };
}

function validateNonOverlapping(customers: ClusteredCustomer[]): void {
  const clusterMap = new Map<number, ClusteredCustomer[]>();
  
  customers.forEach(customer => {
    if (!clusterMap.has(customer.clusterId)) {
      clusterMap.set(customer.clusterId, []);
    }
    clusterMap.get(customer.clusterId)!.push(customer);
  });
  
  // Check that each customer belongs to exactly one cluster
  const customerIds = new Set(customers.map(c => c.id));
  const assignedIds = new Set();
  
  clusterMap.forEach(cluster => {
    cluster.forEach(customer => {
      if (assignedIds.has(customer.id)) {
        console.error(`Customer ${customer.id} assigned to multiple clusters!`);
      }
      assignedIds.add(customer.id);
    });
  });
  
  if (customerIds.size !== assignedIds.size) {
    console.error('Mismatch in customer assignments!');
  }
  
  console.log('✅ Non-overlapping validation passed');
}

function getClusterSizes(customers: ClusteredCustomer[]): number[] {
  const clusterMap = new Map<number, number>();
  
  customers.forEach(customer => {
    clusterMap.set(customer.clusterId, (clusterMap.get(customer.clusterId) || 0) + 1);
  });
  
  return Array.from(clusterMap.values()).sort((a, b) => a - b);
}

function strictFallbackClustering(customers: Customer[], minSize: number): ClusteredCustomer[] {
  const maxClusters = Math.floor(customers.length / minSize);
  const customersPerCluster = Math.ceil(customers.length / maxClusters);
  
  // Sort by latitude for geographic coherence
  const sortedCustomers = [...customers].sort((a, b) => a.latitude - b.latitude);
  
  return sortedCustomers.map((customer, index) => ({
    ...customer,
    clusterId: Math.floor(index / customersPerCluster)
  }));
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