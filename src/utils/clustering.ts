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

    console.log(`🎯 Starting circular sector clustering from median center for ${customers.length} customers`);
    console.log(`📊 Constraints: ${TARGET_MIN_SIZE}-${TARGET_MAX_SIZE} outlets, GR1≥${MIN_GR1_SALE.toLocaleString()}, GR2≥${MIN_GR2_SALE.toLocaleString()}`);

    // Step 1: Calculate the median center point as the clustering origin
    const medianCenter = calculateMedianCenter(customers);
    console.log('📍 Median center calculated:', medianCenter);

    // Step 2: Create circular sectors radiating from median center
    const circularSectors = createCircularSectorsFromMedian(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`🔄 Created ${circularSectors.length} circular sectors from median center`);

    // Step 3: Apply sales constraints while maintaining circular structure
    const salesValidatedSectors = applySalesConstraintsToSectors(circularSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`💰 Sales validation complete: ${salesValidatedSectors.length} sectors meet requirements`);

    // Step 4: Final balancing while preserving circular geometry
    const balancedSectors = balanceCircularSectors(salesValidatedSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`⚖️ Circular sector balancing complete: ${balancedSectors.length} sectors`);

    // Step 5: Convert sectors to clustered customers
    const clusteredCustomers = convertSectorsToCustomers(balancedSectors);

    // Step 6: Comprehensive validation
    const validationResult = validateCircularClustering(clusteredCustomers, customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    
    if (!validationResult.isValid) {
      console.warn(`❌ Validation failed: ${validationResult.message}. Applying circular fallback...`);
      return circularSectorFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    // Step 7: Validate sales constraints
    const salesValidation = validateSalesConstraints(clusteredCustomers);
    if (!salesValidation.isValid) {
      console.warn(`💰 Sales validation failed: ${salesValidation.message}. Applying sales-aware fallback...`);
      return circularSectorFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ Circular sector clustering successful: ${clusterCount} sectors`);
    console.log('📏 Sector sizes:', clusterSizes);
    console.log('💰 Sales validation:', salesValidation.details);

    return clusteredCustomers;

  } catch (error) {
    console.warn('🚨 Circular sector clustering failed, using fallback:', error);
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
  startAngle: number;
  endAngle: number;
  minRadius: number;
  maxRadius: number;
  center: MedianCenter;
  gr1Total: number;
  gr2Total: number;
  avgRadius: number;
}

interface SalesValidation {
  isValid: boolean;
  message: string;
  details?: string[];
}

function calculateMedianCenter(customers: Customer[]): MedianCenter {
  console.log('📍 Calculating median center as clustering origin...');
  
  // Sort customers by latitude and longitude separately
  const sortedByLat = [...customers].sort((a, b) => a.latitude - b.latitude);
  const sortedByLng = [...customers].sort((a, b) => a.longitude - b.longitude);
  
  // Calculate true median for both coordinates
  const medianLat = sortedByLat.length % 2 === 0
    ? (sortedByLat[sortedByLat.length / 2 - 1].latitude + sortedByLat[sortedByLat.length / 2].latitude) / 2
    : sortedByLat[Math.floor(sortedByLat.length / 2)].latitude;
    
  const medianLng = sortedByLng.length % 2 === 0
    ? (sortedByLng[sortedByLng.length / 2 - 1].longitude + sortedByLng[sortedByLng.length / 2].longitude) / 2
    : sortedByLng[Math.floor(sortedByLng.length / 2)].longitude;
  
  const center = {
    latitude: medianLat,
    longitude: medianLng
  };
  
  console.log(`📍 Median center: (${center.latitude.toFixed(6)}, ${center.longitude.toFixed(6)})`);
  return center;
}

function createCircularSectorsFromMedian(
  customers: Customer[],
  center: MedianCenter,
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('🔄 Creating circular sectors radiating from median center...');
  
  // Convert all customers to polar coordinates relative to median center
  const customersWithPolar = customers.map(customer => {
    const distance = calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude);
    const angle = calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude);
    
    return {
      ...customer,
      distance,
      angle: normalizeAngle(angle)
    };
  });
  
  // Sort by angle to create proper circular sectors
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  // Calculate optimal number of sectors based on size constraints
  const totalCustomers = customers.length;
  const optimalSectorCount = Math.max(1, Math.ceil(totalCustomers / maxSize));
  const angleStep = (2 * Math.PI) / optimalSectorCount;
  
  console.log(`🔄 Creating ${optimalSectorCount} circular sectors with ${angleStep.toFixed(3)} radians per sector`);
  
  const sectors: CircularSector[] = [];
  
  for (let i = 0; i < optimalSectorCount; i++) {
    const startAngle = i * angleStep;
    const endAngle = ((i + 1) * angleStep) % (2 * Math.PI);
    
    // Filter customers that fall within this angular sector
    const sectorCustomers = customersWithPolar.filter(customer => {
      return isAngleInSector(customer.angle, startAngle, endAngle);
    });
    
    if (sectorCustomers.length > 0) {
      const distances = sectorCustomers.map(c => c.distance);
      const gr1Total = sectorCustomers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
      const gr2Total = sectorCustomers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
      const avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
      
      sectors.push({
        id: i,
        customers: sectorCustomers.map(({ distance, angle, ...customer }) => customer),
        startAngle,
        endAngle,
        minRadius: Math.min(...distances),
        maxRadius: Math.max(...distances),
        center,
        gr1Total,
        gr2Total,
        avgRadius
      });
      
      console.log(`🔄 Sector ${i}: ${sectorCustomers.length} customers, angles ${startAngle.toFixed(3)}-${endAngle.toFixed(3)}, radius ${avgRadius.toFixed(2)}km`);
    }
  }
  
  return sectors;
}

function applySalesConstraintsToSectors(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('💰 Applying sales constraints to circular sectors...');
  
  const validSectors: CircularSector[] = [];
  const invalidSectors: CircularSector[] = [];
  
  // Classify sectors based on sales constraints
  sectors.forEach(sector => {
    const meetsGR1 = sector.gr1Total >= MIN_GR1_SALE;
    const meetsGR2 = sector.gr2Total >= MIN_GR2_SALE;
    
    if (meetsGR1 && meetsGR2) {
      validSectors.push(sector);
      console.log(`💰 Sector ${sector.id}: ✅ Sales valid - GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
    } else {
      invalidSectors.push(sector);
      console.log(`💰 Sector ${sector.id}: ❌ Sales invalid - GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
    }
  });
  
  // Redistribute customers from invalid sectors to adjacent valid sectors
  if (invalidSectors.length > 0) {
    console.log(`🔄 Redistributing customers from ${invalidSectors.length} sales-invalid sectors...`);
    
    invalidSectors.forEach(invalidSector => {
      const unassignedCustomers = [...invalidSector.customers];
      
      // Find adjacent sectors (by angle) that can accommodate customers
      unassignedCustomers.forEach(customer => {
        let bestSector: CircularSector | null = null;
        let minAngularDistance = Infinity;
        
        // Find the closest valid sector by angular distance
        validSectors.forEach(validSector => {
          if (validSector.customers.length < maxSize) {
            const customerAngle = calculateAngle(
              invalidSector.center.latitude,
              invalidSector.center.longitude,
              customer.latitude,
              customer.longitude
            );
            
            const angularDistance = Math.min(
              Math.abs(customerAngle - validSector.startAngle),
              Math.abs(customerAngle - validSector.endAngle),
              2 * Math.PI - Math.abs(customerAngle - validSector.startAngle),
              2 * Math.PI - Math.abs(customerAngle - validSector.endAngle)
            );
            
            if (angularDistance < minAngularDistance) {
              minAngularDistance = angularDistance;
              bestSector = validSector;
            }
          }
        });
        
        if (bestSector) {
          bestSector.customers.push(customer);
          bestSector.gr1Total += customer.gr1Sale || 0;
          bestSector.gr2Total += customer.gr2Sale || 0;
          updateSectorBounds(bestSector);
          console.log(`🔄 Moved customer ${customer.id} to adjacent sector ${bestSector.id}`);
        } else {
          // Create new sector if no existing sector can accommodate
          const newSector = createNewCircularSector(
            [customer],
            invalidSector.center,
            Math.max(...validSectors.map(s => s.id)) + 1
          );
          validSectors.push(newSector);
          console.log(`🆕 Created new sector ${newSector.id} for unassigned customer`);
        }
      });
    });
  }
  
  return validSectors;
}

function balanceCircularSectors(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('⚖️ Balancing circular sector sizes while maintaining geometry...');
  
  const balancedSectors: CircularSector[] = [];
  let nextSectorId = Math.max(...sectors.map(s => s.id)) + 1;
  
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize && sector.customers.length <= maxSize) {
      balancedSectors.push(sector);
      console.log(`⚖️ Sector ${sector.id}: Size ${sector.customers.length} - within bounds`);
    } else if (sector.customers.length > maxSize) {
      // Split oversized sectors while maintaining circular structure
      const splitSectors = splitCircularSector(sector, maxSize, nextSectorId);
      balancedSectors.push(...splitSectors);
      nextSectorId += splitSectors.length;
      console.log(`⚖️ Split sector ${sector.id} into ${splitSectors.length} sectors`);
    } else {
      // Keep undersized sectors for merging
      balancedSectors.push(sector);
      console.log(`⚖️ Sector ${sector.id}: Size ${sector.customers.length} - undersized, will merge`);
    }
  });
  
  // Merge undersized sectors with adjacent sectors
  const finalSectors = mergeAdjacentUndersizedSectors(balancedSectors, minSize, maxSize, nextSectorId);
  return finalSectors;
}

function splitCircularSector(
  sector: CircularSector,
  maxSize: number,
  startId: number
): CircularSector[] {
  const customers = sector.customers;
  const numSplits = Math.ceil(customers.length / maxSize);
  
  console.log(`🔄 Splitting circular sector ${sector.id} (${customers.length} customers) into ${numSplits} sub-sectors`);
  
  // Sort customers by angle within the sector for proper circular splitting
  const customersWithAngles = customers.map(customer => ({
    ...customer,
    angle: calculateAngle(sector.center.latitude, sector.center.longitude, customer.latitude, customer.longitude)
  }));
  
  customersWithAngles.sort((a, b) => a.angle - b.angle);
  
  const splitSectors: CircularSector[] = [];
  const customersPerSplit = Math.ceil(customers.length / numSplits);
  const angleRange = sector.endAngle - sector.startAngle;
  const anglePerSplit = angleRange / numSplits;
  
  for (let i = 0; i < numSplits; i++) {
    const start = i * customersPerSplit;
    const end = Math.min(start + customersPerSplit, customersWithAngles.length);
    const splitCustomers = customersWithAngles.slice(start, end);
    
    if (splitCustomers.length > 0) {
      const subSectorStartAngle = sector.startAngle + (i * anglePerSplit);
      const subSectorEndAngle = sector.startAngle + ((i + 1) * anglePerSplit);
      
      const newSector = createCircularSectorFromCustomers(
        startId + i,
        splitCustomers.map(({ angle, ...customer }) => customer),
        subSectorStartAngle,
        subSectorEndAngle,
        sector.center
      );
      
      splitSectors.push(newSector);
      console.log(`🔄 Sub-sector ${newSector.id}: ${newSector.customers.length} customers, angles ${subSectorStartAngle.toFixed(3)}-${subSectorEndAngle.toFixed(3)}`);
    }
  }
  
  return splitSectors;
}

function mergeAdjacentUndersizedSectors(
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
  
  console.log(`🔄 Merging ${undersizedSectors.length} undersized sectors with adjacent sectors...`);
  
  // Sort undersized sectors by angle for proper adjacency
  undersizedSectors.sort((a, b) => a.startAngle - b.startAngle);
  
  const mergedSectors: CircularSector[] = [...validSectors];
  let currentMerge: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  let mergeStartAngle = 0;
  let mergeEndAngle = 0;
  let sectorId = startId;
  
  undersizedSectors.forEach((sector, index) => {
    const potentialGR1 = currentGR1 + sector.gr1Total;
    const potentialGR2 = currentGR2 + sector.gr2Total;
    const potentialSize = currentMerge.length + sector.customers.length;
    
    if (potentialSize <= maxSize) {
      if (currentMerge.length === 0) {
        mergeStartAngle = sector.startAngle;
      }
      
      currentMerge.push(...sector.customers);
      currentGR1 = potentialGR1;
      currentGR2 = potentialGR2;
      mergeEndAngle = sector.endAngle;
    } else {
      // Finalize current merge if it meets requirements
      if (currentMerge.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
        const mergedSector = createCircularSectorFromCustomers(
          sectorId++,
          currentMerge,
          mergeStartAngle,
          mergeEndAngle,
          sector.center
        );
        mergedSectors.push(mergedSector);
        console.log(`🔄 Merged sector ${mergedSector.id}: ${mergedSector.customers.length} customers`);
      }
      
      // Start new merge
      currentMerge = [...sector.customers];
      currentGR1 = sector.gr1Total;
      currentGR2 = sector.gr2Total;
      mergeStartAngle = sector.startAngle;
      mergeEndAngle = sector.endAngle;
    }
  });
  
  // Handle final merge
  if (currentMerge.length > 0) {
    if (currentMerge.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
      const mergedSector = createCircularSectorFromCustomers(
        sectorId++,
        currentMerge,
        mergeStartAngle,
        mergeEndAngle,
        undersizedSectors[0].center
      );
      mergedSectors.push(mergedSector);
      console.log(`🔄 Final merged sector ${mergedSector.id}: ${mergedSector.customers.length} customers`);
    } else if (mergedSectors.length > 0) {
      // Add to nearest existing sector
      const nearestSector = findNearestSectorByAngle(mergedSectors, mergeStartAngle);
      if (nearestSector && nearestSector.customers.length + currentMerge.length <= maxSize) {
        nearestSector.customers.push(...currentMerge);
        nearestSector.gr1Total += currentGR1;
        nearestSector.gr2Total += currentGR2;
        updateSectorBounds(nearestSector);
        console.log(`🔄 Added remaining customers to nearest sector ${nearestSector.id}`);
      }
    }
  }
  
  return mergedSectors;
}

function createNewCircularSector(
  customers: Customer[],
  center: MedianCenter,
  id: number
): CircularSector {
  const gr1Total = customers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
  const gr2Total = customers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
  
  const sector: CircularSector = {
    id,
    customers,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    minRadius: 0,
    maxRadius: 0,
    center,
    gr1Total,
    gr2Total,
    avgRadius: 0
  };
  
  updateSectorBounds(sector);
  return sector;
}

function createCircularSectorFromCustomers(
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
    gr2Total,
    avgRadius: 0
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
  sector.avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
}

function findNearestSectorByAngle(sectors: CircularSector[], targetAngle: number): CircularSector | null {
  if (sectors.length === 0) return null;
  
  let nearestSector = sectors[0];
  let minAngularDistance = Infinity;
  
  sectors.forEach(sector => {
    const sectorMidAngle = (sector.startAngle + sector.endAngle) / 2;
    const angularDistance = Math.min(
      Math.abs(targetAngle - sectorMidAngle),
      2 * Math.PI - Math.abs(targetAngle - sectorMidAngle)
    );
    
    if (angularDistance < minAngularDistance) {
      minAngularDistance = angularDistance;
      nearestSector = sector;
    }
  });
  
  return nearestSector;
}

function convertSectorsToCustomers(sectors: CircularSector[]): ClusteredCustomer[] {
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

function validateCircularClustering(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  minSize: number,
  maxSize: number
): { isValid: boolean; message: string } {
  // Check customer count
  if (clusteredCustomers.length !== originalCustomers.length) {
    return {
      isValid: false,
      message: `Customer count mismatch: Input ${originalCustomers.length}, Output ${clusteredCustomers.length}`
    };
  }
  
  // Check for duplicates
  const customerIds = clusteredCustomers.map(c => c.id);
  const uniqueIds = new Set(customerIds);
  if (customerIds.length !== uniqueIds.size) {
    return {
      isValid: false,
      message: `Duplicate customers detected in clustering`
    };
  }
  
  // Check for missing customers
  const originalIds = new Set(originalCustomers.map(c => c.id));
  const clusteredIds = new Set(clusteredCustomers.map(c => c.id));
  
  const missingIds = Array.from(originalIds).filter(id => !clusteredIds.has(id));
  if (missingIds.length > 0) {
    return {
      isValid: false,
      message: `Missing customers: ${missingIds.length} customers not assigned to any cluster`
    };
  }
  
  // Check cluster sizes
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
  
  return { isValid: true, message: 'All circular clustering validation checks passed' };
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

function circularSectorFallback(
  customers: Customer[],
  center: MedianCenter,
  minSize: number,
  maxSize: number
): ClusteredCustomer[] {
  console.log('🚨 Applying circular sector fallback clustering...');
  
  // Sort customers by angle from median center for circular distribution
  const customersWithAngles = customers.map(customer => ({
    ...customer,
    angle: calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude),
    distance: calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude)
  }));
  
  customersWithAngles.sort((a, b) => a.angle - b.angle);
  
  // Create clusters ensuring both size and sales constraints
  const clusters: Customer[][] = [];
  let currentCluster: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  
  customersWithAngles.forEach(({ angle, distance, ...customer }) => {
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
  
  // Handle final cluster
  if (currentCluster.length > 0) {
    if (currentCluster.length >= minSize) {
      clusters.push(currentCluster);
    } else if (clusters.length > 0) {
      clusters[clusters.length - 1].push(...currentCluster);
    } else {
      clusters.push(currentCluster);
    }
  }
  
  console.log(`🚨 Fallback created ${clusters.length} circular sectors`);
  
  return clusters.flatMap((cluster, clusterIndex) =>
    cluster.map(customer => ({
      ...customer,
      clusterId: clusterIndex
    }))
  );
}

// Utility functions for circular geometry
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
  
  if (angle < 0) {
    angle += 2 * Math.PI;
  }
  
  return angle;
}

function normalizeAngle(angle: number): number {
  while (angle < 0) angle += 2 * Math.PI;
  while (angle >= 2 * Math.PI) angle -= 2 * Math.PI;
  return angle;
}

function isAngleInSector(angle: number, startAngle: number, endAngle: number): boolean {
  // Normalize all angles
  angle = normalizeAngle(angle);
  startAngle = normalizeAngle(startAngle);
  endAngle = normalizeAngle(endAngle);
  
  if (startAngle <= endAngle) {
    return angle >= startAngle && angle <= endAngle;
  } else {
    // Sector crosses 0 radians
    return angle >= startAngle || angle <= endAngle;
  }
}