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

    // Step 2: Create initial circular sectors with sales-aware distribution
    const initialSectors = createSalesAwareCircularSectors(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`🔄 Created ${initialSectors.length} sales-aware circular sectors from median center`);

    // Step 3: Validate and enforce sales constraints
    const salesValidatedSectors = enforceStrictSalesConstraints(initialSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`💰 Sales enforcement complete: ${salesValidatedSectors.length} sectors meet requirements`);

    // Step 4: Final balancing while preserving sales constraints
    const balancedSectors = finalSalesConstraintBalancing(salesValidatedSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`⚖️ Final balancing complete: ${balancedSectors.length} sectors`);

    // Step 5: Convert sectors to clustered customers
    const clusteredCustomers = convertSectorsToCustomers(balancedSectors);

    // Step 6: Comprehensive validation
    const validationResult = validateCircularClustering(clusteredCustomers, customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    
    if (!validationResult.isValid) {
      console.warn(`❌ Validation failed: ${validationResult.message}. Applying sales-aware fallback...`);
      return salesAwareFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    // Step 7: Strict sales validation
    const salesValidation = validateSalesConstraints(clusteredCustomers);
    if (!salesValidation.isValid) {
      console.error(`💰 CRITICAL: Sales validation failed: ${salesValidation.message}`);
      console.error('Sales details:', salesValidation.details);
      return salesAwareFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ Circular sector clustering successful: ${clusterCount} sectors`);
    console.log('📏 Sector sizes:', clusterSizes);
    console.log('💰 Sales validation:', salesValidation.details);

    return clusteredCustomers;

  } catch (error) {
    console.warn('🚨 Circular sector clustering failed, using sales-aware fallback:', error);
    const medianCenter = calculateMedianCenter(customers);
    return salesAwareFallback(customers, medianCenter, 180, 240);
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

function createSalesAwareCircularSectors(
  customers: Customer[],
  center: MedianCenter,
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('🔄 Creating sales-aware circular sectors from median center...');
  
  // Convert all customers to polar coordinates relative to median center
  const customersWithPolar = customers.map(customer => {
    const distance = calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude);
    const angle = calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude);
    
    return {
      ...customer,
      distance,
      angle: normalizeAngle(angle),
      salesScore: (customer.gr1Sale || 0) + (customer.gr2Sale || 0) // Combined sales score for sorting
    };
  });
  
  // Sort by angle to create proper circular sectors
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  // Calculate total sales to determine optimal sector count
  const totalGR1 = customers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
  const totalGR2 = customers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
  
  // Estimate sectors needed based on sales constraints
  const minSectorsForGR1 = Math.ceil(totalGR1 / (MIN_GR1_SALE * 1.2)); // 20% buffer
  const minSectorsForGR2 = Math.ceil(totalGR2 / (MIN_GR2_SALE * 1.2)); // 20% buffer
  const minSectorsForSize = Math.ceil(customers.length / maxSize);
  
  const optimalSectorCount = Math.max(minSectorsForGR1, minSectorsForGR2, minSectorsForSize);
  
  console.log(`🔄 Sales-aware sector calculation:
    - Min sectors for GR1: ${minSectorsForGR1}
    - Min sectors for GR2: ${minSectorsForGR2}
    - Min sectors for size: ${minSectorsForSize}
    - Optimal sector count: ${optimalSectorCount}`);
  
  const sectors: CircularSector[] = [];
  const customersPerSector = Math.ceil(customers.length / optimalSectorCount);
  
  // Create sectors by grouping customers sequentially by angle
  for (let i = 0; i < optimalSectorCount; i++) {
    const startIndex = i * customersPerSector;
    const endIndex = Math.min(startIndex + customersPerSector, customersWithPolar.length);
    
    if (startIndex < endIndex) {
      const sectorCustomers = customersWithPolar.slice(startIndex, endIndex);
      
      const startAngle = sectorCustomers[0].angle;
      const endAngle = sectorCustomers[sectorCustomers.length - 1].angle;
      
      const distances = sectorCustomers.map(c => c.distance);
      const gr1Total = sectorCustomers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
      const gr2Total = sectorCustomers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
      const avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
      
      sectors.push({
        id: i,
        customers: sectorCustomers.map(({ distance, angle, salesScore, ...customer }) => customer),
        startAngle,
        endAngle,
        minRadius: Math.min(...distances),
        maxRadius: Math.max(...distances),
        center,
        gr1Total,
        gr2Total,
        avgRadius
      });
      
      console.log(`🔄 Sector ${i}: ${sectorCustomers.length} customers, GR1=${gr1Total.toLocaleString()}, GR2=${gr2Total.toLocaleString()}`);
    }
  }
  
  return sectors;
}

function enforceStrictSalesConstraints(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('💰 Enforcing strict sales constraints...');
  
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
  
  // Redistribute customers from invalid sectors using sales-aware merging
  if (invalidSectors.length > 0) {
    console.log(`🔄 Redistributing customers from ${invalidSectors.length} sales-invalid sectors...`);
    
    // Sort invalid sectors by their sales deficit (prioritize those closest to meeting requirements)
    invalidSectors.sort((a, b) => {
      const aDeficit = Math.max(0, MIN_GR1_SALE - a.gr1Total) + Math.max(0, MIN_GR2_SALE - a.gr2Total);
      const bDeficit = Math.max(0, MIN_GR1_SALE - b.gr1Total) + Math.max(0, MIN_GR2_SALE - b.gr2Total);
      return aDeficit - bDeficit;
    });
    
    invalidSectors.forEach(invalidSector => {
      const unassignedCustomers = [...invalidSector.customers];
      
      // Try to merge with adjacent valid sectors first
      const adjacentSectors = findAdjacentSectors(invalidSector, validSectors);
      
      if (adjacentSectors.length > 0) {
        // Merge with the adjacent sector that has the most capacity
        const bestTarget = adjacentSectors.reduce((best, sector) => {
          const capacity = maxSize - sector.customers.length;
          const bestCapacity = maxSize - best.customers.length;
          return capacity > bestCapacity ? sector : best;
        });
        
        // Move customers that fit
        const customersToMove = unassignedCustomers.splice(0, Math.min(
          unassignedCustomers.length,
          maxSize - bestTarget.customers.length
        ));
        
        bestTarget.customers.push(...customersToMove);
        bestTarget.gr1Total += customersToMove.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
        bestTarget.gr2Total += customersToMove.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
        updateSectorBounds(bestTarget);
        
        console.log(`🔄 Merged ${customersToMove.length} customers from sector ${invalidSector.id} to sector ${bestTarget.id}`);
      }
      
      // Create new sectors for remaining customers if they can meet sales constraints
      while (unassignedCustomers.length > 0) {
        const newSectorCustomers = selectCustomersForNewSector(unassignedCustomers, minSize, maxSize);
        
        if (newSectorCustomers.length > 0) {
          const newSector = createNewCircularSector(
            newSectorCustomers,
            invalidSector.center,
            Math.max(...validSectors.map(s => s.id)) + validSectors.length + 1
          );
          
          // Remove assigned customers from unassigned list
          newSectorCustomers.forEach(customer => {
            const index = unassignedCustomers.findIndex(c => c.id === customer.id);
            if (index !== -1) unassignedCustomers.splice(index, 1);
          });
          
          if (newSector.gr1Total >= MIN_GR1_SALE && newSector.gr2Total >= MIN_GR2_SALE) {
            validSectors.push(newSector);
            console.log(`🆕 Created new valid sector ${newSector.id} with ${newSector.customers.length} customers`);
          } else {
            // If new sector doesn't meet sales constraints, distribute to existing sectors
            console.log(`🔄 New sector doesn't meet sales constraints, distributing to existing sectors`);
            distributeCustomersToExistingSectors(newSectorCustomers, validSectors, maxSize);
          }
        } else {
          // Distribute remaining customers to existing sectors
          distributeCustomersToExistingSectors(unassignedCustomers, validSectors, maxSize);
          break;
        }
      }
    });
  }
  
  return validSectors;
}

