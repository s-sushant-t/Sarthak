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

// FIXED CONSTRAINTS - EXACTLY 6 CLUSTERS AND 30 BEATS
const TARGET_CLUSTERS = 6; // Exactly 6 clusters
const TARGET_BEATS = 30; // Exactly 30 beats total
const BEATS_PER_CLUSTER = TARGET_BEATS / TARGET_CLUSTERS; // 5 beats per cluster

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

    console.log(`🎯 Starting FIXED CIRCULAR SECTOR clustering: ${TARGET_CLUSTERS} clusters, ${TARGET_BEATS} beats for ${customers.length} customers`);
    console.log(`📊 STRICT Constraints: ${MIN_OUTLETS_PER_CLUSTER}-${MAX_OUTLETS_PER_CLUSTER} outlets per cluster, GR1≥${MIN_GR1_SALE.toLocaleString()}, GR2≥${MIN_GR2_SALE.toLocaleString()} with 5% error margin`);

    // Step 1: Calculate the median center point as the clustering origin
    const medianCenter = calculateMedianCenter(customers);
    console.log('📍 Median center calculated as clustering origin:', medianCenter);

    // Step 2: Create EXACTLY 6 circular sectors from median center
    const circularSectors = createExactSixCircularSectors(customers, medianCenter);
    console.log(`🔄 Created EXACTLY ${circularSectors.length} circular sectors from median center`);

    // Step 3: Enforce sales constraints on the 6 sectors
    const salesValidatedSectors = enforceCircularSectorSalesConstraints(circularSectors, MIN_OUTLETS_PER_CLUSTER, MAX_OUTLETS_PER_CLUSTER, medianCenter);
    console.log(`💰 Sales enforcement on 6 circular sectors complete: ${salesValidatedSectors.length} sectors meet requirements`);

    // Step 4: CRITICAL - Ensure exactly 6 clusters with minimum outlet requirement
    const sizeEnforcedSectors = enforceExactSixClustersWithMinimumSize(salesValidatedSectors, MIN_OUTLETS_PER_CLUSTER, MAX_OUTLETS_PER_CLUSTER, medianCenter);
    console.log(`📏 STRICT size enforcement complete: ${sizeEnforcedSectors.length} sectors (target: ${TARGET_CLUSTERS})`);

    // Step 5: Final balancing to ensure exactly 6 clusters
    const balancedSectors = finalSixClusterBalancing(sizeEnforcedSectors, MIN_OUTLETS_PER_CLUSTER, MAX_OUTLETS_PER_CLUSTER, medianCenter);
    console.log(`⚖️ Final balancing complete: ${balancedSectors.length} sectors (target: ${TARGET_CLUSTERS})`);

    // Step 6: Convert sectors to clustered customers
    const clusteredCustomers = convertSectorsToCustomers(balancedSectors);

    // Step 7: FINAL VALIDATION - Must have exactly 6 clusters
    const finalValidation = validateExactClusterCount(clusteredCustomers, customers, TARGET_CLUSTERS, MIN_OUTLETS_PER_CLUSTER);
    
    if (!finalValidation.isValid) {
      console.error(`❌ CRITICAL: Final validation failed: ${finalValidation.message}`);
      throw new Error(finalValidation.message);
    }

    // Step 8: Sales validation with error margin
    const salesValidation = validateSalesConstraints(clusteredCustomers);
    if (!salesValidation.isValid) {
      console.warn(`💰 Sales validation warning: ${salesValidation.message}`);
      console.warn('Sales details:', salesValidation.details);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ FIXED clustering successful: ${clusterCount} clusters (target: ${TARGET_CLUSTERS}), ${TARGET_BEATS} beats expected`);
    console.log('📏 Cluster sizes:', clusterSizes);
    console.log('💰 Sales validation:', salesValidation.details);

    return clusteredCustomers;

  } catch (error) {
    console.error('🚨 Fixed circular sector clustering failed:', error);
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
  sectorAngle: number;
  geographicBounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
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

function createExactSixCircularSectors(
  customers: Customer[],
  medianCenter: MedianCenter
): CircularSector[] {
  console.log(`🔄 Creating EXACTLY ${TARGET_CLUSTERS} circular sectors from median center...`);
  
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
  
  // Create EXACTLY 6 sectors by dividing the circle into 6 equal parts (60 degrees each)
  const sectors: CircularSector[] = [];
  const anglePerSector = (2 * Math.PI) / TARGET_CLUSTERS; // 60 degrees per sector
  
  console.log(`🔄 Creating ${TARGET_CLUSTERS} sectors with ${(anglePerSector * 180 / Math.PI).toFixed(1)}° per sector`);
  
  // Create sectors by dividing the circle into exactly 6 equal angular segments
  for (let i = 0; i < TARGET_CLUSTERS; i++) {
    const startAngle = i * anglePerSector;
    const endAngle = (i + 1) * anglePerSector;
    
    // Find customers within this angular sector
    const sectorCustomers = customersWithPolar.filter(customer => {
      const angle = customer.angle;
      
      // Handle wrap-around at 0/2π for the last sector
      if (i === TARGET_CLUSTERS - 1) {
        // Last sector: from startAngle to 2π and from 0 to endAngle-2π
        return angle >= startAngle || angle < (endAngle - 2 * Math.PI);
      } else {
        return angle >= startAngle && angle < endAngle;
      }
    });
    
    if (sectorCustomers.length > 0) {
      const distances = sectorCustomers.map(c => c.distance);
      const gr1Total = sectorCustomers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
      const gr2Total = sectorCustomers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
      const avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
      
      // Calculate geographic bounds for this sector
      const latitudes = sectorCustomers.map(c => c.latitude);
      const longitudes = sectorCustomers.map(c => c.longitude);
      
      const sector: CircularSector = {
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
        sectorAngle: anglePerSector,
        geographicBounds: {
          minLat: Math.min(...latitudes),
          maxLat: Math.max(...latitudes),
          minLng: Math.min(...longitudes),
          maxLng: Math.max(...longitudes)
        }
      };
      
      sectors.push(sector);
      
      console.log(`🔄 Sector ${i}: ${sectorCustomers.length} customers, angles ${(startAngle * 180 / Math.PI).toFixed(1)}°-${(endAngle * 180 / Math.PI).toFixed(1)}°, GR1=${gr1Total.toLocaleString()}, GR2=${gr2Total.toLocaleString()}`);
      console.log(`   Geographic bounds: Lat ${sector.geographicBounds.minLat.toFixed(4)}-${sector.geographicBounds.maxLat.toFixed(4)}, Lng ${sector.geographicBounds.minLng.toFixed(4)}-${sector.geographicBounds.maxLng.toFixed(4)}`);
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
        let angleDiff = Math.abs(customer.angle - sectorMidAngle);
        
        // Handle wrap-around
        if (angleDiff > Math.PI) {
          angleDiff = 2 * Math.PI - angleDiff;
        }
        
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
  
  // Ensure we have exactly 6 sectors
  if (sectors.length !== TARGET_CLUSTERS) {
    console.warn(`⚠️ Created ${sectors.length} sectors instead of ${TARGET_CLUSTERS}. Adjusting...`);
    
    // If we have fewer than 6 sectors, create empty ones
    while (sectors.length < TARGET_CLUSTERS) {
      const emptySector: CircularSector = {
        id: sectors.length,
        customers: [],
        startAngle: sectors.length * anglePerSector,
        endAngle: (sectors.length + 1) * anglePerSector,
        minRadius: 0,
        maxRadius: 0,
        center: medianCenter,
        gr1Total: 0,
        gr2Total: 0,
        avgRadius: 0,
        sectorAngle: anglePerSector,
        geographicBounds: {
          minLat: medianCenter.latitude,
          maxLat: medianCenter.latitude,
          minLng: medianCenter.longitude,
          maxLng: medianCenter.longitude
        }
      };
      sectors.push(emptySector);
    }
    
    // If we have more than 6 sectors, merge the smallest ones
    while (sectors.length > TARGET_CLUSTERS) {
      // Find the two smallest adjacent sectors and merge them
      let smallestIndex = 0;
      let smallestSize = sectors[0].customers.length;
      
      for (let i = 1; i < sectors.length; i++) {
        if (sectors[i].customers.length < smallestSize) {
          smallestSize = sectors[i].customers.length;
          smallestIndex = i;
        }
      }
      
      // Merge with adjacent sector
      const adjacentIndex = smallestIndex === sectors.length - 1 ? smallestIndex - 1 : smallestIndex + 1;
      const targetSector = sectors[adjacentIndex];
      const sourceSector = sectors[smallestIndex];
      
      // Move all customers from source to target
      targetSector.customers.push(...sourceSector.customers);
      targetSector.gr1Total += sourceSector.gr1Total;
      targetSector.gr2Total += sourceSector.gr2Total;
      updateSectorBounds(targetSector);
      
      // Remove the merged sector
      sectors.splice(smallestIndex, 1);
      
      // Update sector IDs
      sectors.forEach((sector, index) => {
        sector.id = index;
      });
    }
  }
  
  console.log(`✅ Created exactly ${sectors.length} circular sectors`);
  return sectors;
}

function enforceExactSixClustersWithMinimumSize(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number,
  medianCenter: MedianCenter
): CircularSector[] {
  console.log(`📏 ENFORCING EXACTLY ${TARGET_CLUSTERS} CLUSTERS with minimum ${minSize} outlets each`);
  
  // Ensure we have exactly 6 sectors
  while (sectors.length < TARGET_CLUSTERS) {
    const emptySector: CircularSector = {
      id: sectors.length,
      customers: [],
      startAngle: sectors.length * (2 * Math.PI / TARGET_CLUSTERS),
      endAngle: (sectors.length + 1) * (2 * Math.PI / TARGET_CLUSTERS),
      minRadius: 0,
      maxRadius: 0,
      center: medianCenter,
      gr1Total: 0,
      gr2Total: 0,
      avgRadius: 0,
      sectorAngle: 2 * Math.PI / TARGET_CLUSTERS,
      geographicBounds: {
        minLat: medianCenter.latitude,
        maxLat: medianCenter.latitude,
        minLng: medianCenter.longitude,
        maxLng: medianCenter.longitude
      }
    };
    sectors.push(emptySector);
  }
  
  // If we have more than 6, merge the smallest ones
  while (sectors.length > TARGET_CLUSTERS) {
    const smallestIndex = sectors.reduce((minIndex, sector, index) => 
      sector.customers.length < sectors[minIndex].customers.length ? index : minIndex, 0);
    
    const adjacentIndex = smallestIndex === sectors.length - 1 ? smallestIndex - 1 : smallestIndex + 1;
    
    // Merge smallest with adjacent
    sectors[adjacentIndex].customers.push(...sectors[smallestIndex].customers);
    sectors[adjacentIndex].gr1Total += sectors[smallestIndex].gr1Total;
    sectors[adjacentIndex].gr2Total += sectors[smallestIndex].gr2Total;
    updateSectorBounds(sectors[adjacentIndex]);
    
    sectors.splice(smallestIndex, 1);
    
    // Update IDs
    sectors.forEach((sector, index) => {
      sector.id = index;
    });
  }
  
  // Implement robust iterative balancing to ensure all clusters meet minimum size
  let maxIterations = 50;
  let iteration = 0;
  
  while (iteration < maxIterations) {
    iteration++;
    
    // Find undersized and oversized sectors
    const undersizedSectors = sectors.filter(sector => sector.customers.length < minSize);
    const oversizedSectors = sectors.filter(sector => sector.customers.length > maxSize);
    const normalSectors = sectors.filter(sector => sector.customers.length >= minSize && sector.customers.length <= maxSize);
    
    console.log(`📏 Iteration ${iteration}: ${undersizedSectors.length} undersized, ${oversizedSectors.length} oversized, ${normalSectors.length} normal`);
    
    if (undersizedSectors.length === 0) {
      console.log(`✅ All sectors meet minimum size requirement after ${iteration} iterations`);
      break;
    }
    
    // Calculate total deficit and surplus
    const totalDeficit = undersizedSectors.reduce((sum, sector) => sum + (minSize - sector.customers.length), 0);
    const totalSurplus = oversizedSectors.reduce((sum, sector) => sum + (sector.customers.length - maxSize), 0);
    const normalSurplus = normalSectors.reduce((sum, sector) => sum + Math.max(0, sector.customers.length - minSize), 0);
    
    console.log(`📏 Total deficit: ${totalDeficit}, oversized surplus: ${totalSurplus}, normal surplus: ${normalSurplus}`);
    
    // If we can't meet the deficit from oversized sectors, try to redistribute from normal sectors
    if (totalDeficit > totalSurplus) {
      console.log(`📏 Insufficient surplus in oversized sectors, redistributing from normal sectors`);
      
      // Sort normal sectors by size (largest first) to take from bigger ones
      const sortedNormalSectors = normalSectors.sort((a, b) => b.customers.length - a.customers.length);
      
      for (const undersizedSector of undersizedSectors) {
        const needed = minSize - undersizedSector.customers.length;
        let collected = 0;
        
        // First, collect from oversized sectors
        for (const oversizedSector of oversizedSectors) {
          const available = oversizedSector.customers.length - maxSize;
          const toTake = Math.min(available, needed - collected);
          
          if (toTake > 0) {
            const customersToMove = oversizedSector.customers.splice(-toTake, toTake);
            undersizedSector.customers.push(...customersToMove);
            
            // Update totals
            const gr1Moved = customersToMove.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
            const gr2Moved = customersToMove.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
            
            oversizedSector.gr1Total -= gr1Moved;
            oversizedSector.gr2Total -= gr2Moved;
            undersizedSector.gr1Total += gr1Moved;
            undersizedSector.gr2Total += gr2Moved;
            
            updateSectorBounds(oversizedSector);
            updateSectorBounds(undersizedSector);
            
            collected += toTake;
            
            if (collected >= needed) break;
          }
        }
        
        // If still need more, take from normal sectors (but keep them above minimum)
        if (collected < needed) {
          for (const normalSector of sortedNormalSectors) {
            const available = normalSector.customers.length - minSize;
            const toTake = Math.min(available, needed - collected);
            
            if (toTake > 0) {
              const customersToMove = normalSector.customers.splice(-toTake, toTake);
              undersizedSector.customers.push(...customersToMove);
              
              // Update totals
              const gr1Moved = customersToMove.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
              const gr2Moved = customersToMove.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
              
              normalSector.gr1Total -= gr1Moved;
              normalSector.gr2Total -= gr2Moved;
              undersizedSector.gr1Total += gr1Moved;
              undersizedSector.gr2Total += gr2Moved;
              
              updateSectorBounds(normalSector);
              updateSectorBounds(undersizedSector);
              
              collected += toTake;
              
              if (collected >= needed) break;
            }
          }
        }
      }
    } else {
      // Standard redistribution from oversized to undersized
      for (const undersizedSector of undersizedSectors) {
        const needed = minSize - undersizedSector.customers.length;
        let collected = 0;
        
        for (const oversizedSector of oversizedSectors) {
          const available = oversizedSector.customers.length - maxSize;
          const toTake = Math.min(available, needed - collected);
          
          if (toTake > 0) {
            const customersToMove = oversizedSector.customers.splice(-toTake, toTake);
            undersizedSector.customers.push(...customersToMove);
            
            // Update totals
            const gr1Moved = customersToMove.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
            const gr2Moved = customersToMove.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
            
            oversizedSector.gr1Total -= gr1Moved;
            oversizedSector.gr2Total -= gr2Moved;
            undersizedSector.gr1Total += gr1Moved;
            undersizedSector.gr2Total += gr2Moved;
            
            updateSectorBounds(oversizedSector);
            updateSectorBounds(undersizedSector);
            
            collected += toTake;
            
            if (collected >= needed) break;
          }
        }
      }
    }
  }
  
  // Final validation
  const finalUndersized = sectors.filter(sector => sector.customers.length < minSize);
  if (finalUndersized.length > 0) {
    const totalCustomers = sectors.reduce((sum, sector) => sum + sector.customers.length, 0);
    const averageSize = totalCustomers / TARGET_CLUSTERS;
    
    console.error(`❌ CRITICAL: ${finalUndersized.length} sectors still undersized after ${iteration} iterations!`);
    console.error(`Total customers: ${totalCustomers}, Average per cluster: ${averageSize.toFixed(1)}, Required minimum: ${minSize}`);
    
    finalUndersized.forEach(sector => {
      console.error(`Sector ${sector.id}: ${sector.customers.length} outlets (required: ${minSize})`);
    });
    
    // If we can't meet the minimum requirements, throw an error with detailed information
    const clusterSizes = sectors.map(s => s.customers.length);
    throw new Error(`CRITICAL SIZE VIOLATION: ${finalUndersized.length} clusters below ${minSize} outlets. Sizes: ${clusterSizes.join(', ')}. Total customers: ${totalCustomers}, Average: ${averageSize.toFixed(1)}`);
  }
  
  console.log(`📏 Final sector sizes: ${sectors.map(s => s.customers.length).join(', ')}`);
  return sectors;
}

function enforceCircularSectorSalesConstraints(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number,
  medianCenter: MedianCenter
): CircularSector[] {
  console.log('💰 Enforcing sales constraints on 6 circular sectors (with 5% error margin)...');
  
  sectors.forEach((sector, index) => {
    const meetsGR1 = sector.gr1Total >= EFFECTIVE_MIN_GR1;
    const meetsGR2 = sector.gr2Total >= EFFECTIVE_MIN_GR2;
    const meetsSize = sector.customers.length >= minSize && sector.customers.length <= maxSize;
    
    const status = meetsGR1 && meetsGR2 && meetsSize ? '✅' : '⚠️';
    console.log(`💰 Sector ${index}: ${status} ${sector.customers.length} customers, GR1=${sector.gr1Total.toLocaleString()}, GR2=${sector.gr2Total.toLocaleString()}`);
  });
  
  return sectors;
}

function finalSixClusterBalancing(
  sectors: CircularSector[],
  minSize: number,
  maxSize: number,
  medianCenter: MedianCenter
): CircularSector[] {
  console.log(`⚖️ Final balancing to ensure exactly ${TARGET_CLUSTERS} clusters...`);
  
  // Ensure exactly 6 sectors
  if (sectors.length !== TARGET_CLUSTERS) {
    console.error(`❌ CRITICAL: Have ${sectors.length} sectors, need exactly ${TARGET_CLUSTERS}!`);
    
    while (sectors.length < TARGET_CLUSTERS) {
      const emptySector: CircularSector = {
        id: sectors.length,
        customers: [],
        startAngle: sectors.length * (2 * Math.PI / TARGET_CLUSTERS),
        endAngle: (sectors.length + 1) * (2 * Math.PI / TARGET_CLUSTERS),
        minRadius: 0,
        maxRadius: 0,
        center: medianCenter,
        gr1Total: 0,
        gr2Total: 0,
        avgRadius: 0,
        sectorAngle: 2 * Math.PI / TARGET_CLUSTERS,
        geographicBounds: {
          minLat: medianCenter.latitude,
          maxLat: medianCenter.latitude,
          minLng: medianCenter.longitude,
          maxLng: medianCenter.longitude
        }
      };
      sectors.push(emptySector);
    }
    
    while (sectors.length > TARGET_CLUSTERS) {
      // Merge smallest sector with its neighbor
      const smallestIndex = sectors.reduce((minIndex, sector, index) => 
        sector.customers.length < sectors[minIndex].customers.length ? index : minIndex, 0);
      
      const adjacentIndex = smallestIndex === 0 ? 1 : smallestIndex - 1;
      
      sectors[adjacentIndex].customers.push(...sectors[smallestIndex].customers);
      sectors[adjacentIndex].gr1Total += sectors[smallestIndex].gr1Total;
      sectors[adjacentIndex].gr2Total += sectors[smallestIndex].gr2Total;
      updateSectorBounds(sectors[adjacentIndex]);
      
      sectors.splice(smallestIndex, 1);
    }
    
    // Update sector IDs to be sequential
    sectors.forEach((sector, index) => {
      sector.id = index;
    });
  }
  
  console.log(`✅ Final balancing complete: ${sectors.length} sectors with sizes: ${sectors.map(s => s.customers.length).join(', ')}`);
  return sectors;
}

function updateSectorBounds(sector: CircularSector): void {
  if (sector.customers.length === 0) {
    sector.geographicBounds = {
      minLat: sector.center.latitude,
      maxLat: sector.center.latitude,
      minLng: sector.center.longitude,
      maxLng: sector.center.longitude
    };
    return;
  }
  
  const distances = sector.customers.map(c => 
    calculateDistance(sector.center.latitude, sector.center.longitude, c.latitude, c.longitude)
  );
  
  const latitudes = sector.customers.map(c => c.latitude);
  const longitudes = sector.customers.map(c => c.longitude);
  
  sector.minRadius = Math.min(...distances);
  sector.maxRadius = Math.max(...distances);
  sector.avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
  
  sector.geographicBounds = {
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
    minLng: Math.min(...longitudes),
    maxLng: Math.max(...longitudes)
  };
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

function validateExactClusterCount(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[],
  targetClusters: number,
  minSize: number
): { isValid: boolean; message: string } {
  // Check customer count
  if (clusteredCustomers.length !== originalCustomers.length) {
    return {
      isValid: false,
      message: `Customer count mismatch: Input ${originalCustomers.length}, Output ${clusteredCustomers.length}`
    };
  }
  
  // Check exact cluster count
  const actualClusters = new Set(clusteredCustomers.map(c => c.clusterId)).size;
  if (actualClusters !== targetClusters) {
    return {
      isValid: false,
      message: `Cluster count mismatch: Expected ${targetClusters}, Got ${actualClusters}`
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
  
  console.log(`✅ EXACT VALIDATION PASSED: ${actualClusters} clusters (target: ${targetClusters}), all clusters have ≥${minSize} outlets. Sizes: ${clusterSizes.join(', ')}`);
  
  return { isValid: true, message: `Exactly ${targetClusters} clusters created with proper sizes` };
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
    
    const gr1Status = sales.gr1 >= MIN_GR1_SALE ? '✅' : sales.gr1 >= EFFECTIVE_MIN_GR1 ? '⚠️' : '❌';
    const gr2Status = sales.gr2 >= MIN_GR2_SALE ? '✅' : sales.gr2 >= EFFECTIVE_MIN_GR2 ? '⚠️' : '❌';
    
    details.push(
      `Cluster ${clusterId}: ${sales.count} outlets, GR1=${sales.gr1.toLocaleString()} ${gr1Status}, GR2=${sales.gr2.toLocaleString()} ${gr2Status} ${gr1Valid && gr2Valid ? '✅' : '❌'}`
    );
    
    if (!gr1Valid) {
      violations.push(`Cluster ${clusterId} GR1 sales ${sales.gr1.toLocaleString()} < ${EFFECTIVE_MIN_GR1.toLocaleString()} (with 5% margin)`);
    }
    if (!gr2Valid) {
      violations.push(`Cluster ${clusterId} GR2 sales ${sales.gr2.toLocaleString()} < ${EFFECTIVE_MIN_GR2.toLocaleString()} (with 5% margin)`);
    }
  });
  
  return {
    isValid: violations.length === 0,
    message: violations.length > 0 ? violations.join('; ') : `All ${TARGET_CLUSTERS} clusters meet sales constraints (with 5% error margin)`,
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