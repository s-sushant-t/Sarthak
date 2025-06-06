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

    console.log(`🎯 Starting CIRCULAR SECTOR clustering from median center for ${customers.length} customers`);
    console.log(`📊 Constraints: ${TARGET_MIN_SIZE}-${TARGET_MAX_SIZE} outlets, GR1≥${MIN_GR1_SALE.toLocaleString()}, GR2≥${MIN_GR2_SALE.toLocaleString()}`);

    // Step 1: Calculate the median center point as the clustering origin
    const medianCenter = calculateMedianCenter(customers);
    console.log('📍 Median center calculated as clustering origin:', medianCenter);

    // Step 2: Create circular sectors from median center with sales awareness
    const circularSectors = createCircularSectorsFromMedian(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`🔄 Created ${circularSectors.length} circular sectors from median center`);

    // Step 3: Enforce strict sales constraints on circular sectors
    const salesValidatedSectors = enforceCircularSectorSalesConstraints(circularSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`💰 Sales enforcement on circular sectors complete: ${salesValidatedSectors.length} sectors meet requirements`);

    // Step 4: Final balancing while preserving circular structure and sales constraints
    const balancedSectors = finalCircularSectorBalancing(salesValidatedSectors, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    console.log(`⚖️ Final circular sector balancing complete: ${balancedSectors.length} sectors`);

    // Step 5: Convert sectors to clustered customers
    const clusteredCustomers = convertSectorsToCustomers(balancedSectors);

    // Step 6: Comprehensive validation
    const validationResult = validateCircularClustering(clusteredCustomers, customers, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    
    if (!validationResult.isValid) {
      console.warn(`❌ Circular sector validation failed: ${validationResult.message}. Applying circular fallback...`);
      return circularSectorFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    // Step 7: Strict sales validation
    const salesValidation = validateSalesConstraints(clusteredCustomers);
    if (!salesValidation.isValid) {
      console.error(`💰 CRITICAL: Sales validation failed: ${salesValidation.message}`);
      console.error('Sales details:', salesValidation.details);
      return circularSectorFallback(customers, medianCenter, TARGET_MIN_SIZE, TARGET_MAX_SIZE);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ Circular sector clustering successful: ${clusterCount} sectors`);
    console.log('📏 Sector sizes:', clusterSizes);
    console.log('💰 Sales validation:', salesValidation.details);

    return clusteredCustomers;

  } catch (error) {
    console.warn('🚨 Circular sector clustering failed, using circular fallback:', error);
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
  sectorAngle: number; // Angular width of the sector
}

interface SalesValidation {
  isValid: boolean;
  message: string;
  details?: string[];
}

function calculateMedianCenter(customers: Customer[]): MedianCenter {
  console.log('📍 Calculating median center as clustering origin...');
  
  // Sort customers by latitude and longitude separately to find true median
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
  
  console.log(`📍 Median center (clustering origin): (${center.latitude.toFixed(6)}, ${center.longitude.toFixed(6)})`);
  return center;
}

function createCircularSectorsFromMedian(
  customers: Customer[],
  medianCenter: MedianCenter,
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('🔄 Creating circular sectors from median center...');
  
  // Convert all customers to polar coordinates relative to median center
  const customersWithPolar = customers.map(customer => {
    const distance = calculateDistance(medianCenter.latitude, medianCenter.longitude, customer.latitude, customer.longitude);
    const angle = calculateAngle(medianCenter.latitude, medianCenter.longitude, customer.latitude, customer.longitude);
    
    return {
      ...customer,
      distance,
      angle: normalizeAngle(angle),
      salesScore: (customer.gr1Sale || 0) + (customer.gr2Sale || 0)
    };
  });
  
  // Sort by angle to create proper circular sectors radiating from median center
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  console.log(`🔄 Converted ${customersWithPolar.length} customers to polar coordinates from median center`);
  
  // Calculate total sales to determine optimal sector count
  const totalGR1 = customers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
  const totalGR2 = customers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
  
  // Estimate sectors needed based on sales constraints and size
  const minSectorsForGR1 = Math.ceil(totalGR1 / (MIN_GR1_SALE * 1.1)); // 10% buffer
  const minSectorsForGR2 = Math.ceil(totalGR2 / (MIN_GR2_SALE * 1.1)); // 10% buffer
  const minSectorsForSize = Math.ceil(customers.length / maxSize);
  const maxSectorsForSize = Math.floor(customers.length / minSize);
  
  const optimalSectorCount = Math.max(
    minSectorsForGR1, 
    minSectorsForGR2, 
    minSectorsForSize
  );
  
  // Ensure we don't create too many small sectors
  const finalSectorCount = Math.min(optimalSectorCount, maxSectorsForSize);
  
  console.log(`🔄 Circular sector calculation from median center:
    - Min sectors for GR1: ${minSectorsForGR1}
    - Min sectors for GR2: ${minSectorsForGR2}
    - Min sectors for size: ${minSectorsForSize}
    - Max sectors for size: ${maxSectorsForSize}
    - Final sector count: ${finalSectorCount}`);
  
  const sectors: CircularSector[] = [];
  const anglePerSector = (2 * Math.PI) / finalSectorCount;
  
  // Create sectors by dividing the circle into equal angular segments
  for (let i = 0; i < finalSectorCount; i++) {
    const startAngle = i * anglePerSector;
    const endAngle = (i + 1) * anglePerSector;
    
    // Find customers within this angular sector
    const sectorCustomers = customersWithPolar.filter(customer => {
      const angle = customer.angle;
      
      // Handle wrap-around at 0/2π
      if (startAngle <= endAngle) {
        return angle >= startAngle && angle < endAngle;
      } else {
        return angle >= startAngle || angle < endAngle;
      }
    });
    
    if (sectorCustomers.length > 0) {
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
        center: medianCenter,
        gr1Total,
        gr2Total,
        avgRadius,
        sectorAngle: endAngle - startAngle
      });
      
      console.log(`🔄 Circular Sector ${i}: ${sectorCustomers.length} customers, angles ${(startAngle * 180 / Math.PI).toFixed(1)}°-${(endAngle * 180 / Math.PI).toFixed(1)}°, GR1=${gr1Total.toLocaleString()}, GR2=${gr2Total.toLocaleString()}`);
    }
  }
  
  // Handle any customers that might have been missed due to floating point precision
  const assignedCustomerIds = new Set(sectors.flatMap(s => s.customers.map(c => c.id)));
  const unassignedCustomers = customersWithPolar.filter(c => !assignedCustomerIds.has(c.id));
  
  if (unassignedCustomers.length > 0) {
    console.log(`🔄 Assigning ${unassignedCustomers.length} unassigned customers to nearest sectors`);
    
    unassignedCustomers.forEach(customer => {
      // Find the sector with the closest angle
      let nearestSector = sectors[0];
      let minAngleDiff = Infinity;
      
      sectors.forEach(sector => {
        const sectorMidAngle = (sector.startAngle + sector.endAngle) / 2;
        const angleDiff = Math.min(
          Math.abs(customer.angle - sectorMidAngle),
          2 * Math.PI - Math.abs(customer.angle - sectorMidAngle)
        );
        
        if (angleDiff < minAngleDiff) {
          minAngleDiff = angleDiff;
          nearestSector = sector;
        }
      });
      
      nearestSector.customers.push({
        id: customer.id,
        latitude: customer.latitude,
        longitude: customer.longitude,
        outletName: customer.outletName,
        gr1Sale: customer.gr1Sale,
        gr2Sale: customer.gr2Sale
      });
      
      nearestSector.gr1Total += customer.gr1Sale || 0;
      nearestSector.gr2Total += customer.gr2Sale || 0;
      updateSectorBounds(nearestSector);
    });
  }
  
  return sectors;
}

function enforceCircularSectorSalesConstraints(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('💰 Enforcing strict sales constraints on circular sectors...');
  
  const validSectors: CircularSector[] = [];
  const invalidSectors: CircularSector[] = [];
  
  // Classify sectors based on sales constraints
  sectors.forEach(sector => {
    const meetsGR1 = sector.gr1Total >= MIN_GR1_SALE;
    const meetsGR2 = sector.gr2Total >= MIN_GR2_SALE;
    const meetsSize = sector.customers.length >= minSize && sector.customers.length <= maxSize;
    
    if (meetsGR1 && meetsGR2 && meetsSize) {
      validSectors.push(sector);
      console.log(`💰 Circular Sector ${sector.id}: ✅ Valid - ${sector.customers.length} customers, GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
    } else {
      invalidSectors.push(sector);
      console.log(`💰 Circular Sector ${sector.id}: ❌ Invalid - ${sector.customers.length} customers, GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}, Size=${meetsSize ? '✅' : '❌'}, GR1=${meetsGR1 ? '✅' : '❌'}, GR2=${meetsGR2 ? '✅' : '❌'}`);
    }
  });
  
  // Redistribute customers from invalid sectors using angular adjacency
  if (invalidSectors.length > 0) {
    console.log(`🔄 Redistributing customers from ${invalidSectors.length} invalid circular sectors...`);
    
    // Sort invalid sectors by their angular position for systematic redistribution
    invalidSectors.sort((a, b) => a.startAngle - b.startAngle);
    
    invalidSectors.forEach(invalidSector => {
      const unassignedCustomers = [...invalidSector.customers];
      
      // Try to merge with angularly adjacent valid sectors first
      const adjacentSectors = findAngularlyAdjacentSectors(invalidSector, validSectors);
      
      if (adjacentSectors.length > 0) {
        // Distribute customers to adjacent sectors based on capacity and angular proximity
        adjacentSectors.forEach(adjacentSector => {
          const capacity = maxSize - adjacentSector.customers.length;
          const customersToMove = Math.min(capacity, unassignedCustomers.length);
          
          if (customersToMove > 0) {
            // Select customers closest to the adjacent sector's angular range
            const customersToTransfer = selectCustomersForAngularTransfer(
              unassignedCustomers, 
              adjacentSector, 
              customersToMove
            );
            
            customersToTransfer.forEach(customer => {
              adjacentSector.customers.push(customer);
              adjacentSector.gr1Total += customer.gr1Sale || 0;
              adjacentSector.gr2Total += customer.gr2Sale || 0;
              
              const index = unassignedCustomers.findIndex(c => c.id === customer.id);
              if (index !== -1) unassignedCustomers.splice(index, 1);
            });
            
            updateSectorBounds(adjacentSector);
            console.log(`🔄 Transferred ${customersToTransfer.length} customers from sector ${invalidSector.id} to adjacent sector ${adjacentSector.id}`);
          }
        });
      }
      
      // Create new circular sectors for remaining customers if they can meet sales constraints
      while (unassignedCustomers.length >= minSize) {
        const newSectorCustomers = selectCustomersForNewCircularSector(unassignedCustomers, minSize, maxSize);
        
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
            console.log(`🆕 Created new valid circular sector ${newSector.id} with ${newSector.customers.length} customers`);
          } else {
            // If new sector doesn't meet sales constraints, distribute to existing sectors
            console.log(`🔄 New circular sector doesn't meet sales constraints, distributing to existing sectors`);
            distributeCustomersToExistingCircularSectors(newSectorCustomers, validSectors, maxSize);
          }
        } else {
          break;
        }
      }
      
      // Distribute any remaining customers to existing sectors
      if (unassignedCustomers.length > 0) {
        distributeCustomersToExistingCircularSectors(unassignedCustomers, validSectors, maxSize);
      }
    });
  }
  
  return validSectors;
}