function selectCustomersForNewSector(
  customers: Customer[],
  minSize: number,
  maxSize: number
): Customer[] {
  // Sort customers by combined sales value (descending)
  const sortedCustomers = [...customers].sort((a, b) => {
    const aSales = (a.gr1Sale || 0) + (a.gr2Sale || 0);
    const bSales = (b.gr1Sale || 0) + (b.gr2Sale || 0);
    return bSales - aSales;
  });
  
  // Greedily select customers to meet sales constraints
  const selected: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  
  for (const customer of sortedCustomers) {
    if (selected.length >= maxSize) break;
    
    const potentialGR1 = currentGR1 + (customer.gr1Sale || 0);
    const potentialGR2 = currentGR2 + (customer.gr2Sale || 0);
    
    selected.push(customer);
    currentGR1 = potentialGR1;
    currentGR2 = potentialGR2;
    
    // If we meet both constraints and minimum size, we can stop
    if (selected.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
      break;
    }
  }
  
  // Only return if we meet sales constraints
  if (currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE && selected.length >= minSize) {
    return selected;
  }
  
  return [];
}

function distributeCustomersToExistingSectors(
  customers: Customer[],
  sectors: CircularSector[],
  maxSize: number
): void {
  customers.forEach(customer => {
    // Find sector with most capacity that can accommodate this customer
    let bestSector: CircularSector | null = null;
    let maxCapacity = 0;
    
    sectors.forEach(sector => {
      const capacity = maxSize - sector.customers.length;
      if (capacity > 0 && capacity > maxCapacity) {
        maxCapacity = capacity;
        bestSector = sector;
      }
    });
    
    if (bestSector) {
      bestSector.customers.push(customer);
      bestSector.gr1Total += customer.gr1Sale || 0;
      bestSector.gr2Total += customer.gr2Sale || 0;
      updateSectorBounds(bestSector);
      console.log(`🔄 Distributed customer ${customer.id} to sector ${bestSector.id}`);
    }
  });
}

