import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

// Sales constraints
const MIN_GR1_SALE = 600000;
const MIN_GR2_SALE = 250000;

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    const TARGET_MIN_SIZE = 180;
    const TARGET_MAX_SIZE = 240;

    console.log(`Starting sales-constrained circular sector clustering for ${customers.length} customers`);
    console.log(`Constraints: ${TARGET_MIN_SIZE}-${TARGET_MAX_SIZE} outlets, GR1≥${MIN_GR1_SALE.toLocaleString()}, GR2≥${MIN_GR2_SALE.toLocaleString()}`);

    // Step 1: Find the median center point
    const medianCenter = calculateMedianCenter(customers);
    console.log('Median center:', medianCenter);

    // Step 2: Create initial circular sectors
    const initialSectors = createCircularSectors(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`Created ${initialSectors.length} initial circular sectors`);

    // Step 3: Apply sales constraints and rebalance
    const salesValidatedSectors = applySalesConstraints(initialSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`Sales validation complete: ${salesValidatedSectors.length} sectors meet sales requirements`);

    // Step 4: Final size balancing
    const balancedSectors = balanceSectorSizes(salesValidatedSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`Final balancing complete: ${balancedSectors.length} sectors`);

    // Step 5: Convert sectors to clusters
    const clusteredCustomers = convertSectorsToClusters(balancedSectors);

    // Step 6: Final validation
    const validationResult = validateClustering(clusteredCustomers, customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    
    if (!validationResult.isValid) {
      console.warn(`Validation failed: ${validationResult.message}. Applying fallback...`);
      return salesConstrainedFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    // Step 7: Validate sales constraints
    const salesValidation = validateSalesConstraints(clusteredCustomers);
    if (!salesValidation.isValid) {
      console.warn(`Sales validation failed: ${salesValidation.message}. Applying sales fallback...`);
      return salesConstrainedFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ Sales-constrained clustering result: ${clusterCount} sectors`);
    console.log('Sector sizes:', clusterSizes);
    console.log('Sales validation:', salesValidation.details);

    return clusteredCustomers;

  } catch (error) {
    console.warn('Sales-constrained clustering failed, using fallback:', error);
    const medianCenter = calculateMedianCenter(customers);
    return salesConstrainedFallback(customers, medianCenter, 180, 240);
  }
};

interface MedianCenter {
  latitude: number;
  longitude: number;
}

interface CircularSector {
  id: number;
  customers: Customer[];
  startAngle: number;
  endAngle: number;
  minRadius: number;
  maxRadius: number;
  center: MedianCenter;
  gr1Total: number;
  gr2Total: number;
}

interface SalesValidation {
  isValid: boolean;
  message: string;
  details?: string[];
}

function calculateMedianCenter(customers: Customer[]): MedianCenter {
  console.log('Calculating median center point...');
  
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
  
  const customersWithPolar = customers.map(customer => ({
    ...customer,
    distance: calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude),
    angle: calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude)
  }));
  
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  const totalCustomers = customers.length;
  const optimalSectorCount = Math.ceil(totalCustomers / maxSize);
  
  console.log(`Creating ${optimalSectorCount} sectors with sales constraints`);
  
  const sectors: CircularSector[] = [];
  const angleStep = (2 * Math.PI) / optimalSectorCount;
  
  for (let i = 0; i < optimalSectorCount; i++) {
    const startAngle = i * angleStep;
    const endAngle = (i + 1) * angleStep;
    
    const sectorCustomers = customersWithPolar.filter(customer => {
      let angle = customer.angle;
      
      if (startAngle > endAngle) {
        return angle >= startAngle || angle <= endAngle;
      } else {
        return angle >= startAngle && angle <= endAngle;
      }
    });
    
    if (sectorCustomers.length > 0) {
      const distances = sectorCustomers.map(c => c.distance);
      const gr1Total = sectorCustomers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
      const gr2Total = sectorCustomers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
      
      sectors.push({
        id: i,
        customers: sectorCustomers.map(({ distance, angle, ...customer }) => customer),
        startAngle,
        endAngle,
        minRadius: Math.min(...distances),
        maxRadius: Math.max(...distances),
        center,
        gr1Total,
        gr2Total
      });
    }
  }
  
  return sectors;
}

function applySalesConstraints(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('Applying sales constraints to sectors...');
  
  const validSectors: CircularSector[] = [];
  const invalidSectors: CircularSector[] = [];
  
  // Separate sectors that meet sales constraints from those that don't
  sectors.forEach(sector => {
    if (sector.gr1Total >= MIN_GR1_SALE && sector.gr2Total >= MIN_GR2_SALE) {
      validSectors.push(sector);
      console.log(`Sector ${sector.id}: ✅ GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
    } else {
      invalidSectors.push(sector);
      console.log(`Sector ${sector.id}: ❌ GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
    }
  });
  
  // Redistribute customers from invalid sectors
  if (invalidSectors.length > 0) {
    console.log(`Redistributing customers from ${invalidSectors.length} sectors that don't meet sales constraints...`);
    
    const unassignedCustomers = invalidSectors.flatMap(sector => sector.customers);
    
    // Try to merge invalid sectors with adjacent valid sectors
    unassignedCustomers.forEach(customer => {
      let bestSector: CircularSector | null = null;
      let minDistance = Infinity;
      
      // Find the nearest valid sector that can accommodate this customer
      validSectors.forEach(sector => {
        if (sector.customers.length < maxSize) {
          const distance = calculateDistance(
            sector.center.latitude,
            sector.center.longitude,
            customer.latitude,
            customer.longitude
          );
          
          if (distance < minDistance) {
            minDistance = distance;
            bestSector = sector;
          }
        }
      });
      
      if (bestSector) {
        bestSector.customers.push(customer);
        bestSector.gr1Total += customer.gr1Sale || 0;
        bestSector.gr2Total += customer.gr2Sale || 0;
        updateSectorBounds(bestSector);
      } else {
        // Create new sector if no existing sector can accommodate
        const newSector: CircularSector = {
          id: Math.max(...validSectors.map(s => s.id)) + 1,
          customers: [customer],
          startAngle: 0,
          endAngle: 2 * Math.PI,
          minRadius: 0,
          maxRadius: 0,
          center: sectors[0].center,
          gr1Total: customer.gr1Sale || 0,
          gr2Total: customer.gr2Sale || 0
        };
        updateSectorBounds(newSector);
        validSectors.push(newSector);
      }
    });
  }
  
  // Now try to merge sectors that still don't meet sales constraints
  const finalSectors: CircularSector[] = [];
  let nextSectorId = Math.max(...validSectors.map(s => s.id)) + 1;
  
  validSectors.forEach(sector => {
    if (sector.gr1Total >= MIN_GR1_SALE && sector.gr2Total >= MIN_GR2_SALE) {
      finalSectors.push(sector);
    } else {
      // Try to merge with an existing final sector
      let merged = false;
      
      for (const finalSector of finalSectors) {
        if (finalSector.customers.length + sector.customers.length <= maxSize) {
          const combinedGR1 = finalSector.gr1Total + sector.gr1Total;
          const combinedGR2 = finalSector.gr2Total + sector.gr2Total;
          
          if (combinedGR1 >= MIN_GR1_SALE && combinedGR2 >= MIN_GR2_SALE) {
            finalSector.customers.push(...sector.customers);
            finalSector.gr1Total = combinedGR1;
            finalSector.gr2Total = combinedGR2;
            updateSectorBounds(finalSector);
            merged = true;
            break;
          }
        }
      }
      
      if (!merged) {
        finalSectors.push(sector);
      }
    }
  });
  
  return finalSectors;
}

function balanceSectorSizes(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('Balancing sector sizes while maintaining sales constraints...');
  
  const balancedSectors: CircularSector[] = [];
  let nextSectorId = Math.max(...sectors.map(s => s.id)) + 1;
  
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize && sector.customers.length <= maxSize) {
      balancedSectors.push(sector);
    } else if (sector.customers.length > maxSize) {
      const splitSectors = splitOversizedSectorWithSales(sector, maxSize, nextSectorId);
      balancedSectors.push(...splitSectors);
      nextSectorId += splitSectors.length;
    } else {
      balancedSectors.push(sector);
    }
  });
  
  const finalSectors = mergeUndersizedSectorsWithSales(balancedSectors, minSize, maxSize, nextSectorId);
  return finalSectors;
}

