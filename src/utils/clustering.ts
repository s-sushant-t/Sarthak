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

    const TARGET_MIN_SIZE = 180;
    const TARGET_MAX_SIZE = 210;

    // Step 1: Compute median coordinates as central reference point
    const { medianLat, medianLng } = computeMedianCoordinates(customers);
    console.log(`Central reference point: (${medianLat.toFixed(6)}, ${medianLng.toFixed(6)})`);

    // Step 2: Analyze spatial distribution to determine partitioning strategy
    const spatialAnalysis = analyzeSpatialDistribution(customers, medianLat, medianLng);
    console.log('Spatial analysis:', spatialAnalysis);

    // Step 3: Create spatial partitions based on analysis
    const partitions = createSpatialPartitions(customers, medianLat, medianLng, spatialAnalysis);
    console.log(`Created ${partitions.length} spatial partitions`);

    // Step 4: Apply DBSCAN within each partition
    const clusteredCustomers = await clusterWithinPartitions(partitions, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    // Step 5: Validate and optimize cluster sizes
    const optimizedClusters = optimizeClusterSizes(clusteredCustomers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    console.log(`Final clustering result: ${new Set(optimizedClusters.map(c => c.clusterId)).size} clusters`);
    return optimizedClusters;

  } catch (error) {
    console.error('Enhanced clustering error:', error);
    // Fallback to simple geographic clustering
    return fallbackClustering(customers);
  }
};

interface SpatialAnalysis {
  spread: number;
  density: number;
  aspectRatio: number;
  outlierThreshold: number;
  recommendedPartitions: number;
  partitioningStrategy: 'radial' | 'grid' | 'adaptive';
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
  medianLng: number
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
  
  // Recommend number of partitions based on customer count and density
  let recommendedPartitions: number;
  let partitioningStrategy: 'radial' | 'grid' | 'adaptive';
  
  if (customers.length < 500) {
    recommendedPartitions = 4; // Simple quadrant division
    partitioningStrategy = 'radial';
  } else if (aspectRatio > 2.0) {
    // Elongated distribution - use grid approach
    recommendedPartitions = Math.ceil(Math.sqrt(customers.length / 150));
    partitioningStrategy = 'grid';
  } else if (density > 10) {
    // High density - use radial sectors
    recommendedPartitions = Math.ceil(customers.length / 200);
    partitioningStrategy = 'radial';
  } else {
    // Adaptive approach for complex distributions
    recommendedPartitions = Math.max(4, Math.ceil(customers.length / 180));
    partitioningStrategy = 'adaptive';
  }
  
  // Ensure reasonable partition count
  recommendedPartitions = Math.min(Math.max(recommendedPartitions, 4), 12);
  
  return {
    spread,
    density,
    aspectRatio,
    outlierThreshold,
    recommendedPartitions,
    partitioningStrategy
  };
}

function createSpatialPartitions(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  analysis: SpatialAnalysis
): SpatialPartition[] {
  switch (analysis.partitioningStrategy) {
    case 'radial':
      return createRadialPartitions(customers, medianLat, medianLng, analysis);
    case 'grid':
      return createGridPartitions(customers, medianLat, medianLng, analysis);
    case 'adaptive':
      return createAdaptivePartitions(customers, medianLat, medianLng, analysis);
    default:
      return createRadialPartitions(customers, medianLat, medianLng, analysis);
  }
}

function createRadialPartitions(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  analysis: SpatialAnalysis
): SpatialPartition[] {
  const partitions: SpatialPartition[] = [];
  const sectorCount = analysis.recommendedPartitions;
  const sectorAngle = (2 * Math.PI) / sectorCount;
  
  // Create radial sectors around the median point
  for (let i = 0; i < sectorCount; i++) {
    const startAngle = i * sectorAngle;
    const endAngle = (i + 1) * sectorAngle;
    
    const sectorCustomers = customers.filter(customer => {
      const angle = Math.atan2(
        customer.latitude - medianLat,
        customer.longitude - medianLng
      );
      const normalizedAngle = angle < 0 ? angle + 2 * Math.PI : angle;
      
      return normalizedAngle >= startAngle && normalizedAngle < endAngle;
    });
    
    if (sectorCustomers.length > 0) {
      partitions.push(createPartition(i, sectorCustomers));
    }
  }
  
  return partitions;
}

function createGridPartitions(
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
      
      if (cellCustomers.length > 0) {
        partitions.push(createPartition(partitionId++, cellCustomers));
      }
    }
  }
  
  return partitions;
}

