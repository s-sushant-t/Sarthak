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

    console.log(`Starting enhanced non-overlapping clustering for ${customers.length} customers with minimum ${TARGET_MIN_SIZE} outlets per cluster`);

    // Step 1: Compute median coordinates as central reference point
    const { medianLat, medianLng } = computeMedianCoordinates(customers);
    console.log(`Central reference point: (${medianLat.toFixed(6)}, ${medianLng.toFixed(6)})`);

    // Step 2: Create strictly non-overlapping spatial zones using Voronoi-like partitioning
    const spatialZones = createStrictNonOverlappingZones(customers, medianLat, medianLng, TARGET_MIN_SIZE);
    console.log(`Created ${spatialZones.length} strictly non-overlapping spatial zones`);

    // Step 3: Apply density-based clustering within each zone
    const clusteredCustomers = await clusterWithinZonesStrict(spatialZones, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    // Step 4: Enforce strict non-overlap and minimum size constraints
    const finalClusters = enforceStrictNonOverlapConstraints(clusteredCustomers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    // Step 5: Validate complete coverage and non-overlap
    const validationResult = validateCompleteNonOverlappingCoverage(finalClusters, customers);
    
    if (!validationResult.isValid) {
      console.warn(`Validation failed: ${validationResult.message}. Applying strict fallback...`);
      return strictNonOverlappingFallback(customers, TARGET_MIN_SIZE);
    }

    const clusterCount = new Set(finalClusters.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(finalClusters);
    
    console.log(`✅ Enhanced clustering result: ${clusterCount} non-overlapping clusters`);
    console.log('Cluster sizes:', clusterSizes);
    console.log('All clusters meet minimum size requirement:', clusterSizes.every(size => size >= TARGET_MIN_SIZE));

    return finalClusters;

  } catch (error) {
    console.warn('Enhanced clustering failed, using strict fallback:', error);
    return strictNonOverlappingFallback(customers, 180);
  }
};

interface SpatialZone {
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
  isLocked: boolean;
  boundaryBuffer: number; // Buffer zone to prevent overlap
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

function createStrictNonOverlappingZones(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  minZoneSize: number
): SpatialZone[] {
  console.log('Creating strictly non-overlapping spatial zones...');
  
  // Calculate optimal number of zones based on minimum size constraint
  const maxPossibleZones = Math.floor(customers.length / minZoneSize);
  const optimalZoneCount = Math.max(1, Math.min(maxPossibleZones, 8)); // Cap at 8 zones for manageability
  
  console.log(`Target zones: ${optimalZoneCount} (max possible: ${maxPossibleZones})`);
  
  // Use enhanced k-means with strict boundary enforcement
  return createVoronoiLikeZones(customers, medianLat, medianLng, optimalZoneCount, minZoneSize);
}

function createVoronoiLikeZones(
  customers: Customer[],
  medianLat: number,
  medianLng: number,
  zoneCount: number,
  minZoneSize: number
): SpatialZone[] {
  const maxIterations = 20;
  const convergenceThreshold = 0.0001; // ~10 meters
  
  // Initialize zone centers using k-means++ for better distribution
  let zoneCenters = initializeZoneCentersKMeansPlusPlus(customers, zoneCount, medianLat, medianLng);
  
  let previousCenters = [...zoneCenters];
  let iteration = 0;
  
  while (iteration < maxIterations) {
    // Assign customers to nearest zone center (Voronoi assignment)
    const assignments = customers.map(customer => {
      let nearestZone = 0;
      let minDistance = Infinity;
      
      zoneCenters.forEach((center, index) => {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          center.lat, center.lng
        );
        if (distance < minDistance) {
          minDistance = distance;
          nearestZone = index;
        }
      });
      
      return nearestZone;
    });
    
    // Check zone sizes and enforce minimum size constraint
    const zoneSizes = new Array(zoneCount).fill(0);
    assignments.forEach(assignment => zoneSizes[assignment]++);
    
    // Redistribute customers to ensure minimum zone sizes
    const balancedAssignments = enforceMinimumZoneSizes(
      customers, assignments, zoneSizes, minZoneSize
    );
    
    // Update zone centers based on balanced assignments
    zoneCenters = zoneCenters.map((_, index) => {
      const zoneCustomers = customers.filter((_, i) => balancedAssignments[i] === index);
      if (zoneCustomers.length === 0) return zoneCenters[index];
      
      const avgLat = zoneCustomers.reduce((sum, c) => sum + c.latitude, 0) / zoneCustomers.length;
      const avgLng = zoneCustomers.reduce((sum, c) => sum + c.longitude, 0) / zoneCustomers.length;
      
      return { lat: avgLat, lng: avgLng };
    });
    
    // Check for convergence
    const converged = zoneCenters.every((center, index) => {
      const distance = calculateDistance(
        center.lat, center.lng,
        previousCenters[index].lat, previousCenters[index].lng
      );
      return distance < convergenceThreshold;
    });
    
    if (converged) {
      console.log(`Zone creation converged after ${iteration + 1} iterations`);
      break;
    }
    
    previousCenters = [...zoneCenters];
    iteration++;
  }
  
  // Create final zones with strict boundaries
  const finalAssignments = customers.map(customer => {
    let nearestZone = 0;
    let minDistance = Infinity;
    
    zoneCenters.forEach((center, index) => {
      const distance = calculateDistance(
        customer.latitude, customer.longitude,
        center.lat, center.lng
      );
      if (distance < minDistance) {
        minDistance = distance;
        nearestZone = index;
      }
    });
    
    return nearestZone;
  });
  
  // Build zones with buffer zones to prevent overlap
  const zones: SpatialZone[] = [];
  const bufferDistance = 0.1; // 100 meter buffer between zones
  
  zoneCenters.forEach((center, index) => {
    const zoneCustomers = customers.filter((_, i) => finalAssignments[i] === index);
    
    if (zoneCustomers.length >= minZoneSize) {
      zones.push(createZoneWithBuffer(index, zoneCustomers, bufferDistance));
    }
  });
  
  // Handle any remaining customers not in valid zones
  const assignedCustomers = new Set(zones.flatMap(z => z.customers.map(c => c.id)));
  const unassignedCustomers = customers.filter(c => !assignedCustomers.has(c.id));
  
  if (unassignedCustomers.length > 0) {
    console.log(`Handling ${unassignedCustomers.length} unassigned customers...`);
    
    if (unassignedCustomers.length >= minZoneSize) {
      // Create new zone for unassigned customers
      zones.push(createZoneWithBuffer(zones.length, unassignedCustomers, bufferDistance));
    } else {
      // Distribute to nearest zones while maintaining non-overlap
      distributeToNearestZonesWithoutOverlap(unassignedCustomers, zones);
    }
  }
  
  return zones;
}

function initializeZoneCentersKMeansPlusPlus(
  customers: Customer[],
  k: number,
  medianLat: number,
  medianLng: number
): { lat: number; lng: number }[] {
  const centers: { lat: number; lng: number }[] = [];
  
  // Start with median point as first center
  centers.push({ lat: medianLat, lng: medianLng });
  
  // Use k-means++ for remaining centers
  for (let i = 1; i < k; i++) {
    const distances = customers.map(customer => {
      let minDistance = Infinity;
      centers.forEach(center => {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          center.lat, center.lng
        );
        minDistance = Math.min(minDistance, distance);
      });
      return minDistance * minDistance; // Square for k-means++
    });
    
    const totalDistance = distances.reduce((sum, d) => sum + d, 0);
    const random = Math.random() * totalDistance;
    
    let cumulativeDistance = 0;
    for (let j = 0; j < customers.length; j++) {
      cumulativeDistance += distances[j];
      if (cumulativeDistance >= random) {
        centers.push({ lat: customers[j].latitude, lng: customers[j].longitude });
        break;
      }
    }
  }
  
  return centers;
}