function splitOversizedSectorWithSales(
  sector: CircularSector,
  maxSize: number,
  startId: number
): CircularSector[] {
  const customers = sector.customers;
  const numSplits = Math.ceil(customers.length / maxSize);
  
  console.log(`Splitting sector ${sector.id} (${customers.length} customers) into ${numSplits} parts with sales validation`);
  
  // Sort customers by sales contribution for balanced splitting
  const sortedCustomers = [...customers].sort((a, b) => {
    const aTotal = (a.gr1Sale || 0) + (a.gr2Sale || 0);
    const bTotal = (b.gr1Sale || 0) + (b.gr2Sale || 0);
    return bTotal - aTotal; // Descending order
  });
  
  const splitSectors: CircularSector[] = [];
  const customersPerSplit = Math.ceil(customers.length / numSplits);
  
  for (let i = 0; i < numSplits; i++) {
    const start = i * customersPerSplit;
    const end = Math.min(start + customersPerSplit, sortedCustomers.length);
    const splitCustomers = sortedCustomers.slice(start, end);
    
    if (splitCustomers.length > 0) {
      const gr1Total = splitCustomers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
      const gr2Total = splitCustomers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
      
      const newSector: CircularSector = {
        id: startId + i,
        customers: splitCustomers,
        startAngle: sector.startAngle,
        endAngle: sector.endAngle,
        minRadius: 0,
        maxRadius: 0,
        center: sector.center,
        gr1Total,
        gr2Total
      };
      
      updateSectorBounds(newSector);
      splitSectors.push(newSector);
    }
  }
  
  return splitSectors;
}

