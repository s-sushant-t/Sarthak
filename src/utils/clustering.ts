import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

// Sales constraints with 5% error margin
const MIN_GR1_SALE = 600000;
const MIN_GR2_SALE = 250000;
const ERROR_MARGIN = 0.05; // 5% error margin

// Calculate effective minimums with error margin
const EFFECTIVE_MIN_GR1 = MIN_GR1_SALE * (1 - ERROR_MARGIN); // 570,000
const EFFECTIVE_MIN_GR2 = MIN_GR2_SALE * (1 - ERROR_MARGIN); // 237,500

// Updated outlet constraints - STRICTLY ENFORCED
const MIN_OUTLETS_PER_CLUSTER = 180; // Minimum 180 outlets per cluster - NO EXCEPTIONS
const MAX_OUTLETS_PER_CLUSTER = 240; // Maximum 240 outlets per cluster

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    console.log(`🎯 Starting CIRCULAR SECTOR clustering from median center for ${customers.length} customers`);
    console.log(`📊 STRICT Constraints: ${MIN_OUTLETS_PER_CLUSTER}-${MAX_OUTLETS_PER_CLUSTER} outlets (NO EXCEPTIONS), GR1≥${MIN_GR1_SALE.toLocaleString()} (effective: ${EFFECTIVE_MIN_GR1.toLocaleString()}), GR2≥${MIN_GR2_SALE.toLocaleString()} (effective: ${EFFECTIVE_MIN_GR2.toLocaleString()}) with 5% error margin`);

    // Step 1: Calculate the median center point as the clustering origin
    const medianCenter = calculateMedianCenter(customers);
    console.log('📍 Median center calculated as clustering origin:', medianCenter);

    // Step 2: Create circular sectors from median center with sales awareness
    const circularSectors = createCircularSectorsFromMedian(customers, medianCenter, MIN_OUTLETS_PER_CLUSTER, MAX_OUTLETS_PER_CLUSTER);
    console.log(`🔄 Created ${circularSectors.length} circular sectors from median center`);

    // Step 3: Enforce sales constraints on circular sectors while maintaining structure
    const salesValidatedSectors = enforceCircularSectorSalesConstraints(circularSectors, MIN_OUTLETS_PER_CLUSTER, MAX_OUTLETS_PER_CLUSTER, medianCenter);
    console.log(`💰 Sales enforcement on circular sectors complete: ${salesValidatedSectors.length} sectors meet requirements`);

    // Step 4: CRITICAL - Enforce minimum outlet requirement with ZERO tolerance
    const sizeEnforcedSectors = enforceStrictMinimumOutletRequirement(salesValidatedSectors, customers, MIN_OUTLETS_PER_CLUSTER, MAX_OUTLETS_PER_CLUSTER, medianCenter);
    console.log(`📏 STRICT size enforcement complete: ${sizeEnforcedSectors.length} sectors`);

    // Step 5: Final balancing while preserving circular structure and sales constraints
    const balancedSectors = finalCircularSectorBalancing(sizeEnforcedSectors, MIN_OUTLETS_PER_CLUSTER, MAX_OUTLETS_PER_CLUSTER, medianCenter);
    console.log(`⚖️ Final circular sector balancing complete: ${balancedSectors.length} sectors`);

    // Step 6: Convert sectors to clustered customers
    const clusteredCustomers = convertSectorsToCustomers(balancedSectors);

    // Step 7: FINAL VALIDATION - Absolutely no clusters under 180 outlets allowed
    const finalValidation = validateStrictOutletRequirement(clusteredCustomers, customers, MIN_OUTLETS_PER_CLUSTER);
    
    if (!finalValidation.isValid) {
      console.error(`❌ CRITICAL: Final validation failed: ${finalValidation.message}`);
      throw new Error(finalValidation.message);
    }

    // Step 8: Sales validation with error margin
    const salesValidation = validateSalesConstraints(clusteredCustomers);
    if (!salesValidation.isValid) {
      console.warn(`💰 Sales validation warning: ${salesValidation.message}`);
      console.warn('Sales details:', salesValidation.details);
      // Don't fail on sales validation if size requirements are met
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ Circular sector clustering successful: ${clusterCount} sectors`);
    console.log('📏 Sector sizes:', clusterSizes);
    console.log('💰 Sales validation:', salesValidation.details);

    return clusteredCustomers;

  } catch (error) {
    console.error('🚨 Circular sector clustering failed:', error);
    throw error;
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
  
  // Estimate sectors needed based on STRICT size constraints first
  const maxSectorsForSize = Math.floor(customers.length / minSize); // Maximum sectors we can create with minimum size
  const minSectorsForSize = Math.ceil(customers.length / maxSize); // Minimum sectors needed to fit all customers
  
  // Estimate sectors needed based on sales constraints (using effective minimums)
  const minSectorsForGR1 = Math.ceil(totalGR1 / (EFFECTIVE_MIN_GR1 * 1.1)); // 10% buffer
  const minSectorsForGR2 = Math.ceil(totalGR2 / (EFFECTIVE_MIN_GR2 * 1.1)); // 10% buffer
  
  // CRITICAL: Size constraints take priority - we cannot create more sectors than size allows
  const finalSectorCount = Math.min(
    maxSectorsForSize, // Cannot exceed this without violating minimum size
    Math.max(
      minSectorsForSize, // Need at least this many to fit all customers
      minSectorsForGR1,
      minSectorsForGR2
    )
  );
  
  console.log(`🔄 Circular sector calculation from median center (STRICT size enforcement):
    - Max sectors for size (${minSize} min): ${maxSectorsForSize}
    - Min sectors for size (${maxSize} max): ${minSectorsForSize}
    - Min sectors for GR1: ${minSectorsForGR1}
    - Min sectors for GR2: ${minSectorsForGR2}
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
  maxSize: number,
  medianCenter: MedianCenter
): CircularSector[] {
  console.log('💰 Enforcing sales constraints on circular sectors (with 5% error margin)...');
  
  const validSectors: CircularSector[] = [];
  const invalidSectors: CircularSector[] = [];
  
  // Classify sectors based on sales constraints (using effective minimums with error margin)
  sectors.forEach(sector => {
    const meetsGR1 = sector.gr1Total >= EFFECTIVE_MIN_GR1;
    const meetsGR2 = sector.gr2Total >= EFFECTIVE_MIN_GR2;
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
          
          if (newSector.gr1Total >= EFFECTIVE_MIN_GR1 && newSector.gr2Total >= EFFECTIVE_MIN_GR2) {
            validSectors.push(newSector);
            console.log(`🆕 Created new valid circular sector ${newSector.id} with ${newSector.customers.length} customers`);
          } else {
            // If new sector doesn't meet sales constraints, distribute to existing sectors
            console.log(`🔄 New circular sector doesn't meet sales constraints, distributing to existing sectors`);
            distributeCustomersToExistingCircularSectors(newSectorCustomers, validSectors, maxSize, minSize, medianCenter);
          }
        } else {
          break;
        }
      }
      
      // Distribute any remaining customers to existing sectors
      if (unassignedCustomers.length > 0) {
        distributeCustomersToExistingCircularSectors(unassignedCustomers, validSectors, maxSize, minSize, medianCenter);
      }
    });
  }
  
  return validSectors;
}