function findAngularlyAdjacentSectors(
  targetSector: CircularSector,
  sectors: CircularSector[]
): CircularSector[] {
  const targetMidAngle = (targetSector.startAngle + targetSector.endAngle) / 2;
  
  const adjacent = sectors.filter(sector => {
    const sectorMidAngle = (sector.startAngle + sector.endAngle) / 2;
    const angularDistance = Math.min(
      Math.abs(targetMidAngle - sectorMidAngle),
      2 * Math.PI - Math.abs(targetMidAngle - sectorMidAngle)
    );
    
    // Consider sectors within 90 degrees as adjacent in circular space
    return angularDistance <= Math.PI / 2;
  });
  
  // Sort by angular proximity
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

function selectCustomersForAngularTransfer(
  customers: Customer[],
  targetSector: CircularSector,
  count: number
): Customer[] {
  const targetMidAngle = (targetSector.startAngle + targetSector.endAngle) / 2;
  
  // Sort customers by their angular proximity to the target sector
  const sortedCustomers = customers
    .map(customer => {
      const angle = calculateAngle(
        targetSector.center.latitude,
        targetSector.center.longitude,
        customer.latitude,
        customer.longitude
      );
      const normalizedAngle = normalizeAngle(angle);
      const angularDistance = Math.min(
        Math.abs(normalizedAngle - targetMidAngle),
        2 * Math.PI - Math.abs(normalizedAngle - targetMidAngle)
      );
      
      return { customer, angularDistance };
    })
    .sort((a, b) => a.angularDistance - b.angularDistance)
    .map(item => item.customer);
  
  return sortedCustomers.slice(0, count);
}

function selectCustomersForNewCircularSector(
  customers: Customer[],
  minSize: number,
  maxSize: number
): Customer[] {
  // Sort customers by combined sales value (descending) to maximize chances of meeting constraints
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

function distributeCustomersToExistingCircularSectors(
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
      console.log(`🔄 Distributed customer ${customer.id} to circular sector ${bestSector.id}`);
    }
  });
}