function mergeUndersizedSectorsWithSales(
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
  
  console.log(`Merging ${undersizedSectors.length} undersized sectors with sales constraints...`);
  
  const mergedSectors: CircularSector[] = [...validSectors];
  let currentMerge: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  let sectorId = startId;
  
  undersizedSectors.forEach((sector, index) => {
    const potentialGR1 = currentGR1 + sector.gr1Total;
    const potentialGR2 = currentGR2 + sector.gr2Total;
    const potentialSize = currentMerge.length + sector.customers.length;
    
    if (potentialSize <= maxSize) {
      currentMerge.push(...sector.customers);
      currentGR1 = potentialGR1;
      currentGR2 = potentialGR2;
    } else {
      // Finalize current merge if it meets requirements
      if (currentMerge.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
        const newSector = createSectorFromCustomersWithSales(
          sectorId++,
          currentMerge,
          0,
          2 * Math.PI,
          undersizedSectors[0].center
        );
        mergedSectors.push(newSector);
      }
      
      // Start new merge
      currentMerge = [...sector.customers];
      currentGR1 = sector.gr1Total;
      currentGR2 = sector.gr2Total;
    }
  });
  
  // Handle final merge
  if (currentMerge.length > 0) {
    if (currentMerge.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
      const newSector = createSectorFromCustomersWithSales(
        sectorId++,
        currentMerge,
        0,
        2 * Math.PI,
        undersizedSectors[0].center
      );
      mergedSectors.push(newSector);
    } else if (mergedSectors.length > 0) {
      // Try to add to last sector
      const lastSector = mergedSectors[mergedSectors.length - 1];
      if (lastSector.customers.length + currentMerge.length <= maxSize) {
        lastSector.customers.push(...currentMerge);
        lastSector.gr1Total += currentGR1;
        lastSector.gr2Total += currentGR2;
        updateSectorBounds(lastSector);
      }
    }
  }
  
  return mergedSectors;
}