function enforceMinimumZoneSizes(
  customers: Customer[],
  assignments: number[],
  zoneSizes: number[],
  minZoneSize: number
): number[] {
  const balancedAssignments = [...assignments];
  
  // Find undersized and oversized zones
  const undersized = zoneSizes
    .map((size, index) => ({ index, size, deficit: minZoneSize - size }))
    .filter(z => z.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit); // Prioritize zones with larger deficits
  
  const oversized = zoneSizes
    .map((size, index) => ({ index, size, surplus: size - minZoneSize }))
    .filter(z => z.surplus > 0)
    .sort((a, b) => b.surplus - a.surplus); // Prioritize zones with larger surplus
  
  // Redistribute from oversized to undersized zones
  for (const under of undersized) {
    let needed = under.deficit;
    
    for (const over of oversized) {
      if (needed <= 0 || over.surplus <= 0) continue;
      
      // Find customers in oversized zone that are closest to undersized zone
      const oversizedCustomers = customers
        .map((customer, index) => ({ customer, index }))
        .filter(({ index }) => balancedAssignments[index] === over.index);
      
      const undersizedCustomers = customers
        .filter((_, index) => balancedAssignments[index] === under.index);
      
      if (undersizedCustomers.length === 0) {
        // If undersized zone is empty, use zone center
        const underCenter = calculateZoneCenter(customers, balancedAssignments, under.index);
        
        // Sort by distance to undersized zone center
        oversizedCustomers.sort((a, b) => {
          const distA = calculateDistance(
            a.customer.latitude, a.customer.longitude,
            underCenter.lat, underCenter.lng
          );
          const distB = calculateDistance(
            b.customer.latitude, b.customer.longitude,
            underCenter.lat, underCenter.lng
          );
          return distA - distB;
        });
      } else {
        // Sort by distance to undersized zone centroid
        const underCentroid = calculateCentroid(undersizedCustomers);
        
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
      }
      
      // Transfer closest customers
      const toTransfer = Math.min(needed, over.surplus);
      for (let i = 0; i < toTransfer; i++) {
        if (oversizedCustomers[i]) {
          balancedAssignments[oversizedCustomers[i].index] = under.index;
          needed--;
          over.surplus--;
        }
      }
    }
  }
  
  return balancedAssignments;
}

