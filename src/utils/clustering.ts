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
    const TARGET_MAX_SIZE = 240;

    console.log(`Starting circular sector clustering for ${customers.length} customers with ${TARGET_MIN_SIZE}-${TARGET_MAX_SIZE} outlets per cluster`);

    // Step 1: Find the median center point
    const medianCenter = calculateMedianCenter(customers);
    console.log('Median center:', medianCenter);

    // Step 2: Create circular sectors from the median center
    const sectors = createCircularSectors(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`Created ${sectors.length} circular sectors`);

    // Step 3: Balance sector sizes
    const balancedSectors = balanceSectorSizes(sectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`Balanced to ${balancedSectors.length} final sectors`);

    // Step 4: Convert sectors to clusters
    const clusteredCustomers = convertSectorsToClusters(balancedSectors);

    // Step 5: Final validation
    const validationResult = validateClustering(clusteredCustomers, customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    
    if (!validationResult.isValid) {
      console.warn(`Validation failed: ${validationResult.message}. Applying fallback...`);
      return circularSectorFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ Circular sector clustering result: ${clusterCount} sectors`);
    console.log('Sector sizes:', clusterSizes);
    console.log('All sectors meet size requirements:', clusterSizes.every(size => size >= TARGET_MIN_SIZE && size <= TARGET_MAX_SIZE));

    return clusteredCustomers;

  } catch (error) {
    console.warn('Circular sector clustering failed, using fallback:', error);
    const medianCenter = calculateMedianCenter(customers);
    return circularSectorFallback(customers, medianCenter, 180, 240);
  }
};

interface MedianCenter {
  latitude: number;
  longitude: number;
}

interface CircularSector {
  id: number;
  customers: Customer[];
  startAngle: number; // in radians
  endAngle: number;   // in radians
  minRadius: number;  // in kilometers
  maxRadius: number;  // in kilometers
  center: MedianCenter;
}

function calculateMedianCenter(customers: Customer[]): MedianCenter {
  console.log('Calculating median center point...');
  
  // Sort by latitude and longitude to find medians
  const sortedByLat = [...customers].sort((a, b) => a.latitude - b.latitude);
  const sortedByLng = [...customers].sort((a, b) => a.longitude - b.longitude);
  
  const medianLat = sortedByLat.length % 2 === 0
    ? (sortedByLat[sortedByLat.length / 2 - 1].latitude + sortedByLat[sortedByLat.length / 2].latitude) / 2
    : sortedByLat[Math.floor(sortedByLat.length / 2)].latitude;
    
  const medianLng = sortedByLng.length % 2 === 0
    ? (sortedByLng[sortedByLng.length / 2 - 1].longitude + sortedByLng[sortedByLng.length / 2].longitude) / 2
    : sortedByLng[Math.floor(sortedByLng.length / 2)].longitude;
  
  return {
    latitude: medianLat,
    longitude: medianLng
  };
}

function createCircularSectors(
  customers: Customer[],
  center: MedianCenter,
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('Creating circular sectors from median center...');
  
  // Calculate polar coordinates for each customer
  const customersWithPolar = customers.map(customer => ({
    ...customer,
    distance: calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude),
    angle: calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude)
  }));
  
  // Sort by angle for sector creation
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  // Calculate optimal number of sectors
  const totalCustomers = customers.length;
  const optimalSectorCount = Math.ceil(totalCustomers / maxSize);
  const customersPerSector = Math.ceil(totalCustomers / optimalSectorCount);
  
  console.log(`Creating ${optimalSectorCount} sectors with ~${customersPerSector} customers each`);
  
  const sectors: CircularSector[] = [];
  const angleStep = (2 * Math.PI) / optimalSectorCount;
  
  for (let i = 0; i < optimalSectorCount; i++) {
    const startAngle = i * angleStep;
    const endAngle = (i + 1) * angleStep;
    
    // Find customers in this angular sector
    const sectorCustomers = customersWithPolar.filter(customer => {
      let angle = customer.angle;
      
      // Handle angle wraparound at 2π
      if (startAngle > endAngle) {
        return angle >= startAngle || angle <= endAngle;
      } else {
        return angle >= startAngle && angle <= endAngle;
      }
    });
    
    if (sectorCustomers.length > 0) {
      // Calculate radius bounds for this sector
      const distances = sectorCustomers.map(c => c.distance);
      const minRadius = Math.min(...distances);
      const maxRadius = Math.max(...distances);
      
      sectors.push({
        id: i,
        customers: sectorCustomers.map(({ distance, angle, ...customer }) => customer),
        startAngle,
        endAngle,
        minRadius,
        maxRadius,
        center
      });
    }
  }
  
  // Handle any remaining customers due to floating point precision
  const assignedCustomerIds = new Set(sectors.flatMap(s => s.customers.map(c => c.id)));
  const unassignedCustomers = customers.filter(c => !assignedCustomerIds.has(c.id));
  
  if (unassignedCustomers.length > 0) {
    console.log(`Assigning ${unassignedCustomers.length} remaining customers to nearest sectors...`);
    
    unassignedCustomers.forEach(customer => {
      const customerAngle = calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude);
      
      // Find the nearest sector by angle
      let nearestSector = sectors[0];
      let minAngleDiff = Infinity;
      
      sectors.forEach(sector => {
        const sectorMidAngle = (sector.startAngle + sector.endAngle) / 2;
        const angleDiff = Math.min(
          Math.abs(customerAngle - sectorMidAngle),
          2 * Math.PI - Math.abs(customerAngle - sectorMidAngle)
        );
        
        if (angleDiff < minAngleDiff && sector.customers.length < maxSize) {
          minAngleDiff = angleDiff;
          nearestSector = sector;
        }
      });
      
      nearestSector.customers.push(customer);
    });
  }
  
  return sectors;
}

function balanceSectorSizes(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('Balancing sector sizes...');
  
  const balancedSectors: CircularSector[] = [];
  let nextSectorId = Math.max(...sectors.map(s => s.id)) + 1;
  
  // Process each sector
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize && sector.customers.length <= maxSize) {
      // Sector is already optimal
      balancedSectors.push(sector);
    } else if (sector.customers.length > maxSize) {
      // Split oversized sector
      const splitSectors = splitOversizedSector(sector, maxSize, nextSectorId);
      balancedSectors.push(...splitSectors);
      nextSectorId += splitSectors.length;
    } else {
      // Store undersized sector for merging
      balancedSectors.push(sector);
    }
  });
  
  // Merge undersized sectors
  const finalSectors = mergeUndersizedSectors(balancedSectors, minSize, maxSize, nextSectorId);
  
  return finalSectors;
}

function splitOversizedSector(
  sector: CircularSector,
  maxSize: number,
  startId: number
): CircularSector[] {
  const customers = sector.customers;
  const numSplits = Math.ceil(customers.length / maxSize);
  
  console.log(`Splitting sector ${sector.id} (${customers.length} customers) into ${numSplits} parts`);
  
  // Sort customers by distance from center for radial splitting
  const sortedCustomers = [...customers].sort((a, b) => {
    const distA = calculateDistance(sector.center.latitude, sector.center.longitude, a.latitude, a.longitude);
    const distB = calculateDistance(sector.center.latitude, sector.center.longitude, b.latitude, b.longitude);
    return distA - distB;
  });
  
  const splitSectors: CircularSector[] = [];
  const customersPerSplit = Math.ceil(customers.length / numSplits);
  
  for (let i = 0; i < numSplits; i++) {
    const start = i * customersPerSplit;
    const end = Math.min(start + customersPerSplit, sortedCustomers.length);
    const splitCustomers = sortedCustomers.slice(start, end);
    
    if (splitCustomers.length > 0) {
      // Calculate new radius bounds
      const distances = splitCustomers.map(c => 
        calculateDistance(sector.center.latitude, sector.center.longitude, c.latitude, c.longitude)
      );
      
      splitSectors.push({
        id: startId + i,
        customers: splitCustomers,
        startAngle: sector.startAngle,
        endAngle: sector.endAngle,
        minRadius: Math.min(...distances),
        maxRadius: Math.max(...distances),
        center: sector.center
      });
    }
  }
  
  return splitSectors;
}

function mergeUndersizedSectors(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number,
  startId: number
): CircularSector[] {
  const undersizedSectors = sectors.filter(s => s.customers.length < minSize);
  const validSectors = sectors.filter(s => s.customers.length >= minSize);
  
  if (undersizedSectors.length === 0) {
    return sectors;
  }
  
  console.log(`Merging ${undersizedSectors.length} undersized sectors...`);
  
  // Sort undersized sectors by angle for adjacent merging
  undersizedSectors.sort((a, b) => {
    const midAngleA = (a.startAngle + a.endAngle) / 2;
    const midAngleB = (b.startAngle + b.endAngle) / 2;
    return midAngleA - midAngleB;
  });
  
  const mergedSectors: CircularSector[] = [...validSectors];
  let currentMerge: Customer[] = [];
  let mergeAngles: { start: number; end: number } = { start: 0, end: 0 };
  let sectorId = startId;
  
  undersizedSectors.forEach((sector, index) => {
    if (currentMerge.length + sector.customers.length <= maxSize) {
      // Add to current merge
      currentMerge.push(...sector.customers);
      
      if (currentMerge.length === sector.customers.length) {
        // First sector in merge
        mergeAngles.start = sector.startAngle;
        mergeAngles.end = sector.endAngle;
      } else {
        // Extend angle range
        mergeAngles.end = sector.endAngle;
      }
    } else {
      // Finalize current merge
      if (currentMerge.length >= minSize) {
        mergedSectors.push(createSectorFromCustomers(
          sectorId++,
          currentMerge,
          mergeAngles.start,
          mergeAngles.end,
          undersizedSectors[0].center
        ));
      }
      
      // Start new merge
      currentMerge = [...sector.customers];
      mergeAngles.start = sector.startAngle;
      mergeAngles.end = sector.endAngle;
    }
  });
  
  // Handle final merge
  if (currentMerge.length > 0) {
    if (currentMerge.length >= minSize) {
      mergedSectors.push(createSectorFromCustomers(
        sectorId++,
        currentMerge,
        mergeAngles.start,
        mergeAngles.end,
        undersizedSectors[0].center
      ));
    } else if (mergedSectors.length > 0) {
      // Add to last sector if possible
      const lastSector = mergedSectors[mergedSectors.length - 1];
      if (lastSector.customers.length + currentMerge.length <= maxSize) {
        lastSector.customers.push(...currentMerge);
        updateSectorBounds(lastSector);
      } else {
        mergedSectors.push(createSectorFromCustomers(
          sectorId++,
          currentMerge,
          mergeAngles.start,
          mergeAngles.end,
          undersizedSectors[0].center
        ));
      }
    }
  }
  
  return mergedSectors;
}

function createSectorFromCustomers(
  id: number,
  customers: Customer[],
  startAngle: number,
  endAngle: number,
  center: MedianCenter
): CircularSector {
  const distances = customers.map(c => 
    calculateDistance(center.latitude, center.longitude, c.latitude, c.longitude)
  );
  
  return {
    id,
    customers,
    startAngle,
    endAngle,
    minRadius: Math.min(...distances),
    maxRadius: Math.max(...distances),
    center
  };
}

function updateSectorBounds(sector: CircularSector): void {
  const distances = sector.customers.map(c => 
    calculateDistance(sector.center.latitude, sector.center.longitude, c.latitude, c.longitude)
  );
  
  sector.minRadius = Math.min(...distances);
  sector.maxRadius = Math.max(...distances);
}

function convertSectorsToClusters(sectors: CircularSector[]): ClusteredCustomer[] {
  const clusteredCustomers: ClusteredCustomer[] = [];
  
  sectors.forEach((sector, index) => {
    sector.customers.forEach(customer => {
      clusteredCustomers.push({
        ...customer,
        clusterId: index
      });
    });
  });
  
  return clusteredCustomers;
}

function validateClustering(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  minSize: number,
  maxSize: number
): { isValid: boolean; message: string } {
  // Check 1: All customers are assigned
  if (clusteredCustomers.length !== originalCustomers.length) {
    return {
      isValid: false,
      message: `Customer count mismatch: Input ${originalCustomers.length}, Output ${clusteredCustomers.length}`
    };
  }
  
  // Check 2: No duplicates
  const customerIds = clusteredCustomers.map(c => c.id);
  const uniqueIds = new Set(customerIds);
  if (customerIds.length !== uniqueIds.size) {
    return {
      isValid: false,
      message: `Duplicate customers detected`
    };
  }
  
  // Check 3: All original customers present
  const originalIds = new Set(originalCustomers.map(c => c.id));
  const clusteredIds = new Set(clusteredCustomers.map(c => c.id));
  
  const missingIds = Array.from(originalIds).filter(id => !clusteredIds.has(id));
  if (missingIds.length > 0) {
    return {
      isValid: false,
      message: `Missing customers: ${missingIds.length} customers not assigned`
    };
  }
  
  // Check 4: Cluster size constraints
  const clusterSizes = getClusterSizes(clusteredCustomers);
  const undersizedClusters = clusterSizes.filter(size => size < minSize);
  const oversizedClusters = clusterSizes.filter(size => size > maxSize);
  
  if (undersizedClusters.length > 0) {
    return {
      isValid: false,
      message: `Size violation: ${undersizedClusters.length} clusters below ${minSize} outlets`
    };
  }
  
  if (oversizedClusters.length > 0) {
    return {
      isValid: false,
      message: `Size violation: ${oversizedClusters.length} clusters above ${maxSize} outlets`
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

function circularSectorFallback(
  customers: Customer[],
  center: MedianCenter,
  minSize: number,
  maxSize: number
): ClusteredCustomer[] {
  console.log('Applying circular sector fallback clustering...');
  
  // Calculate polar coordinates for all customers
  const customersWithPolar = customers.map(customer => ({
    ...customer,
    angle: calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude),
    distance: calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude)
  }));
  
  // Sort by angle for circular distribution
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  // Calculate number of sectors needed
  const numSectors = Math.ceil(customers.length / maxSize);
  const customersPerSector = Math.ceil(customers.length / numSectors);
  
  return customersWithPolar.map((customer, index) => ({
    id: customer.id,
    latitude: customer.latitude,
    longitude: customer.longitude,
    outletName: customer.outletName,
    clusterId: Math.floor(index / customersPerSector)
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

function calculateAngle(centerLat: number, centerLon: number, pointLat: number, pointLon: number): number {
  const dLon = (pointLon - centerLon) * Math.PI / 180;
  const dLat = (pointLat - centerLat) * Math.PI / 180;
  
  let angle = Math.atan2(dLon, dLat);
  
  // Normalize to [0, 2π]
  if (angle < 0) {
    angle += 2 * Math.PI;
  }
  
  return angle;
}