function createAdaptivePartitions(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  analysis: SpatialAnalysis
): SpatialPartition[] {
  // Use k-means-like approach to create adaptive partitions
  const k = analysis.recommendedPartitions;
  const maxIterations = 10;
  
  // Initialize centroids randomly
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
    
    // Update centroids
    const newCentroids = centroids.map((_, index) => {
      const assignedCustomers = customers.filter((_, i) => assignments[i] === index);
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
  
  // Create partitions based on final assignments
  const partitions: SpatialPartition[] = [];
  
  centroids.forEach((centroid, index) => {
    const partitionCustomers = customers.filter((customer, i) => {
      let nearestCentroid = 0;
      let minDistance = Infinity;
      
      centroids.forEach((c, j) => {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          c.lat, c.lng
        );
        if (distance < minDistance) {
          minDistance = distance;
          nearestCentroid = j;
        }
      });
      
      return nearestCentroid === index;
    });
    
    if (partitionCustomers.length > 0) {
      partitions.push(createPartition(index, partitionCustomers));
    }
  });
  
  return partitions;
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

function createPartition(id: number, customers: Customer[]): SpatialPartition {
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
    }
  };
}

async function clusterWithinPartitions(
  partitions: SpatialPartition[],
  targetMinSize: number,
  targetMaxSize: number
): Promise<ClusteredCustomer[]> {
  const clusteredCustomers: ClusteredCustomer[] = [];
  let globalClusterId = 0;
  
  for (const partition of partitions) {
    console.log(`Processing partition ${partition.id} with ${partition.customers.length} customers`);
    
    if (partition.customers.length <= targetMaxSize) {
      // Small partition - treat as single cluster
      partition.customers.forEach(customer => {
        clusteredCustomers.push({
          ...customer,
          clusterId: globalClusterId
        });
      });
      globalClusterId++;
    } else {
      // Large partition - apply DBSCAN
      const partitionClusters = await applyDBSCANToPartition(partition, targetMinSize, targetMaxSize);
      
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

async function applyDBSCANToPartition(
  partition: SpatialPartition,
  targetMinSize: number,
  targetMaxSize: number
): Promise<Customer[][]> {
  const customers = partition.customers;
  let maxDistance = 2; // Start with 2km radius
  let attempts = 0;
  const MAX_ATTEMPTS = 5;
  
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
      minPoints: Math.floor(targetMinSize * 0.1),
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
    
    // Check if clusters meet size requirements
    const clusters = Array.from(clusterMap.values());
    const validClusters = clusters.filter(cluster => 
      cluster.length >= targetMinSize && cluster.length <= targetMaxSize
    );
    
    if (validClusters.length > 0 && validClusters.length === clusters.length) {
      return validClusters;
    }
    
    // Adjust parameters
    const avgClusterSize = clusters.reduce((sum, c) => sum + c.length, 0) / clusters.length;
    if (avgClusterSize < targetMinSize) {
      maxDistance *= 1.5;
    } else {
      maxDistance *= 0.75;
    }
    
    attempts++;
  }
  
  // Fallback: create evenly sized clusters
  const clusterCount = Math.ceil(customers.length / targetMaxSize);
  const clusters: Customer[][] = [];
  
  for (let i = 0; i < clusterCount; i++) {
    const start = i * Math.ceil(customers.length / clusterCount);
    const end = Math.min(start + Math.ceil(customers.length / clusterCount), customers.length);
    clusters.push(customers.slice(start, end));
  }
  
  return clusters;
}

function optimizeClusterSizes(
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
  
  Array.from(clusterMap.values()).forEach(cluster => {
    if (cluster.length >= targetMinSize && cluster.length <= targetMaxSize) {
      // Cluster is already optimal
      cluster.forEach(customer => {
        optimizedCustomers.push({
          ...customer,
          clusterId: nextClusterId
        });
      });
      nextClusterId++;
    } else if (cluster.length < targetMinSize) {
      // Try to merge with nearby small clusters or distribute to nearby clusters
      cluster.forEach(customer => {
        optimizedCustomers.push({
          ...customer,
          clusterId: nextClusterId
        });
      });
      nextClusterId++;
    } else {
      // Split large cluster
      const subClusterCount = Math.ceil(cluster.length / targetMaxSize);
      const customersPerSubCluster = Math.ceil(cluster.length / subClusterCount);
      
      for (let i = 0; i < subClusterCount; i++) {
        const start = i * customersPerSubCluster;
        const end = Math.min(start + customersPerSubCluster, cluster.length);
        
        cluster.slice(start, end).forEach(customer => {
          optimizedCustomers.push({
            ...customer,
            clusterId: nextClusterId
          });
        });
        nextClusterId++;
      }
    }
  });
  
  return optimizedCustomers;
}

function fallbackClustering(customers: Customer[]): ClusteredCustomer[] {
  const TARGET_MAX_SIZE = 210;
  const numClusters = Math.ceil(customers.length / TARGET_MAX_SIZE);
  const customersPerCluster = Math.ceil(customers.length / numClusters);
  
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