function calculateZoneCenter(
  customers: Customer[],
  assignments: number[],
  zoneIndex: number
): { lat: number; lng: number } {
  const zoneCustomers = customers.filter((_, i) => assignments[i] === zoneIndex);
  
  if (zoneCustomers.length === 0) {
    // Return a default center if zone is empty
    return { lat: 0, lng: 0 };
  }
  
  return calculateCentroid(zoneCustomers);
}

function calculateCentroid(customers: Customer[]): { lat: number; lng: number } {
  const avgLat = customers.reduce((sum, c) => sum + c.latitude, 0) / customers.length;
  const avgLng = customers.reduce((sum, c) => sum + c.longitude, 0) / customers.length;
  return { lat: avgLat, lng: avgLng };
}

function createZoneWithBuffer(
  id: number,
  customers: Customer[],
  bufferDistance: number
): SpatialZone {
  const lats = customers.map(c => c.latitude);
  const lngs = customers.map(c => c.longitude);
  
  return {
    id,
    customers,
    bounds: {
      minLat: Math.min(...lats) - bufferDistance,
      maxLat: Math.max(...lats) + bufferDistance,
      minLng: Math.min(...lngs) - bufferDistance,
      maxLng: Math.max(...lngs) + bufferDistance
    },
    center: {
      lat: lats.reduce((sum, lat) => sum + lat, 0) / lats.length,
      lng: lngs.reduce((sum, lng) => sum + lng, 0) / lngs.length
    },
    isLocked: true,
    boundaryBuffer: bufferDistance
  };
}

function distributeToNearestZonesWithoutOverlap(
  unassignedCustomers: Customer[],
  zones: SpatialZone[]
): void {
  unassignedCustomers.forEach(customer => {
    let nearestZone = zones[0];
    let minDistance = Infinity;
    
    zones.forEach(zone => {
      const distance = calculateDistance(
        customer.latitude, customer.longitude,
        zone.center.lat, zone.center.lng
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestZone = zone;
      }
    });
    
    nearestZone.customers.push(customer);
    updateZoneBounds(nearestZone);
  });
}

function updateZoneBounds(zone: SpatialZone): void {
  const lats = zone.customers.map(c => c.latitude);
  const lngs = zone.customers.map(c => c.longitude);
  
  zone.bounds = {
    minLat: Math.min(...lats) - zone.boundaryBuffer,
    maxLat: Math.max(...lats) + zone.boundaryBuffer,
    minLng: Math.min(...lngs) - zone.boundaryBuffer,
    maxLng: Math.max(...lngs) + zone.boundaryBuffer
  };
  
  zone.center = {
    lat: lats.reduce((sum, lat) => sum + lat, 0) / lats.length,
    lng: lngs.reduce((sum, lng) => sum + lng, 0) / lngs.length
  };
}

