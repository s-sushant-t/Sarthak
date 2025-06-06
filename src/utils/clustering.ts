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
    const TARGET_MAX_SIZE = 240; // Enforced maximum

    console.log(`Starting enhanced non-overlapping clustering for ${customers.length} customers with ${TARGET_MIN_SIZE}-${TARGET_MAX_SIZE} outlets per cluster`);

    // Step 1: Create strictly non-overlapping geographic regions using grid-based approach
    const geographicRegions = createNonOverlappingGeographicRegions(customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`Created ${geographicRegions.length} non-overlapping geographic regions`);

    // Step 2: Process each region to create final clusters
    const clusteredCustomers = await processGeographicRegions(geographicRegions, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    // Step 3: Final validation and cleanup
    const finalClusters = validateAndCleanupClusters(clusteredCustomers, customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);

    // Step 4: Validate complete coverage and non-overlap
    const validationResult = validateCompleteNonOverlappingCoverage(finalClusters, customers);
    
    if (!validationResult.isValid) {
      console.warn(`Validation failed: ${validationResult.message}. Applying strict fallback...`);
      return strictNonOverlappingFallback(customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    const clusterCount = new Set(finalClusters.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(finalClusters);
    
    console.log(`✅ Enhanced clustering result: ${clusterCount} non-overlapping clusters`);
    console.log('Cluster sizes:', clusterSizes);
    console.log('All clusters meet size requirements:', clusterSizes.every(size => size >= TARGET_MIN_SIZE && size <= TARGET_MAX_SIZE));

    return finalClusters;

  } catch (error) {
    console.warn('Enhanced clustering failed, using strict fallback:', error);
    return strictNonOverlappingFallback(customers, 180, 240);
  }
};

interface GeographicRegion {
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
  bufferZone: number; // Buffer to prevent overlap
}

function createNonOverlappingGeographicRegions(
  customers: Customer[],
  minSize: number,
  maxSize: number
): GeographicRegion[] {
  console.log('Creating non-overlapping geographic regions using grid-based approach...');
  
  // Calculate bounding box for all customers
  const bounds = {
    minLat: Math.min(...customers.map(c => c.latitude)),
    maxLat: Math.max(...customers.map(c => c.latitude)),
    minLng: Math.min(...customers.map(c => c.longitude)),
    maxLng: Math.max(...customers.map(c => c.longitude))
  };
  
  console.log('Customer bounds:', bounds);
  
  // Calculate optimal grid dimensions
  const totalCustomers = customers.length;
  const optimalRegionCount = Math.ceil(totalCustomers / maxSize);
  const gridSize = Math.ceil(Math.sqrt(optimalRegionCount));
  
  console.log(`Creating ${gridSize}x${gridSize} grid for ${optimalRegionCount} optimal regions`);
  
  // Create grid cells
  const latStep = (bounds.maxLat - bounds.minLat) / gridSize;
  const lngStep = (bounds.maxLng - bounds.minLng) / gridSize;
  const bufferSize = Math.min(latStep, lngStep) * 0.05; // 5% buffer between regions
  
  const regions: GeographicRegion[] = [];
  let regionId = 0;
  
  // Create grid-based regions
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const regionBounds = {
        minLat: bounds.minLat + (row * latStep) + bufferSize,
        maxLat: bounds.minLat + ((row + 1) * latStep) - bufferSize,
        minLng: bounds.minLng + (col * lngStep) + bufferSize,
        maxLng: bounds.minLng + ((col + 1) * lngStep) - bufferSize
      };
      
      // Find customers in this region
      const regionCustomers = customers.filter(customer => 
        customer.latitude >= regionBounds.minLat &&
        customer.latitude <= regionBounds.maxLat &&
        customer.longitude >= regionBounds.minLng &&
        customer.longitude <= regionBounds.maxLng
      );
      
      if (regionCustomers.length > 0) {
        regions.push({
          id: regionId++,
          customers: regionCustomers,
          bounds: regionBounds,
          center: {
            lat: (regionBounds.minLat + regionBounds.maxLat) / 2,
            lng: (regionBounds.minLng + regionBounds.maxLng) / 2
          },
          bufferZone: bufferSize
        });
      }
    }
  }
  
  console.log(`Created ${regions.length} initial grid regions`);
  
  // Balance regions to meet size constraints
  const balancedRegions = balanceRegionSizes(regions, customers, minSize, maxSize);
  
  console.log(`Balanced to ${balancedRegions.length} final regions`);
  return balancedRegions;
}