function createSectorFromCustomersWithSales(
  id: number,
  customers: Customer[],
  startAngle: number,
  endAngle: number,
  center: MedianCenter
): CircularSector {
  const gr1Total = customers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
  const gr2Total = customers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
  
  const sector: CircularSector = {
    id,
    customers,
    startAngle,
    endAngle,
    minRadius: 0,
    maxRadius: 0,
    center,
    gr1Total,
    gr2Total
  };
  
  updateSectorBounds(sector);
  return sector;
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

function validateClustering(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  minSize: number,
  maxSize: number
): { isValid: boolean; message: string } {
  if (clusteredCustomers.length !== originalCustomers.length) {
    return {
      isValid: false,
      message: `Customer count mismatch: Input ${originalCustomers.length}, Output ${clusteredCustomers.length}`
    };
  }
  
  const customerIds = clusteredCustomers.map(c => c.id);
  const uniqueIds = new Set(customerIds);
  if (customerIds.length !== uniqueIds.size) {
    return {
      isValid: false,
      message: `Duplicate customers detected`
    };
  }
  
  const originalIds = new Set(originalCustomers.map(c => c.id));
  const clusteredIds = new Set(clusteredCustomers.map(c => c.id));
  
  const missingIds = Array.from(originalIds).filter(id => !clusteredIds.has(id));
  if (missingIds.length > 0) {
    return {
      isValid: false,
      message: `Missing customers: ${missingIds.length} customers not assigned`
    };
  }
  
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

function validateSalesConstraints(clusteredCustomers: ClusteredCustomer[]): SalesValidation {
  const clusterSales = new Map<number, { gr1: number; gr2: number; count: number }>();
  
  clusteredCustomers.forEach(customer => {
    const existing = clusterSales.get(customer.clusterId) || { gr1: 0, gr2: 0, count: 0 };
    clusterSales.set(customer.clusterId, {
      gr1: existing.gr1 + (customer.gr1Sale || 0),
      gr2: existing.gr2 + (customer.gr2Sale || 0),
      count: existing.count + 1
    });
  });
  
  const violations: string[] = [];
  const details: string[] = [];
  
  clusterSales.forEach((sales, clusterId) => {
    const gr1Valid = sales.gr1 >= MIN_GR1_SALE;
    const gr2Valid = sales.gr2 >= MIN_GR2_SALE;
    
    details.push(
      `Cluster ${clusterId}: ${sales.count} outlets, GR1=${sales.gr1.toLocaleString()}, GR2=${sales.gr2.toLocaleString()} ${gr1Valid && gr2Valid ? '✅' : '❌'}`
    );
    
    if (!gr1Valid) {
      violations.push(`Cluster ${clusterId} GR1 sales ${sales.gr1.toLocaleString()} < ${MIN_GR1_SALE.toLocaleString()}`);
    }
    if (!gr2Valid) {
      violations.push(`Cluster ${clusterId} GR2 sales ${sales.gr2.toLocaleString()} < ${MIN_GR2_SALE.toLocaleString()}`);
    }
  });
  
  return {
    isValid: violations.length === 0,
    message: violations.length > 0 ? violations.join('; ') : 'All clusters meet sales constraints',
    details
  };
}

function getClusterSizes(customers: ClusteredCustomer[]): number[] {
  const clusterMap = new Map<number, number>();
  
  customers.forEach(customer => {
    clusterMap.set(customer.clusterId, (clusterMap.get(customer.clusterId) || 0) + 1);
  });
  
  return Array.from(clusterMap.values()).sort((a, b) => a - b);
}

function salesConstrainedFallback(
  customers: Customer[],
  center: MedianCenter,
  minSize: number,
  maxSize: number
): ClusteredCustomer[] {
  console.log('Applying sales-constrained fallback clustering...');
  
  // Sort customers by total sales (descending) for better distribution
  const sortedCustomers = [...customers].sort((a, b) => {
    const aTotal = (a.gr1Sale || 0) + (a.gr2Sale || 0);
    const bTotal = (b.gr1Sale || 0) + (b.gr2Sale || 0);
    return bTotal - aTotal;
  });
  
  const clusters: Customer[][] = [];
  let currentCluster: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  
  sortedCustomers.forEach(customer => {
    const potentialGR1 = currentGR1 + (customer.gr1Sale || 0);
    const potentialGR2 = currentGR2 + (customer.gr2Sale || 0);
    
    if (currentCluster.length < maxSize && 
        (currentCluster.length < minSize || 
         (potentialGR1 >= MIN_GR1_SALE && potentialGR2 >= MIN_GR2_SALE))) {
      currentCluster.push(customer);
      currentGR1 = potentialGR1;
      currentGR2 = potentialGR2;
    } else {
      if (currentCluster.length >= minSize) {
        clusters.push(currentCluster);
      }
      currentCluster = [customer];
      currentGR1 = customer.gr1Sale || 0;
      currentGR2 = customer.gr2Sale || 0;
    }
  });
  
  if (currentCluster.length > 0) {
    if (currentCluster.length >= minSize) {
      clusters.push(currentCluster);
    } else if (clusters.length > 0) {
      clusters[clusters.length - 1].push(...currentCluster);
    } else {
      clusters.push(currentCluster);
    }
  }
  
  return clusters.flatMap((cluster, clusterIndex) =>
    cluster.map(customer => ({
      ...customer,
      clusterId: clusterIndex
    }))
  );
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
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
  
  if (angle < 0) {
    angle += 2 * Math.PI;
  }
  
  return angle;
}