function findAdjacentSectors(
  targetSector: CircularSector,
  sectors: CircularSector[]
): CircularSector[] {
  const adjacent: CircularSector[] = [];
  const targetMidAngle = (targetSector.startAngle + targetSector.endAngle) / 2;
  
  sectors.forEach(sector => {
    const sectorMidAngle = (sector.startAngle + sector.endAngle) / 2;
    const angularDistance = Math.min(
      Math.abs(targetMidAngle - sectorMidAngle),
      2 * Math.PI - Math.abs(targetMidAngle - sectorMidAngle)
    );
    
    // Consider sectors within 90 degrees as adjacent
    if (angularDistance <= Math.PI / 2) {
      adjacent.push(sector);
    }
  });
  
  return adjacent.sort((a, b) => {
    const aMidAngle = (a.startAngle + a.endAngle) / 2;
    const bMidAngle = (b.startAngle + b.endAngle) / 2;
    const aDistance = Math.min(
      Math.abs(targetMidAngle - aMidAngle),
      2 * Math.PI - Math.abs(targetMidAngle - aMidAngle)
    );
    const bDistance = Math.min(
      Math.abs(targetMidAngle - bMidAngle),
      2 * Math.PI - Math.abs(targetMidAngle - bMidAngle)
    );
    return aDistance - bDistance;
  });
}