function balanceRegionSizes(
  regions: GeographicRegion[],
  allCustomers: Customer[],
  minSize: number,
  maxSize: number
): GeographicRegion[] {
  console.log('Balancing region sizes...');
  
  // Separate regions by size
  const oversizedRegions = regions.filter(r => r.customers.length > maxSize);
  const undersizedRegions = regions.filter(r => r.customers.length < minSize);
  const validRegions = regions.filter(r => r.customers.length >= minSize && r.customers.length <= maxSize);
  
  console.log(`Initial: ${oversizedRegions.length} oversized, ${undersizedRegions.length} undersized, ${validRegions.length} valid`);
  
  const finalRegions: GeographicRegion[] = [...validRegions];
  let nextRegionId = Math.max(...regions.map(r => r.id)) + 1;
  
  // Split oversized regions
  oversizedRegions.forEach(region => {
    const splitRegions = splitOversizedRegion(region, maxSize, nextRegionId);
    finalRegions.push(...splitRegions);
    nextRegionId += splitRegions.length;
  });
  
  // Merge undersized regions
  const mergedRegions = mergeUndersizedRegions(undersizedRegions, minSize, maxSize, nextRegionId);
  finalRegions.push(...mergedRegions);
  
  // Handle any remaining unassigned customers
  const assignedCustomers = new Set(finalRegions.flatMap(r => r.customers.map(c => c.id)));
  const unassignedCustomers = allCustomers.filter(c => !assignedCustomers.has(c.id));
  
  if (unassignedCustomers.length > 0) {
    console.log(`Handling ${unassignedCustomers.length} unassigned customers...`);
    
    if (unassignedCustomers.length >= minSize) {
      // Create new region for unassigned customers
      const newRegion = createRegionFromCustomers(nextRegionId++, unassignedCustomers);
      finalRegions.push(newRegion);
    } else {
      // Distribute to nearest regions without exceeding max size
      distributeUnassignedCustomers(unassignedCustomers, finalRegions, maxSize);
    }
  }
  
  console.log(`Final balanced regions: ${finalRegions.length}`);
  return finalRegions;
}

function splitOversizedRegion(
  region: GeographicRegion,
  maxSize: number,
  startId: number
): GeographicRegion[] {
  const customers = region.customers;
  const numSplits = Math.ceil(customers.length / maxSize);
  
  console.log(`Splitting region ${region.id} (${customers.length} customers) into ${numSplits} parts`);
  
  // Sort customers by latitude then longitude for geographic coherence
  const sortedCustomers = [...customers].sort((a, b) => {
    if (Math.abs(a.latitude - b.latitude) > 0.001) {
      return a.latitude - b.latitude;
    }
    return a.longitude - b.longitude;
  });
  
  const splitRegions: GeographicRegion[] = [];
  const customersPerSplit = Math.ceil(customers.length / numSplits);
  
  for (let i = 0; i < numSplits; i++) {
    const start = i * customersPerSplit;
    const end = Math.min(start + customersPerSplit, sortedCustomers.length);
    const splitCustomers = sortedCustomers.slice(start, end);
    
    if (splitCustomers.length > 0) {
      splitRegions.push(createRegionFromCustomers(startId + i, splitCustomers));
    }
  }
  
  return splitRegions;
}

function mergeUndersizedRegions(
  undersizedRegions: GeographicRegion[],
  minSize: number,
  maxSize: number,
  startId: number
): GeographicRegion[] {
  if (undersizedRegions.length === 0) return [];
  
  console.log(`Merging ${undersizedRegions.length} undersized regions...`);
  
  // Sort by geographic proximity (latitude first, then longitude)
  const sortedRegions = [...undersizedRegions].sort((a, b) => {
    if (Math.abs(a.center.lat - b.center.lat) > 0.001) {
      return a.center.lat - b.center.lat;
    }
    return a.center.lng - b.center.lng;
  });
  
  const mergedRegions: GeographicRegion[] = [];
  let currentMerge: Customer[] = [];
  let regionId = startId;
  
  for (const region of sortedRegions) {
    if (currentMerge.length + region.customers.length <= maxSize) {
      currentMerge.push(...region.customers);
    } else {
      // Finalize current merge if it meets minimum size
      if (currentMerge.length >= minSize) {
        mergedRegions.push(createRegionFromCustomers(regionId++, currentMerge));
      }
      currentMerge = [...region.customers];
    }
  }
  
  // Handle final merge
  if (currentMerge.length > 0) {
    if (currentMerge.length >= minSize) {
      mergedRegions.push(createRegionFromCustomers(regionId++, currentMerge));
    } else if (mergedRegions.length > 0) {
      // Add to last merged region if it doesn't exceed max size
      const lastRegion = mergedRegions[mergedRegions.length - 1];
      if (lastRegion.customers.length + currentMerge.length <= maxSize) {
        lastRegion.customers.push(...currentMerge);
        updateRegionBounds(lastRegion);
      } else {
        mergedRegions.push(createRegionFromCustomers(regionId++, currentMerge));
      }
    } else {
      mergedRegions.push(createRegionFromCustomers(regionId++, currentMerge));
    }
  }
  
  return mergedRegions;
}