async function clusterWithinZonesStrict(
  zones: SpatialZone[],
  targetMinSize: number,
  targetMaxSize: number
): Promise<ClusteredCustomer[]> {
  const clusteredCustomers: ClusteredCustomer[] = [];
  let globalClusterId = 0;
  
  for (const zone of zones) {
    console.log(`Processing zone ${zone.id} with ${zone.customers.length} customers`);
    
    if (zone.customers.length >= targetMinSize && zone.customers.length <= targetMaxSize) {
      // Zone is optimal size - treat as single cluster
      zone.customers.forEach(customer => {
        clusteredCustomers.push({
          ...customer,
          clusterId: globalClusterId
        });
      });
      globalClusterId++;
    } else if (zone.customers.length < targetMinSize) {
      // This should not happen due to zone creation constraints
      console.warn(`Zone ${zone.id} has only ${zone.customers.length} customers (< ${targetMinSize})`);
      zone.customers.forEach(customer => {
        clusteredCustomers.push({
          ...customer,
          clusterId: globalClusterId
        });
      });
      globalClusterId++;
    } else {
      // Large zone - split into multiple non-overlapping clusters
      const zoneClusters = await splitZoneIntoNonOverlappingClusters(zone, targetMinSize, targetMaxSize);
      
      zoneClusters.forEach(cluster => {
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

async function splitZoneIntoNonOverlappingClusters(
  zone: SpatialZone,
  targetMinSize: number,
  targetMaxSize: number
): Promise<Customer[][]> {
  const customers = zone.customers;
  
  // Calculate optimal number of clusters ensuring minimum size
  const maxClusters = Math.floor(customers.length / targetMinSize);
  const optimalClusterCount = Math.min(maxClusters, Math.ceil(customers.length / targetMaxSize));
  
  if (optimalClusterCount <= 1) {
    return [customers];
  }
  
  // Use spatial sorting to create geographically coherent, non-overlapping clusters
  return createSpatiallyCoherentClusters(customers, optimalClusterCount, targetMinSize);
}

function createSpatiallyCoherentClusters(
  customers: Customer[],
  clusterCount: number,
  minSize: number
): Customer[][] {
  // Sort customers using space-filling curve (Z-order/Morton order) for spatial coherence
  const sortedCustomers = [...customers].sort((a, b) => {
    // Normalize coordinates to [0, 1] range
    const minLat = Math.min(...customers.map(c => c.latitude));
    const maxLat = Math.max(...customers.map(c => c.latitude));
    const minLng = Math.min(...customers.map(c => c.longitude));
    const maxLng = Math.max(...customers.map(c => c.longitude));
    
    const normLatA = (a.latitude - minLat) / (maxLat - minLat);
    const normLngA = (a.longitude - minLng) / (maxLng - minLng);
    const normLatB = (b.latitude - minLat) / (maxLat - minLat);
    const normLngB = (b.longitude - minLng) / (maxLng - minLng);
    
    // Calculate Morton codes for spatial ordering
    const mortonA = calculateMortonCode(normLatA, normLngA);
    const mortonB = calculateMortonCode(normLatB, normLngB);
    
    return mortonA - mortonB;
  });
  
  // Create clusters with guaranteed minimum size
  const clusters: Customer[][] = [];
  const customersPerCluster = Math.floor(sortedCustomers.length / clusterCount);
  const remainder = sortedCustomers.length % clusterCount;
  
  let currentIndex = 0;
  
  for (let i = 0; i < clusterCount; i++) {
    const clusterSize = customersPerCluster + (i < remainder ? 1 : 0);
    const cluster = sortedCustomers.slice(currentIndex, currentIndex + clusterSize);
    
    // Ensure minimum size constraint
    if (cluster.length >= minSize || i === clusterCount - 1) {
      clusters.push(cluster);
    } else {
      // Merge with previous cluster if too small
      if (clusters.length > 0) {
        clusters[clusters.length - 1].push(...cluster);
      } else {
        clusters.push(cluster);
      }
    }
    
    currentIndex += clusterSize;
  }
  
  return clusters;
}

function calculateMortonCode(x: number, y: number): number {
  // Simple Morton code calculation for 2D spatial ordering
  const intX = Math.floor(x * 1024) & 0x3FF; // 10 bits
  const intY = Math.floor(y * 1024) & 0x3FF; // 10 bits
  
  let morton = 0;
  for (let i = 0; i < 10; i++) {
    morton |= ((intX & (1 << i)) << i) | ((intY & (1 << i)) << (i + 1));
  }
  
  return morton;
}

function enforceStrictNonOverlapConstraints(
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
  
  // Process clusters with strict constraints
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
      // Split large cluster using spatial coherence
      const subClusters = splitLargeClusterSpatially(cluster, targetMinSize, targetMaxSize);
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
  
  // Merge small clusters with spatial awareness
  const mergedClusters = mergeSmallClustersSpatially(smallClusters, targetMinSize, targetMaxSize);
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

function splitLargeClusterSpatially(
  cluster: ClusteredCustomer[],
  targetMinSize: number,
  targetMaxSize: number
): ClusteredCustomer[][] {
  const maxSubClusters = Math.floor(cluster.length / targetMinSize);
  const optimalSubClusters = Math.min(maxSubClusters, Math.ceil(cluster.length / targetMaxSize));
  
  if (optimalSubClusters <= 1) {
    return [cluster];
  }
  
  return createSpatiallyCoherentClusters(cluster, optimalSubClusters, targetMinSize);
}

function mergeSmallClustersSpatially(
  smallClusters: ClusteredCustomer[][],
  targetMinSize: number,
  targetMaxSize: number
): ClusteredCustomer[][] {
  if (smallClusters.length === 0) return [];
  
  const mergedClusters: ClusteredCustomer[][] = [];
  
  // Sort small clusters by their centroids for spatial coherence
  const sortedSmallClusters = [...smallClusters].sort((a, b) => {
    const centroidA = calculateClusterCentroid(a);
    const centroidB = calculateClusterCentroid(b);
    
    // Sort by latitude first, then longitude
    if (Math.abs(centroidA.lat - centroidB.lat) > 0.001) {
      return centroidA.lat - centroidB.lat;
    }
    return centroidA.lng - centroidB.lng;
  });
  
  let currentMerge: ClusteredCustomer[] = [];
  
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

function validateCompleteNonOverlappingCoverage(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[]
): { isValid: boolean; message: string } {
  // Check 1: All customers are assigned
  if (clusteredCustomers.length !== originalCustomers.length) {
    return {
      isValid: false,
      message: `Customer count mismatch: Input ${originalCustomers.length}, Output ${clusteredCustomers.length}`
    };
  }
  
  // Check 2: No customer is assigned to multiple clusters (non-overlapping)
  const customerClusterMap = new Map<string, number>();
  const duplicates: string[] = [];
  
  clusteredCustomers.forEach(customer => {
    if (customerClusterMap.has(customer.id)) {
      duplicates.push(customer.id);
    } else {
      customerClusterMap.set(customer.id, customer.clusterId);
    }
  });
  
  if (duplicates.length > 0) {
    return {
      isValid: false,
      message: `Overlapping clusters detected: ${duplicates.length} customers assigned to multiple clusters`
    };
  }
  
  // Check 3: All original customers are present
  const originalIds = new Set(originalCustomers.map(c => c.id));
  const clusteredIds = new Set(clusteredCustomers.map(c => c.id));
  
  const missingIds = Array.from(originalIds).filter(id => !clusteredIds.has(id));
  if (missingIds.length > 0) {
    return {
      isValid: false,
      message: `Missing customers: ${missingIds.length} customers not assigned to any cluster`
    };
  }
  
  // Check 4: Minimum cluster size constraint
  const clusterSizes = getClusterSizes(clusteredCustomers);
  const undersizedClusters = clusterSizes.filter(size => size < 180);
  
  if (undersizedClusters.length > 0) {
    return {
      isValid: false,
      message: `Minimum size violation: ${undersizedClusters.length} clusters below 180 outlets`
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

function strictNonOverlappingFallback(customers: Customer[], minSize: number): ClusteredCustomer[] {
  console.log('Applying strict non-overlapping fallback clustering...');
  
  const maxClusters = Math.floor(customers.length / minSize);
  const customersPerCluster = Math.ceil(customers.length / maxClusters);
  
  // Sort by spatial coordinates for geographic coherence
  const sortedCustomers = [...customers].sort((a, b) => {
    // Primary sort by latitude
    if (Math.abs(a.latitude - b.latitude) > 0.001) {
      return a.latitude - b.latitude;
    }
    // Secondary sort by longitude
    return a.longitude - b.longitude;
  });
  
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