function enforceStrictMinimumOutletRequirement(
  sectors: CircularSector[],
  allCustomers: Customer[],
  minSize: number,
  maxSize: number,
  medianCenter: MedianCenter
): CircularSector[] {
  console.log(`📏 ENFORCING STRICT MINIMUM OUTLET REQUIREMENT: ${minSize} outlets per cluster (NO EXCEPTIONS)`);
  
  const validSectors: CircularSector[] = [];
  const undersizedSectors: CircularSector[] = [];
  
  // Classify sectors by size
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize) {
      validSectors.push(sector);
      console.log(`📏 Sector ${sector.id}: ✅ Valid size (${sector.customers.length} outlets)`);
    } else {
      undersizedSectors.push(sector);
      console.warn(`📏 Sector ${sector.id}: ❌ UNDERSIZED (${sector.customers.length} outlets < ${minSize})`);
    }
  });
  
  if (undersizedSectors.length === 0) {
    console.log(`📏 All sectors meet minimum size requirement`);
    return validSectors;
  }
  
  console.log(`📏 CRITICAL: ${undersizedSectors.length} sectors are undersized. Applying emergency redistribution...`);
  
  // Collect all customers from undersized sectors
  const customersToRedistribute = undersizedSectors.flatMap(sector => sector.customers);
  console.log(`📏 Redistributing ${customersToRedistribute.length} customers from undersized sectors`);
  
  // Strategy: Try to merge undersized sectors with valid sectors that have capacity
  distributeCustomersToExistingCircularSectors(
    customersToRedistribute, 
    validSectors, 
    maxSize, 
    minSize, 
    medianCenter
  );
  
  return validSectors;
}