function finalCircularSectorBalancing(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('⚖️ Final circular sector balancing...');
  
  // Validate all sectors meet sales constraints
  const invalidSectors = sectors.filter(sector => 
    sector.gr1Total < MIN_GR1_SALE || sector.gr2Total < MIN_GR2_SALE
  );
  
  if (invalidSectors.length > 0) {
    console.error(`💰 CRITICAL: ${invalidSectors.length} circular sectors still don't meet sales constraints!`);
    invalidSectors.forEach(sector => {
      console.error(`Circular Sector ${sector.id}: GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
    });
    
    // Emergency redistribution while preserving circular structure
    return emergencyCircularSectorRedistribution(sectors, minSize, maxSize);
  }
  
  // Check for size violations and fix them while maintaining sales constraints and circular structure
  const balancedSectors: CircularSector[] = [];
  
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize && sector.customers.length <= maxSize) {
      balancedSectors.push(sector);
    } else if (sector.customers.length > maxSize) {
      // Split oversized sector while maintaining sales constraints and circular structure
      const splitSectors = splitCircularSectorWithSalesConstraints(sector, maxSize, minSize);
      balancedSectors.push(...splitSectors);
    } else {
      // Undersized sector - try to merge with angularly adjacent sectors
      balancedSectors.push(sector);
    }
  });
  
  return balancedSectors;
}

function emergencyCircularSectorRedistribution(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number
): CircularSector[] {
  console.log('🚨 Emergency circular sector redistribution...');
  
  // Collect all customers and sort by angular position to maintain circular structure
  const allCustomers = sectors.flatMap(sector => sector.customers);
  const center = sectors[0].center;
  
  // Convert to polar and sort by angle to maintain circular ordering
  const customersWithAngles = allCustomers.map(customer => {
    const angle = calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude);
    return {
      customer,
      angle: normalizeAngle(angle),
      salesScore: (customer.gr1Sale || 0) + (customer.gr2Sale || 0)
    };
  });
  
  customersWithAngles.sort((a, b) => a.angle - b.angle);
  
  // Create new circular sectors maintaining angular order
  const newSectors: CircularSector[] = [];
  let currentSector: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  let sectorId = 0;
  let startAngle = 0;
  
  customersWithAngles.forEach((item, index) => {
    const { customer } = item;
    const potentialGR1 = currentGR1 + (customer.gr1Sale || 0);
    const potentialGR2 = currentGR2 + (customer.gr2Sale || 0);
    
    if (currentSector.length < maxSize && 
        (currentSector.length < minSize || 
         potentialGR1 < MIN_GR1_SALE || 
         potentialGR2 < MIN_GR2_SALE)) {
      
      if (currentSector.length === 0) {
        startAngle = item.angle;
      }
      
      currentSector.push(customer);
      currentGR1 = potentialGR1;
      currentGR2 = potentialGR2;
    } else {
      // Finalize current sector if it meets requirements
      if (currentSector.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
        const endAngle = index > 0 ? customersWithAngles[index - 1].angle : item.angle;
        const newSector = createCircularSectorWithAngles(
          currentSector,
          center,
          sectorId++,
          startAngle,
          endAngle
        );
        newSectors.push(newSector);
      }
      
      // Start new sector
      startAngle = item.angle;
      currentSector = [customer];
      currentGR1 = customer.gr1Sale || 0;
      currentGR2 = customer.gr2Sale || 0;
    }
  });
  
  // Handle final sector
  if (currentSector.length > 0) {
    if (currentSector.length >= minSize && currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
      const endAngle = customersWithAngles[customersWithAngles.length - 1].angle;
      const newSector = createCircularSectorWithAngles(
        currentSector,
        center,
        sectorId++,
        startAngle,
        endAngle
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
  
  console.log(`🚨 Emergency circular redistribution created ${newSectors.length} sectors`);
  return newSectors;
}

function splitCircularSectorWithSalesConstraints(
  sector: CircularSector,
  maxSize: number,
  minSize: number
): CircularSector[] {
  const customers = sector.customers;
  
  // Sort customers by angular position to maintain circular structure
  const customersWithAngles = customers.map(customer => {
    const angle = calculateAngle(sector.center.latitude, sector.center.longitude, customer.latitude, customer.longitude);
    return {
      customer,
      angle: normalizeAngle(angle),
      salesScore: (customer.gr1Sale || 0) + (customer.gr2Sale || 0)
    };
  });
  
  customersWithAngles.sort((a, b) => a.angle - b.angle);
  
  const sectors: CircularSector[] = [];
  let currentGroup: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  let sectorId = sector.id;
  let startAngle = 0;
  
  // Distribute customers ensuring each group meets sales constraints and maintains angular order
  customersWithAngles.forEach((item, index) => {
    const { customer } = item;
    
    if (currentGroup.length === 0) {
      startAngle = item.angle;
    }
    
    currentGroup.push(customer);
    currentGR1 += customer.gr1Sale || 0;
    currentGR2 += customer.gr2Sale || 0;
    
    // Check if we should finalize this group
    const shouldFinalize = 
      currentGroup.length >= maxSize ||
      (currentGroup.length >= minSize && 
       currentGR1 >= MIN_GR1_SALE && 
       currentGR2 >= MIN_GR2_SALE &&
       index === customersWithAngles.length - 1);
    
    if (shouldFinalize) {
      if (currentGR1 >= MIN_GR1_SALE && currentGR2 >= MIN_GR2_SALE) {
        const endAngle = item.angle;
        const newSector = createCircularSectorWithAngles(
          currentGroup,
          sector.center,
          sectorId++,
          startAngle,
          endAngle
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
    avgRadius: 0,
    sectorAngle: 2 * Math.PI
  };
  
  updateSectorBounds(sector);
  return sector;
}

function createCircularSectorWithAngles(
  customers: Customer[],
  center: MedianCenter,
  id: number,
  startAngle: number,
  endAngle: number
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
    avgRadius: 0,
    sectorAngle: endAngle - startAngle
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
      message: `Duplicate customers detected in circular clustering`
    };
  }
  
  // Check for missing customers
  const originalIds = new Set(originalCustomers.map(c => c.id));
  const clusteredIds = new Set(clusteredCustomers.map(c => c.id));
  
  const missingIds = Array.from(originalIds).filter(id => !clusteredIds.has(id));
  if (missingIds.length > 0) {
    return {
      isValid: false,
      message: `Missing customers: ${missingIds.length} customers not assigned to any circular sector`
    };
  }
  
  // Check cluster sizes
  const clusterSizes = getClusterSizes(clusteredCustomers);
  const undersizedClusters = clusterSizes.filter(size => size < minSize);
  const oversizedClusters = clusterSizes.filter(size => size > maxSize);
  
  if (undersizedClusters.length > 0) {
    return {
      isValid: false,
      message: `Size violation: ${undersizedClusters.length} circular sectors below ${minSize} outlets`
    };
  }
  
  if (oversizedClusters.length > 0) {
    return {
      isValid: false,
      message: `Size violation: ${oversizedClusters.length} circular sectors above ${maxSize} outlets`
    };
  }
  
  return { isValid: true, message: 'All circular sector validation checks passed' };
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
      `Circular Sector ${clusterId}: ${sales.count} outlets, GR1=${sales.gr1.toLocaleString()}, GR2=${sales.gr2.toLocaleString()} ${gr1Valid && gr2Valid ? '✅' : '❌'}`
    );
    
    if (!gr1Valid) {
      violations.push(`Circular Sector ${clusterId} GR1 sales ${sales.gr1.toLocaleString()} < ${MIN_GR1_SALE.toLocaleString()}`);
    }
    if (!gr2Valid) {
      violations.push(`Circular Sector ${clusterId} GR2 sales ${sales.gr2.toLocaleString()} < ${MIN_GR2_SALE.toLocaleString()}`);
    }
  });
  
  return {
    isValid: violations.length === 0,
    message: violations.length > 0 ? violations.join('; ') : 'All circular sectors meet sales constraints',
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
  
  // Convert to polar coordinates and sort by angle to maintain circular structure
  const customersWithPolar = customers.map(customer => {
    const distance = calculateDistance(center.latitude, center.longitude, customer.latitude, customer.longitude);
    const angle = calculateAngle(center.latitude, center.longitude, customer.latitude, customer.longitude);
    
    return {
      ...customer,
      distance,
      angle: normalizeAngle(angle),
      salesScore: (customer.gr1Sale || 0) + (customer.gr2Sale || 0)
    };
  });
  
  // Sort by angle to maintain circular ordering
  customersWithPolar.sort((a, b) => a.angle - b.angle);
  
  // Create clusters ensuring both size and sales constraints while maintaining circular structure
  const clusters: Customer[][] = [];
  let currentCluster: Customer[] = [];
  let currentGR1 = 0;
  let currentGR2 = 0;
  
  customersWithPolar.forEach(item => {
    const customer = {
      id: item.id,
      latitude: item.latitude,
      longitude: item.longitude,
      outletName: item.outletName,
      gr1Sale: item.gr1Sale,
      gr2Sale: item.gr2Sale
    };
    
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
        console.log(`🚨 Circular fallback sector ${clusters.length - 1}: ${currentCluster.length} customers, GR1=${currentGR1.toLocaleString()}, GR2=${currentGR2.toLocaleString()}`);
      } else if (clusters.length > 0) {
        // Add to previous cluster if possible
        const lastCluster = clusters[clusters.length - 1];
        if (lastCluster.length + currentCluster.length <= maxSize) {
          lastCluster.push(...currentCluster);
          console.log(`🚨 Merged undersized circular sector with previous sector`);
        } else {
          // Cannot merge - this means we cannot create valid clusters
          throw new Error(`Cannot create valid circular sectors that meet sales constraints. Cluster would have GR1=${currentGR1.toLocaleString()} (required: ${MIN_GR1_SALE.toLocaleString()}) and GR2=${currentGR2.toLocaleString()} (required: ${MIN_GR2_SALE.toLocaleString()})`);
        }
      } else {
        // First cluster doesn't meet constraints - cannot proceed
        throw new Error(`Cannot create valid circular sectors that meet sales constraints. First cluster would have GR1=${currentGR1.toLocaleString()} (required: ${MIN_GR1_SALE.toLocaleString()}) and GR2=${currentGR2.toLocaleString()} (required: ${MIN_GR2_SALE.toLocaleString()})`);
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
      console.log(`🚨 Final circular fallback sector: ${currentCluster.length} customers, GR1=${currentGR1.toLocaleString()}, GR2=${currentGR2.toLocaleString()}`);
    } else if (clusters.length > 0) {
      // Add to last cluster
      const lastCluster = clusters[clusters.length - 1];
      if (lastCluster.length + currentCluster.length <= maxSize) {
        lastCluster.push(...currentCluster);
        console.log(`🚨 Added final customers to last circular sector`);
      } else {
        // Cannot merge final cluster - throw error
        throw new Error(`Cannot create valid circular sectors that meet sales constraints. Final cluster would have GR1=${currentGR1.toLocaleString()} (required: ${MIN_GR1_SALE.toLocaleString()}) and GR2=${currentGR2.toLocaleString()} (required: ${MIN_GR2_SALE.toLocaleString()})`);
      }
    } else {
      // Only cluster doesn't meet constraints - throw error
      throw new Error(`Cannot create valid circular sectors that meet sales constraints. Only cluster would have GR1=${currentGR1.toLocaleString()} (required: ${MIN_GR1_SALE.toLocaleString()}) and GR2=${currentGR2.toLocaleString()} (required: ${MIN_GR2_SALE.toLocaleString()})`);
    }
  }
  
  console.log(`🚨 Circular fallback created ${clusters.length} sectors`);
  
  // Final validation - ensure all clusters meet constraints
  clusters.forEach((cluster, index) => {
    const gr1Total = cluster.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
    const gr2Total = cluster.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
    const gr1Valid = gr1Total >= MIN_GR1_SALE;
    const gr2Valid = gr2Total >= MIN_GR2_SALE;
    
    if (!gr1Valid || !gr2Valid) {
      throw new Error(`Circular fallback sector ${index} still invalid: GR1=${gr1Total.toLocaleString()} (${gr1Valid ? '✅' : '❌'}), GR2=${gr2Total.toLocaleString()} (${gr2Valid ? '✅' : '❌'}). Cannot proceed with invalid clusters.`);
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