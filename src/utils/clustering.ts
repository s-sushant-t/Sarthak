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

    // Fixed configuration: 6 clusters, 36 beats total (6 beats per cluster)
    const TARGET_CLUSTERS = 6;
    const TARGET_MIN_SIZE = 180;
    const TARGET_MAX_SIZE = 240;
    const EXPECTED_BEATS_PER_CLUSTER = 6;
    const TOTAL_EXPECTED_BEATS = 36;

    console.log(`Starting fixed clustering for ${customers.length} customers`);
    console.log(`Target: ${TARGET_CLUSTERS} clusters, ${EXPECTED_BEATS_PER_CLUSTER} beats per cluster`);
    console.log(`Cluster size range: ${TARGET_MIN_SIZE}-${TARGET_MAX_SIZE} outlets per cluster`);

    // Step 1: Find the median center point
    const medianCenter = calculateMedianCenter(customers);
    console.log('Median center:', medianCenter);

    // Step 2: Create exactly 6 circular sectors from the median center
    const sectors = createFixedCircularSectors(customers, medianCenter, TARGET_CLUSTERS);
    console.log(`Created ${sectors.length} circular sectors`);

    // Step 3: Balance sector sizes to meet requirements
    const balancedSectors = balanceToTargetSizes(sectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`Balanced to ${balancedSectors.length} final sectors`);

    // Step 4: Convert sectors to clusters
    const clusteredCustomers = convertSectorsToClusters(balancedSectors);

    // Step 5: Final validation
    const validationResult = validateFixedClustering(
      clusteredCustomers, 
      customers, 
      TARGET_CLUSTERS,
      TARGET_MIN_SIZE, 
      TARGET_MAX_SIZE
    );
    
    if (!validationResult.isValid) {
      console.warn(`Validation failed: ${validationResult.message}. Applying fallback...`);
      return fixedCircularSectorFallback(customers, medianCenter, TARGET_CLUSTERS, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ Fixed clustering result: ${clusterCount} clusters`);
    console.log('Cluster sizes:', clusterSizes);
    console.log('Expected beats per cluster:', clusterSizes.map(size => Math.ceil(size / 35))); // ~35 outlets per beat
    console.log('Total expected beats:', clusterSizes.reduce((total, size) => total + Math.ceil(size / 35), 0));

    return clusteredCustomers;

  } catch (error) {
    console.warn('Fixed clustering failed, using fallback:', error);
    const medianCenter = calculateMedianCenter(customers);
    return fixedCircularSectorFallback(customers, medianCenter, 6, 180, 240);
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

function createFixedCircularSectors(
  customers: Customer[],
  center: MedianCenter,
  targetClusters: number
): CircularSector[] {
  console.log(`Creating exactly ${targetClusters} circular sectors from median center...`);
  
  // Calculate polar coordinates for each customer
  const customersWithPolar = customers.map(customer => ({
    ...customer,
    distance: calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude),
    angle: calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude)
  }));
  
  // Sort by angle for sector creation
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  const sectors: CircularSector[] = [];
  const angleStep = (2 * Math.PI) / targetClusters; // Divide 360° by target clusters
  
  console.log(`Creating ${targetClusters} sectors with ${(angleStep * 180 / Math.PI).toFixed(1)}° each`);
  
  for (let i = 0; i < targetClusters; i++) {
    const startAngle = i * angleStep;
    const endAngle = (i + 1) * angleStep;
    
    // Find customers in this angular sector
    const sectorCustomers = customersWithPolar.filter(customer => {
      let angle = customer.angle;
      
      // Handle angle wraparound at 2π (for the last sector)
      if (i === targetClusters - 1 && endAngle >= 2 * Math.PI) {
        return angle >= startAngle || angle <= (endAngle - 2 * Math.PI);
      } else {
        return angle >= startAngle && angle < endAngle;
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
      
      console.log(`Sector ${i}: ${sectorCustomers.length} customers, angles ${(startAngle * 180 / Math.PI).toFixed(1)}° - ${(endAngle * 180 / Math.PI).toFixed(1)}°`);
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
        
        if (angleDiff < minAngleDiff) {
          minAngleDiff = angleDiff;
          nearestSector = sector;
        }
      });
      
      nearestSector.customers.push(customer);
    });
  }
  
  return sectors;
}

function balanceToTargetSizes(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('Balancing sectors to target sizes...');
  
  const balancedSectors: CircularSector[] = [...sectors];
  let iterations = 0;
  const maxIterations = 10;
  
  while (iterations < maxIterations) {
    let needsRebalancing = false;
    
    // Check if any sector violates size constraints
    for (let i = 0; i < balancedSectors.length; i++) {
      const sector = balancedSectors[i];
      
      if (sector.customers.length > maxSize) {
        // Find a sector with fewer customers to transfer to
        const targetSector = balancedSectors.find((s, idx) => 
          idx !== i && s.customers.length < maxSize
        );
        
        if (targetSector) {
          // Transfer customers from oversized to undersized sector
          const excessCount = sector.customers.length - maxSize;
          const transferCount = Math.min(
            excessCount,
            maxSize - targetSector.customers.length
          );
          
          if (transferCount > 0) {
            // Transfer customers that are closest to the target sector
            const customersToTransfer = findClosestCustomers(
              sector.customers,
              targetSector.center,
              transferCount
            );
            
            // Remove from source sector
            sector.customers = sector.customers.filter(c => 
              !customersToTransfer.some(tc => tc.id === c.id)
            );
            
            // Add to target sector
            targetSector.customers.push(...customersToTransfer);
            
            updateSectorBounds(sector);
            updateSectorBounds(targetSector);
            
            needsRebalancing = true;
            console.log(`Transferred ${transferCount} customers from sector ${sector.id} to sector ${targetSector.id}`);
          }
        }
      }
    }
    
    if (!needsRebalancing) {
      break;
    }
    
    iterations++;
  }
  
  // Final size report
  balancedSectors.forEach(sector => {
    console.log(`Final sector ${sector.id}: ${sector.customers.length} customers`);
  });
  
  return balancedSectors;
}

function findClosestCustomers(
  customers: Customer[],
  targetCenter: MedianCenter,
  count: number
): Customer[] {
  // Calculate distances to target center and sort
  const customersWithDistance = customers.map(customer => ({
    customer,
    distance: calculateDistance(
      targetCenter.latitude,
      targetCenter.longitude,
      customer.latitude,
      customer.longitude
    )
  }));
  
  customersWithDistance.sort((a, b) => a.distance - b.distance);
  
  return customersWithDistance.slice(0, count).map(item => item.customer);
}

function updateSectorBounds(sector: CircularSector): void {
  if (sector.customers.length === 0) return;
  
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

function validateFixedClustering(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  targetClusters: number,
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
  
  // Check 5: Cluster size constraints
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

function fixedCircularSectorFallback(
  customers: Customer[],
  center: MedianCenter,
  targetClusters: number,
  minSize: number,
  maxSize: number
): ClusteredCustomer[] {
  console.log(`Applying fixed circular sector fallback for ${targetClusters} clusters...`);
  
  // Calculate polar coordinates for all customers
  const customersWithPolar = customers.map(customer => ({
    ...customer,
    angle: calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude),
    distance: calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude)
  }));
  
  // Sort by angle for circular distribution
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  // Distribute customers evenly across target clusters
  const customersPerCluster = Math.ceil(customers.length / targetClusters);
  
  return customersWithPolar.map((customer, index) => ({
    id: customer.id,
    latitude: customer.latitude,
    longitude: customer.longitude,
    outletName: customer.outletName,
    clusterId: Math.floor(index / customersPerCluster) % targetClusters
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