function finalCircularSectorBalancing(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number,
  medianCenter: MedianCenter
): CircularSector[] {
  console.log('⚖️ Final circular sector balancing (with STRICT size enforcement)...');
  
  // CRITICAL: First check that ALL sectors meet minimum size requirement
  const undersizedSectors = sectors.filter(sector => sector.customers.length < minSize);
  
  if (undersizedSectors.length > 0) {
    console.error(`⚖️ CRITICAL: ${undersizedSectors.length} sectors still undersized in final balancing!`);
    undersizedSectors.forEach(sector => {
      console.error(`Sector ${sector.id}: ${sector.customers.length} outlets (required: ${minSize})`);
    });
    
    // Emergency redistribution
    return emergencyFinalRedistribution(sectors, minSize, maxSize, medianCenter);
  }
  
  // Validate all sectors meet sales constraints (using effective minimums)
  const invalidSectors = sectors.filter(sector => 
    sector.gr1Total < EFFECTIVE_MIN_GR1 || sector.gr2Total < EFFECTIVE_MIN_GR2
  );
  
  if (invalidSectors.length > 0) {
    console.warn(`💰 WARNING: ${invalidSectors.length} circular sectors don't meet sales constraints (with 5% margin)!`);
    invalidSectors.forEach(sector => {
      console.warn(`Circular Sector ${sector.id}: GR1=${sector.gr1Total.toLocaleString()} (required: ${EFFECTIVE_MIN_GR1.toLocaleString()}), GR2=${sector.gr2Total.toLocaleString()} (required: ${EFFECTIVE_MIN_GR2.toLocaleString()})`);
    });
    // Continue with warning - size is more critical than sales
  }
  
  // Check for size violations and fix them while maintaining minimum size requirement
  const balancedSectors: CircularSector[] = [];
  
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize && sector.customers.length <= maxSize) {
      balancedSectors.push(sector);
    } else if (sector.customers.length > maxSize) {
      // Split oversized sector while maintaining minimum size requirement
      const splitSectors = splitCircularSectorWithStrictSizeConstraints(sector, maxSize, minSize);
      balancedSectors.push(...splitSectors);
    } else {
      // This should not happen after strict enforcement, but handle it
      console.error(`⚖️ UNEXPECTED: Undersized sector ${sector.id} in final balancing!`);
      balancedSectors.push(sector);
    }
  });
  
  return balancedSectors;
}

function emergencyFinalRedistribution(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number,
  medianCenter: MedianCenter
): CircularSector[] {
  console.log('🚨 Emergency final redistribution to meet minimum size requirements...');
  
  const validSectors: CircularSector[] = [];
  const undersizedSectors: CircularSector[] = [];
  
  sectors.forEach(sector => {
    if (sector.customers.length >= minSize) {
      validSectors.push(sector);
    } else {
      undersizedSectors.push(sector);
    }
  });
  
  // Collect all customers from undersized sectors
  const customersToRedistribute = undersizedSectors.flatMap(sector => sector.customers);
  
  // Redistribute to valid sectors with capacity, ensuring no customers are lost
  distributeCustomersToExistingCircularSectors(customersToRedistribute, validSectors, maxSize, minSize, medianCenter);
  
  return validSectors;
}

function splitCircularSectorWithStrictSizeConstraints(
  sector: CircularSector,
  maxSize: number,
  minSize: number
): CircularSector[] {
  const customers = sector.customers;
  
  // Calculate how many sectors we need
  const numSectors = Math.ceil(customers.length / maxSize);
  const customersPerSector = Math.floor(customers.length / numSectors);
  
  // Ensure each sector will have at least minSize customers
  if (customersPerSector < minSize) {
    console.warn(`Cannot split sector ${sector.id} while maintaining minimum size. Keeping as oversized.`);
    return [sector];
  }
  
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
  let sectorId = sector.id;
  
  // Distribute customers ensuring each group meets minimum size
  for (let i = 0; i < numSectors; i++) {
    const startIndex = i * customersPerSector;
    let endIndex = (i + 1) * customersPerSector;
    
    // For the last sector, include all remaining customers
    if (i === numSectors - 1) {
      endIndex = customers.length;
    }
    
    const sectorCustomers = customersWithAngles.slice(startIndex, endIndex).map(item => item.customer);
    
    if (sectorCustomers.length >= minSize) {
      const startAngle = customersWithAngles[startIndex].angle;
      const endAngle = customersWithAngles[Math.min(endIndex - 1, customersWithAngles.length - 1)].angle;
      
      const newSector = createCircularSectorWithAngles(
        sectorCustomers,
        sector.center,
        sectorId++,
        startAngle,
        endAngle
      );
      sectors.push(newSector);
    }
  }
  
  return sectors.length > 0 ? sectors : [sector]; // Return original if split failed
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
  
  // Greedily select customers to meet sales constraints (using effective minimums)
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
    if (selected.length >= minSize && currentGR1 >= EFFECTIVE_MIN_GR1 && currentGR2 >= EFFECTIVE_MIN_GR2) {
      break;
    }
  }
  
  // Only return if we meet sales constraints (using effective minimums)
  if (currentGR1 >= EFFECTIVE_MIN_GR1 && currentGR2 >= EFFECTIVE_MIN_GR2 && selected.length >= minSize) {
    return selected;
  }
  
  return [];
}