function createRegionFromCustomers(id: number, customers: Customer[]): GeographicRegion {
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
    bufferZone: 0.001 // Small buffer
  };
}

function updateRegionBounds(region: GeographicRegion): void {
  const lats = region.customers.map(c => c.latitude);
  const lngs = region.customers.map(c => c.longitude);
  
  region.bounds = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs)
  };
  
  region.center = {
    lat: lats.reduce((sum, lat) => sum + lat, 0) / lats.length,
    lng: lngs.reduce((sum, lng) => sum + lng, 0) / lngs.length
  };
}

function distributeUnassignedCustomers(
  unassignedCustomers: Customer[],
  regions: GeographicRegion[],
  maxSize: number
): void {
  unassignedCustomers.forEach(customer => {
    // Find nearest region with space
    let nearestRegion = null;
    let minDistance = Infinity;
    
    for (const region of regions) {
      if (region.customers.length < maxSize) {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          region.center.lat, region.center.lng
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          nearestRegion = region;
        }
      }
    }
    
    if (nearestRegion) {
      nearestRegion.customers.push(customer);
      updateRegionBounds(nearestRegion);
    } else {
      console.warn(`Could not assign customer ${customer.id} to any region`);
    }
  });
}

async function processGeographicRegions(
  regions: GeographicRegion[],
  minSize: number,
  maxSize: number
): Promise<ClusteredCustomer[]> {
  const clusteredCustomers: ClusteredCustomer[] = [];
  let clusterId = 0;
  
  for (const region of regions) {
    console.log(`Processing region ${region.id} with ${region.customers.length} customers`);
    
    if (region.customers.length >= minSize && region.customers.length <= maxSize) {
      // Region is optimal size - treat as single cluster
      region.customers.forEach(customer => {
        clusteredCustomers.push({
          ...customer,
          clusterId: clusterId
        });
      });
      clusterId++;
    } else if (region.customers.length > maxSize) {
      // Split large region into multiple clusters
      const subClusters = splitRegionIntoClusters(region.customers, minSize, maxSize);
      
      subClusters.forEach(cluster => {
        cluster.forEach(customer => {
          clusteredCustomers.push({
            ...customer,
            clusterId: clusterId
          });
        });
        clusterId++;
      });
    } else {
      // Small region - this should be rare after balancing
      console.warn(`Small region ${region.id} with ${region.customers.length} customers`);
      region.customers.forEach(customer => {
        clusteredCustomers.push({
          ...customer,
          clusterId: clusterId
        });
      });
      clusterId++;
    }
    
    // Yield to prevent blocking
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  return clusteredCustomers;
}

function splitRegionIntoClusters(
  customers: Customer[],
  minSize: number,
  maxSize: number
): Customer[][] {
  const numClusters = Math.ceil(customers.length / maxSize);
  const clusters: Customer[][] = [];
  
  // Sort customers spatially for geographic coherence
  const sortedCustomers = [...customers].sort((a, b) => {
    // Use Morton code for spatial ordering
    const mortonA = calculateMortonCode(a.latitude, a.longitude, customers);
    const mortonB = calculateMortonCode(b.latitude, b.longitude, customers);
    return mortonA - mortonB;
  });
  
  const customersPerCluster = Math.floor(customers.length / numClusters);
  const remainder = customers.length % numClusters;
  
  let currentIndex = 0;
  
  for (let i = 0; i < numClusters; i++) {
    const clusterSize = customersPerCluster + (i < remainder ? 1 : 0);
    const cluster = sortedCustomers.slice(currentIndex, currentIndex + clusterSize);
    
    if (cluster.length >= minSize || i === numClusters - 1) {
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

function calculateMortonCode(lat: number, lng: number, allCustomers: Customer[]): number {
  // Normalize coordinates to [0, 1] range
  const minLat = Math.min(...allCustomers.map(c => c.latitude));
  const maxLat = Math.max(...allCustomers.map(c => c.latitude));
  const minLng = Math.min(...allCustomers.map(c => c.longitude));
  const maxLng = Math.max(...allCustomers.map(c => c.longitude));
  
  const normLat = (lat - minLat) / (maxLat - minLat);
  const normLng = (lng - minLng) / (maxLng - minLng);
  
  // Calculate Morton code for spatial ordering
  const intLat = Math.floor(normLat * 1024) & 0x3FF; // 10 bits
  const intLng = Math.floor(normLng * 1024) & 0x3FF; // 10 bits
  
  let morton = 0;
  for (let i = 0; i < 10; i++) {
    morton |= ((intLat & (1 << i)) << i) | ((intLng & (1 << i)) << (i + 1));
  }
  
  return morton;
}

function validateAndCleanupClusters(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  minSize: number,
  maxSize: number
): ClusteredCustomer[] {
  console.log('Validating and cleaning up clusters...');
  
  // Group by cluster ID
  const clusterMap = new Map<number, ClusteredCustomer[]>();
  clusteredCustomers.forEach(customer => {
    if (!clusterMap.has(customer.clusterId)) {
      clusterMap.set(customer.clusterId, []);
    }
    clusterMap.get(customer.clusterId)!.push(customer);
  });
  
  const validatedCustomers: ClusteredCustomer[] = [];
  let nextClusterId = 0;
  
  const clusters = Array.from(clusterMap.values());
  const smallClusters: ClusteredCustomer[][] = [];
  
  // Process clusters
  clusters.forEach(cluster => {
    if (cluster.length >= minSize && cluster.length <= maxSize) {
      // Valid cluster
      cluster.forEach(customer => {
        validatedCustomers.push({
          ...customer,
          clusterId: nextClusterId
        });
      });
      nextClusterId++;
    } else if (cluster.length < minSize) {
      // Store small clusters for merging
      smallClusters.push(cluster);
    } else {
      // Split large cluster
      const subClusters = splitRegionIntoClusters(cluster, minSize, maxSize);
      subClusters.forEach(subCluster => {
        subCluster.forEach(customer => {
          validatedCustomers.push({
            ...customer,
            clusterId: nextClusterId
          });
        });
        nextClusterId++;
      });
    }
  });
  
  // Merge small clusters
  const mergedClusters = mergeSmallClustersSpatially(smallClusters, minSize, maxSize);
  mergedClusters.forEach(mergedCluster => {
    mergedCluster.forEach(customer => {
      validatedCustomers.push({
        ...customer,
        clusterId: nextClusterId
      });
    });
    nextClusterId++;
  });
  
  return validatedCustomers;
}

function mergeSmallClustersSpatially(
  smallClusters: ClusteredCustomer[][],
  minSize: number,
  maxSize: number
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
    if (currentMerge.length + cluster.length <= maxSize) {
      currentMerge.push(...cluster);
    } else {
      if (currentMerge.length >= minSize) {
        mergedClusters.push(currentMerge);
      }
      currentMerge = [...cluster];
    }
  }
  
  // Handle remaining merge
  if (currentMerge.length > 0) {
    if (currentMerge.length >= minSize) {
      mergedClusters.push(currentMerge);
    } else if (mergedClusters.length > 0) {
      // Add to last cluster if it doesn't exceed max size
      const lastCluster = mergedClusters[mergedClusters.length - 1];
      if (lastCluster.length + currentMerge.length <= maxSize) {
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
  
  // Check 4: Cluster size constraints
  const clusterSizes = getClusterSizes(clusteredCustomers);
  const undersizedClusters = clusterSizes.filter(size => size < 180);
  const oversizedClusters = clusterSizes.filter(size => size > 240);
  
  if (undersizedClusters.length > 0) {
    return {
      isValid: false,
      message: `Minimum size violation: ${undersizedClusters.length} clusters below 180 outlets`
    };
  }
  
  if (oversizedClusters.length > 0) {
    return {
      isValid: false,
      message: `Maximum size violation: ${oversizedClusters.length} clusters above 240 outlets`
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

function strictNonOverlappingFallback(
  customers: Customer[], 
  minSize: number, 
  maxSize: number
): ClusteredCustomer[] {
  console.log('Applying strict non-overlapping fallback clustering...');
  
  const maxClusters = Math.floor(customers.length / minSize);
  const customersPerCluster = Math.min(maxSize, Math.ceil(customers.length / maxClusters));
  
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