function finalSalesConstraintBalancing(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('⚖️ Final sales constraint balancing...');
  
  // Validate all sectors meet sales constraints
  const invalidSectors = sectors.filter(sector => 
    sector.gr1Total < MIN_GR1_SALE || sector.gr2Total < MIN_GR2_SALE
  );
  
  if (invalidSectors.length > 0) {
    console.error(`💰 CRITICAL: ${invalidSectors.length} sectors still don't meet sales constraints after enforcement!`);
    invalidSectors.forEach(sector => {
      console.error(`Sector ${sector.id}: GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
    });
    
    // Emergency redistribution
    return emergencySalesRedistribution(sectors, minSize, maxSize);
  }
  
  // Check for size violations and fix them while maintaining sales constraints
  const balancedSectors: CircularSector[] = [];
  
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize && sector.customers.length <= maxSize) {
      balancedSectors.push(sector);
    } else if (sector.customers.length > maxSize) {
      // Split oversized sector while maintaining sales constraints
      const splitSectors = splitSectorWithSalesConstraints(sector, maxSize, minSize);
      balancedSectors.push(...splitSectors);
    } else {
      // Undersized sector - try to merge with others
      balancedSectors.push(sector);
    }
  });
  
  return balancedSectors;
}

function emergencySalesRedistribution(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('🚨 Emergency sales redistribution...');
  
  // Collect all customers
  const allCustomers = sectors.flatMap(sector => sector.customers);
  
  // Sort by combined sales value (descending)
  allCustomers.sort((a, b) => {
    const aSales = (a.gr1Sale || 0) + (a.gr2Sale || 0);
    const bSales = (b.gr1Sale || 0) + (b.gr2Sale || 0);
    return bSales - aSales;
  });
  
  const newSectors: CircularSector[] = [];
  let currentSector: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  let sectorId = 0;
  
  allCustomers.forEach(customer => {
    const potentialGR1 = currentGR1 + (customer.gr1Sale || 0);
    const potentialGR2 = currentGR2 + (customer.gr2Sale || 0);
    
    if (currentSector.length < maxSize && 
        (currentSector.length < minSize || 
         (potentialGR1 >= MIN_GR1_SALE && potentialGR2 >= MIN_GR2_SALE))) {
      currentSector.push(customer);
      currentGR1 = potentialGR1;
      currentGR2 = potentialGR2;
    } else {
      // Finalize current sector if it meets requirements
      if (currentSector.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
        const newSector = createNewCircularSector(
          currentSector,
          sectors[0].center,
          sectorId++
        );
        newSectors.push(newSector);
      }
      
      // Start new sector
      currentSector = [customer];
      currentGR1 = customer.gr1Sale || 0;
      currentGR2 = customer.gr2Sale || 0;
    }
  });
  
  // Handle final sector
  if (currentSector.length > 0) {
    if (currentSector.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
      const newSector = createNewCircularSector(
        currentSector,
        sectors[0].center,
        sectorId++
      );
      newSectors.push(newSector);
    } else if (newSectors.length > 0) {
      // Add to last sector if possible
      const lastSector = newSectors[newSectors.length - 1];
      if (lastSector.customers.length + currentSector.length <= maxSize) {
        lastSector.customers.push(...currentSector);
        lastSector.gr1Total += currentGR1;
        lastSector.gr2Total += currentGR2;
        updateSectorBounds(lastSector);
      }
    }
  }
  
  console.log(`🚨 Emergency redistribution created ${newSectors.length} sectors`);
  return newSectors;
}

function splitSectorWithSalesConstraints(
  sector: CircularSector,
  maxSize: number,
  minSize: number
): CircularSector[] {
  const customers = sector.customers;
  
  // Sort customers by sales value to ensure balanced distribution
  const sortedCustomers = [...customers].sort((a, b) => {
    const aSales = (a.gr1Sale || 0) + (a.gr2Sale || 0);
    const bSales = (b.gr1Sale || 0) + (b.gr2Sale || 0);
    return bSales - aSales;
  });
  
  const sectors: CircularSector[] = [];
  let currentGroup: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  let sectorId = sector.id;
  
  // Distribute customers ensuring each group meets sales constraints
  sortedCustomers.forEach((customer, index) => {
    currentGroup.push(customer);
    currentGR1 += customer.gr1Sale || 0;
    currentGR2 += customer.gr2Sale || 0;
    
    // Check if we should finalize this group
    const shouldFinalize = 
      currentGroup.length >= maxSize ||
      (currentGroup.length >= minSize && 
       currentGR1 >= MIN_GR1_SALE && 
       currentGR2 >= MIN_GR2_SALE &&
       index === sortedCustomers.length - 1);
    
    if (shouldFinalize) {
      if (currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
        const newSector = createNewCircularSector(
          currentGroup,
          sector.center,
          sectorId++
        );
        sectors.push(newSector);
        
        currentGroup = [];
        currentGR1 = 0;
        currentGR2 = 0;
      }
    }
  });
  
  // Handle any remaining customers
  if (currentGroup.length > 0 && sectors.length > 0) {
    const lastSector = sectors[sectors.length - 1];
    if (lastSector.customers.length + currentGroup.length <= maxSize) {
      lastSector.customers.push(...currentGroup);
      lastSector.gr1Total += currentGR1;
      lastSector.gr2Total += currentGR2;
      updateSectorBounds(lastSector);
    }
  }
  
  return sectors.length > 0 ? sectors : [sector]; // Return original if split failed
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

function updateSectorBounds(sector: CircularSector): void {
  if (sector.customers.length === 0) return;
  
  const distances = sector.customers.map(c => 
    calculateDistance(sector.center.latitude, sector.center.longitude, c.latitude, c.longitude)
  );
  
  sector.minRadius = Math.min(...distances);
  sector.maxRadius = Math.max(...distances);
  sector.avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
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

function salesAwareFallback(
  customers: Customer[],
  center: MedianCenter,
  minSize: number,
  maxSize: number
): ClusteredCustomer[] {
  console.log('🚨 Applying sales-aware fallback clustering...');
  
  // Sort customers by combined sales value (descending) to prioritize high-value customers
  const sortedCustomers = [...customers].sort((a, b) => {
    const aSales = (a.gr1Sale || 0) + (a.gr2Sale || 0);
    const bSales = (b.gr1Sale || 0) + (b.gr2Sale || 0);
    return bSales - aSales;
  });
  
  // Create clusters ensuring both size and sales constraints
  const clusters: Customer[][] = [];
  let currentCluster: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  
  sortedCustomers.forEach(customer => {
    const potentialGR1 = currentGR1 + (customer.gr1Sale || 0);
    const potentialGR2 = currentGR2 + (customer.gr2Sale || 0);
    
    // Add customer if we haven't reached max size and either:
    // 1. We haven't reached min size yet, OR
    // 2. Adding this customer would help us meet sales constraints
    if (currentCluster.length < maxSize && 
        (currentCluster.length < minSize || 
         potentialGR1 < MIN_GR1_SALE || 
         potentialGR2 < MIN_GR2_SALE)) {
      currentCluster.push(customer);
      currentGR1 = potentialGR1;
      currentGR2 = potentialGR2;
    } else {
      // Finalize current cluster if it meets all constraints
      if (currentCluster.length >= minSize && 
          currentGR1 >= MIN_GR1_SALE && 
          currentGR2 >= MIN_GR2_SALE) {
        clusters.push(currentCluster);
        console.log(`🚨 Fallback cluster ${clusters.length - 1}: ${currentCluster.length} customers, GR1=${currentGR1.toLocaleString()}, GR2=${currentGR2.toLocaleString()}`);
      } else if (clusters.length > 0) {
        // Add to previous cluster if possible
        const lastCluster = clusters[clusters.length - 1];
        if (lastCluster.length + currentCluster.length <= maxSize) {
          lastCluster.push(...currentCluster);
          console.log(`🚨 Merged undersized cluster with previous cluster`);
        } else {
          // Force create cluster even if it doesn't meet sales constraints
          clusters.push(currentCluster);
          console.log(`🚨 Force-created cluster that doesn't meet sales constraints`);
        }
      } else {
        // First cluster - keep it even if it doesn't meet constraints
        clusters.push(currentCluster);
        console.log(`🚨 First cluster doesn't meet constraints but keeping it`);
      }
      
      // Start new cluster
      currentCluster = [customer];
      currentGR1 = customer.gr1Sale || 0;
      currentGR2 = customer.gr2Sale || 0;
    }
  });
  
  // Handle final cluster
  if (currentCluster.length > 0) {
    if (currentCluster.length >= minSize && 
        currentGR1 >= MIN_GR1_SALE && 
        currentGR2 >= MIN_GR2_SALE) {
      clusters.push(currentCluster);
      console.log(`🚨 Final fallback cluster: ${currentCluster.length} customers, GR1=${currentGR1.toLocaleString()}, GR2=${currentGR2.toLocaleString()}`);
    } else if (clusters.length > 0) {
      // Add to last cluster
      const lastCluster = clusters[clusters.length - 1];
      if (lastCluster.length + currentCluster.length <= maxSize) {
        lastCluster.push(...currentCluster);
        console.log(`🚨 Added final customers to last cluster`);
      } else {
        clusters.push(currentCluster);
        console.log(`🚨 Created final cluster that may not meet constraints`);
      }
    } else {
      clusters.push(currentCluster);
      console.log(`🚨 Only cluster created - may not meet constraints`);
    }
  }
  
  console.log(`🚨 Fallback created ${clusters.length} clusters`);
  
  // Validate fallback results
  clusters.forEach((cluster, index) => {
    const gr1Total = cluster.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
    const gr2Total = cluster.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
    const gr1Valid = gr1Total >= MIN_GR1_SALE;
    const gr2Valid = gr2Total >= MIN_GR2_SALE;
    
    if (!gr1Valid || !gr2Valid) {
      console.error(`🚨 FALLBACK CLUSTER ${index} STILL INVALID: GR1=${gr1Total.toLocaleString()} (${gr1Valid ? '✅' : '❌'}), GR2=${gr2Total.toLocaleString()} (${gr2Valid ? '✅' : '❌'})`);
    }
  });
  
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