function distributeCustomersToExistingCircularSectors(
  customers: Customer[],
  sectors: CircularSector[],
  maxSize: number,
  minSize: number,
  medianCenter: MedianCenter
): Customer[] {
  const redistributedCustomers: Customer[] = [];
  const remainingCustomers = [...customers];
  
  // First pass: Try to place customers in sectors with capacity
  for (let i = remainingCustomers.length - 1; i >= 0; i--) {
    const customer = remainingCustomers[i];
    
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
      redistributedCustomers.push(customer);
      remainingCustomers.splice(i, 1);
      console.log(`🔄 Distributed customer ${customer.id} to circular sector ${bestSector.id}`);
    }
  }
  
  // Second pass: Force-assign remaining customers to prevent loss
  if (remainingCustomers.length > 0) {
    console.warn(`🚨 Force-assigning ${remainingCustomers.length} customers to prevent loss`);
    
    // If we can create a new sector with minimum size, do that
    if (remainingCustomers.length >= minSize) {
      const newSector = createNewCircularSector(
        remainingCustomers,
        medianCenter,
        Math.max(...sectors.map(s => s.id)) + 1
      );
      sectors.push(newSector);
      redistributedCustomers.push(...remainingCustomers);
      console.log(`🆕 Created new sector ${newSector.id} for ${remainingCustomers.length} remaining customers`);
    } else {
      // Force-assign to existing sectors (even if it exceeds maxSize)
      remainingCustomers.forEach(customer => {
        // Find the sector with the fewest customers to minimize size violation
        const smallestSector = sectors.reduce((smallest, sector) => 
          sector.customers.length < smallest.customers.length ? sector : smallest
        );
        
        smallestSector.customers.push(customer);
        smallestSector.gr1Total += customer.gr1Sale || 0;
        smallestSector.gr2Total += customer.gr2Sale || 0;
        updateSectorBounds(smallestSector);
        redistributedCustomers.push(customer);
        console.warn(`🚨 Force-assigned customer ${customer.id} to sector ${smallestSector.id} (now ${smallestSector.customers.length} outlets)`);
      });
    }
  }
  
  return redistributedCustomers;
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

function validateStrictOutletRequirement(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  minSize: number
): { isValid: boolean; message: string } {
  // Check customer count
  if (clusteredCustomers.length !== originalCustomers.length) {
    return {
      isValid: false,
      message: `Customer count mismatch: Input ${originalCustomers.length}, Output ${clusteredCustomers.length}`
    };
  }
  
  // Check cluster sizes - ZERO TOLERANCE for undersized clusters
  const clusterSizes = getClusterSizes(clusteredCustomers);
  const undersizedClusters = clusterSizes.filter(size => size < minSize);
  
  if (undersizedClusters.length > 0) {
    return {
      isValid: false,
      message: `CRITICAL SIZE VIOLATION: ${undersizedClusters.length} clusters below ${minSize} outlets. Sizes: ${undersizedClusters.join(', ')}`
    };
  }
  
  console.log(`✅ STRICT VALIDATION PASSED: All clusters have ≥${minSize} outlets. Sizes: ${clusterSizes.join(', ')}`);
  
  return { isValid: true, message: 'All clusters meet strict minimum outlet requirement' };
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
    const gr1Valid = sales.gr1 >= EFFECTIVE_MIN_GR1;
    const gr2Valid = sales.gr2 >= EFFECTIVE_MIN_GR2;
    
    // Show both effective and target values for clarity
    const gr1Status = sales.gr1 >= MIN_GR1_SALE ? '✅' : sales.gr1 >= EFFECTIVE_MIN_GR1 ? '⚠️' : '❌';
    const gr2Status = sales.gr2 >= MIN_GR2_SALE ? '✅' : sales.gr2 >= EFFECTIVE_MIN_GR2 ? '⚠️' : '❌';
    
    details.push(
      `Circular Sector ${clusterId}: ${sales.count} outlets, GR1=${sales.gr1.toLocaleString()} ${gr1Status}, GR2=${sales.gr2.toLocaleString()} ${gr2Status} ${gr1Valid && gr2Valid ? '✅' : '❌'}`
    );
    
    if (!gr1Valid) {
      violations.push(`Circular Sector ${clusterId} GR1 sales ${sales.gr1.toLocaleString()} < ${EFFECTIVE_MIN_GR1.toLocaleString()} (with 5% margin)`);
    }
    if (!gr2Valid) {
      violations.push(`Circular Sector ${clusterId} GR2 sales ${sales.gr2.toLocaleString()} < ${EFFECTIVE_MIN_GR2.toLocaleString()} (with 5% margin)`);
    }
  });
  
  return {
    isValid: violations.length === 0,
    message: violations.length > 0 ? violations.join('; ') : 'All circular sectors meet sales constraints (with 5% error margin)',
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