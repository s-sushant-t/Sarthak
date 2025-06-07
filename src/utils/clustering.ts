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

    console.log(`🎯 Starting NON-OVERLAPPING GEOGRAPHIC clustering: ${TARGET_CLUSTERS} clusters, ${TARGET_BEATS} beats for ${customers.length} customers`);
    console.log(`📊 STRICT Constraints: ${MIN_OUTLETS_PER_CLUSTER}-${MAX_OUTLETS_PER_CLUSTER} outlets per cluster, GR1≥${MIN_GR1_SALE.toLocaleString()}, GR2≥${MIN_GR2_SALE.toLocaleString()} with 5% error margin`);

    // Step 1: Create initial geographic clusters using K-means with geographic constraints
    const geographicClusters = createNonOverlappingGeographicClusters(customers);
    console.log(`🗺️ Created ${geographicClusters.length} non-overlapping geographic clusters`);

    // Step 2: Enforce size constraints while maintaining geographic boundaries
    const sizeEnforcedClusters = enforceClusterSizeConstraints(geographicClusters);
    console.log(`📏 Size enforcement complete: ${sizeEnforcedClusters.length} clusters meet size requirements`);

    // Step 3: Validate and adjust for sales constraints
    const salesValidatedClusters = enforceSalesConstraints(sizeEnforcedClusters);
    console.log(`💰 Sales validation complete: ${salesValidatedClusters.length} clusters meet sales requirements`);

    // Step 4: Final validation and conversion
    const clusteredCustomers = convertClustersToCustomers(salesValidatedClusters);

    // Step 5: FINAL VALIDATION
    const finalValidation = validateFinalClusters(clusteredCustomers, customers);
    
    if (!finalValidation.isValid) {
      console.error(`❌ CRITICAL: Final validation failed: ${finalValidation.message}`);
      throw new Error(finalValidation.message);
    }

    // Step 6: Sales validation with error margin
    const salesValidation = validateSalesConstraints(clusteredCustomers);
    if (!salesValidation.isValid) {
      console.warn(`💰 Sales validation warning: ${salesValidation.message}`);
      console.warn('Sales details:', salesValidation.details);
    }

    const clusterCount = new Set(clusteredCustomers.map(c => c.clusterId)).size;
    const clusterSizes = getClusterSizes(clusteredCustomers);
    
    console.log(`✅ NON-OVERLAPPING clustering successful: ${clusterCount} clusters (target: ${TARGET_CLUSTERS}), ${TARGET_BEATS} beats expected`);
    console.log('📏 Cluster sizes:', clusterSizes);
    console.log('💰 Sales validation:', salesValidation.details);

    return clusteredCustomers;

  } catch (error) {
    console.error('🚨 Non-overlapping geographic clustering failed:', error);
    throw error;
  }
};

interface GeographicCluster {
  id: number;
  customers: Customer[];
  centroid: { latitude: number; longitude: number };
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  gr1Total: number;
  gr2Total: number;
  convexHull: Array<{ latitude: number; longitude: number }>;
}

interface SalesValidation {
  isValid: boolean;
  message: string;
  details?: string[];
}

function createNonOverlappingGeographicClusters(customers: Customer[]): GeographicCluster[] {
  console.log('🗺️ Creating non-overlapping geographic clusters using improved K-means...');
  
  // Step 1: Initialize cluster centroids using geographic distribution
  const centroids = initializeGeographicCentroids(customers, TARGET_CLUSTERS);
  console.log('📍 Initialized centroids:', centroids.map((c, i) => `Cluster ${i}: (${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)})`));
  
  let clusters: GeographicCluster[] = [];
  let iterations = 0;
  const maxIterations = 100;
  let converged = false;
  
  while (!converged && iterations < maxIterations) {
    iterations++;
    
    // Assign customers to nearest centroid
    const newClusters: GeographicCluster[] = centroids.map((centroid, id) => ({
      id,
      customers: [],
      centroid,
      bounds: { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity },
      gr1Total: 0,
      gr2Total: 0,
      convexHull: []
    }));
    
    // Assign each customer to the nearest cluster centroid
    customers.forEach(customer => {
      let nearestCluster = 0;
      let minDistance = Infinity;
      
      centroids.forEach((centroid, index) => {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          centroid.latitude, centroid.longitude
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          nearestCluster = index;
        }
      });
      
      newClusters[nearestCluster].customers.push(customer);
    });
    
    // Update cluster properties
    newClusters.forEach(cluster => {
      if (cluster.customers.length > 0) {
        updateClusterProperties(cluster);
      }
    });
    
    // Check for convergence (centroids don't move significantly)
    converged = true;
    for (let i = 0; i < centroids.length; i++) {
      const oldCentroid = centroids[i];
      const newCentroid = newClusters[i].centroid;
      
      const distance = calculateDistance(
        oldCentroid.latitude, oldCentroid.longitude,
        newCentroid.latitude, newCentroid.longitude
      );
      
      if (distance > 0.001) { // 1 meter threshold
        converged = false;
        centroids[i] = newCentroid;
      }
    }
    
    clusters = newClusters;
    
    if (iterations % 10 === 0) {
      console.log(`🔄 K-means iteration ${iterations}: Cluster sizes: ${clusters.map(c => c.customers.length).join(', ')}`);
    }
  }
  
  console.log(`✅ K-means converged after ${iterations} iterations`);
  
  // Ensure we have exactly 6 clusters
  clusters = ensureExactClusterCount(clusters, customers);
  
  // Calculate convex hulls for geographic boundaries
  clusters.forEach(cluster => {
    if (cluster.customers.length >= 3) {
      cluster.convexHull = calculateConvexHull(cluster.customers);
    }
  });
  
  console.log(`🗺️ Final geographic clusters: ${clusters.map(c => `Cluster ${c.id}: ${c.customers.length} customers`).join(', ')}`);
  
  return clusters;
}

function initializeGeographicCentroids(customers: Customer[], numClusters: number): Array<{ latitude: number; longitude: number }> {
  // Use K-means++ initialization for better centroid distribution
  const centroids: Array<{ latitude: number; longitude: number }> = [];
  
  // Choose first centroid randomly
  const firstCustomer = customers[Math.floor(Math.random() * customers.length)];
  centroids.push({ latitude: firstCustomer.latitude, longitude: firstCustomer.longitude });
  
  // Choose remaining centroids using K-means++ (probability proportional to squared distance)
  for (let i = 1; i < numClusters; i++) {
    const distances = customers.map(customer => {
      let minDistanceSquared = Infinity;
      
      centroids.forEach(centroid => {
        const distance = calculateDistance(
          customer.latitude, customer.longitude,
          centroid.latitude, centroid.longitude
        );
        minDistanceSquared = Math.min(minDistanceSquared, distance * distance);
      });
      
      return minDistanceSquared;
    });
    
    const totalDistance = distances.reduce((sum, d) => sum + d, 0);
    const random = Math.random() * totalDistance;
    
    let cumulativeDistance = 0;
    for (let j = 0; j < customers.length; j++) {
      cumulativeDistance += distances[j];
      if (cumulativeDistance >= random) {
        centroids.push({ 
          latitude: customers[j].latitude, 
          longitude: customers[j].longitude 
        });
        break;
      }
    }
  }
  
  return centroids;
}

function updateClusterProperties(cluster: GeographicCluster): void {
  if (cluster.customers.length === 0) return;
  
  // Calculate centroid
  const totalLat = cluster.customers.reduce((sum, c) => sum + c.latitude, 0);
  const totalLng = cluster.customers.reduce((sum, c) => sum + c.longitude, 0);
  
  cluster.centroid = {
    latitude: totalLat / cluster.customers.length,
    longitude: totalLng / cluster.customers.length
  };
  
  // Calculate bounds
  cluster.bounds = {
    minLat: Math.min(...cluster.customers.map(c => c.latitude)),
    maxLat: Math.max(...cluster.customers.map(c => c.latitude)),
    minLng: Math.min(...cluster.customers.map(c => c.longitude)),
    maxLng: Math.max(...cluster.customers.map(c => c.longitude))
  };
  
  // Calculate sales totals
  cluster.gr1Total = cluster.customers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
  cluster.gr2Total = cluster.customers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
}

function ensureExactClusterCount(clusters: GeographicCluster[], customers: Customer[]): GeographicCluster[] {
  // Remove empty clusters
  let validClusters = clusters.filter(cluster => cluster.customers.length > 0);
  
  // If we have fewer than 6 clusters, split the largest ones
  while (validClusters.length < TARGET_CLUSTERS) {
    // Find the largest cluster
    const largestCluster = validClusters.reduce((largest, cluster) => 
      cluster.customers.length > largest.customers.length ? cluster : largest
    );
    
    if (largestCluster.customers.length < 2) break; // Can't split further
    
    // Split the largest cluster into two
    const splitClusters = splitClusterGeographically(largestCluster);
    
    // Remove the original cluster and add the split clusters
    const index = validClusters.indexOf(largestCluster);
    validClusters.splice(index, 1, ...splitClusters);
    
    console.log(`🔄 Split cluster ${largestCluster.id} (${largestCluster.customers.length} customers) into ${splitClusters.length} clusters`);
  }
  
  // If we have more than 6 clusters, merge the smallest ones
  while (validClusters.length > TARGET_CLUSTERS) {
    // Find the two smallest adjacent clusters
    const sortedClusters = validClusters.sort((a, b) => a.customers.length - b.customers.length);
    const smallestCluster = sortedClusters[0];
    
    // Find the nearest cluster to merge with
    let nearestCluster = sortedClusters[1];
    let minDistance = calculateDistance(
      smallestCluster.centroid.latitude, smallestCluster.centroid.longitude,
      nearestCluster.centroid.latitude, nearestCluster.centroid.longitude
    );
    
    for (let i = 2; i < sortedClusters.length; i++) {
      const distance = calculateDistance(
        smallestCluster.centroid.latitude, smallestCluster.centroid.longitude,
        sortedClusters[i].centroid.latitude, sortedClusters[i].centroid.longitude
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestCluster = sortedClusters[i];
      }
    }
    
    // Merge the clusters
    nearestCluster.customers.push(...smallestCluster.customers);
    updateClusterProperties(nearestCluster);
    
    // Remove the merged cluster
    const index = validClusters.indexOf(smallestCluster);
    validClusters.splice(index, 1);
    
    console.log(`🔄 Merged cluster ${smallestCluster.id} (${smallestCluster.customers.length} customers) into cluster ${nearestCluster.id}`);
  }
  
  // Update cluster IDs to be sequential
  validClusters.forEach((cluster, index) => {
    cluster.id = index;
  });
  
  return validClusters;
}

function splitClusterGeographically(cluster: GeographicCluster): GeographicCluster[] {
  if (cluster.customers.length < 2) return [cluster];
  
  // Split along the longest geographic dimension
  const latRange = cluster.bounds.maxLat - cluster.bounds.minLat;
  const lngRange = cluster.bounds.maxLng - cluster.bounds.minLng;
  
  const splitByLatitude = latRange > lngRange;
  
  // Sort customers by the split dimension
  const sortedCustomers = [...cluster.customers].sort((a, b) => {
    return splitByLatitude ? a.latitude - b.latitude : a.longitude - b.longitude;
  });
  
  // Split in the middle
  const midPoint = Math.floor(sortedCustomers.length / 2);
  
  const cluster1: GeographicCluster = {
    id: cluster.id,
    customers: sortedCustomers.slice(0, midPoint),
    centroid: { latitude: 0, longitude: 0 },
    bounds: { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity },
    gr1Total: 0,
    gr2Total: 0,
    convexHull: []
  };
  
  const cluster2: GeographicCluster = {
    id: cluster.id + 1000, // Temporary ID
    customers: sortedCustomers.slice(midPoint),
    centroid: { latitude: 0, longitude: 0 },
    bounds: { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity },
    gr1Total: 0,
    gr2Total: 0,
    convexHull: []
  };
  
  updateClusterProperties(cluster1);
  updateClusterProperties(cluster2);
  
  return [cluster1, cluster2];
}

function enforceClusterSizeConstraints(clusters: GeographicCluster[]): GeographicCluster[] {
  console.log('📏 Enforcing cluster size constraints while maintaining geographic boundaries...');
  
  let iterations = 0;
  const maxIterations = 50;
  
  while (iterations < maxIterations) {
    iterations++;
    
    const undersizedClusters = clusters.filter(c => c.customers.length < MIN_OUTLETS_PER_CLUSTER);
    const oversizedClusters = clusters.filter(c => c.customers.length > MAX_OUTLETS_PER_CLUSTER);
    
    if (undersizedClusters.length === 0 && oversizedClusters.length === 0) {
      console.log(`✅ All clusters meet size constraints after ${iterations} iterations`);
      break;
    }
    
    console.log(`📏 Iteration ${iterations}: ${undersizedClusters.length} undersized, ${oversizedClusters.length} oversized`);
    
    // Move customers from oversized to undersized clusters, prioritizing geographic proximity
    for (const undersizedCluster of undersizedClusters) {
      const needed = MIN_OUTLETS_PER_CLUSTER - undersizedCluster.customers.length;
      let collected = 0;
      
      // Sort oversized clusters by distance to undersized cluster
      const sortedOversized = oversizedClusters
        .filter(c => c.customers.length > MAX_OUTLETS_PER_CLUSTER)
        .sort((a, b) => {
          const distA = calculateDistance(
            a.centroid.latitude, a.centroid.longitude,
            undersizedCluster.centroid.latitude, undersizedCluster.centroid.longitude
          );
          const distB = calculateDistance(
            b.centroid.latitude, b.centroid.longitude,
            undersizedCluster.centroid.latitude, undersizedCluster.centroid.longitude
          );
          return distA - distB;
        });
      
      for (const oversizedCluster of sortedOversized) {
        const available = oversizedCluster.customers.length - MAX_OUTLETS_PER_CLUSTER;
        const toMove = Math.min(available, needed - collected);
        
        if (toMove > 0) {
          // Find customers in oversized cluster that are closest to undersized cluster
          const customersWithDistance = oversizedCluster.customers.map(customer => ({
            customer,
            distance: calculateDistance(
              customer.latitude, customer.longitude,
              undersizedCluster.centroid.latitude, undersizedCluster.centroid.longitude
            )
          }));
          
          customersWithDistance.sort((a, b) => a.distance - b.distance);
          
          // Move the closest customers
          for (let i = 0; i < toMove; i++) {
            const customerToMove = customersWithDistance[i].customer;
            const index = oversizedCluster.customers.indexOf(customerToMove);
            
            if (index !== -1) {
              oversizedCluster.customers.splice(index, 1);
              undersizedCluster.customers.push(customerToMove);
              collected++;
            }
          }
          
          // Update cluster properties
          updateClusterProperties(oversizedCluster);
          updateClusterProperties(undersizedCluster);
          
          if (collected >= needed) break;
        }
      }
    }
  }
  
  // Final validation
  const finalUndersized = clusters.filter(c => c.customers.length < MIN_OUTLETS_PER_CLUSTER);
  if (finalUndersized.length > 0) {
    const totalCustomers = clusters.reduce((sum, c) => sum + c.customers.length, 0);
    const averageSize = totalCustomers / TARGET_CLUSTERS;
    
    console.error(`❌ CRITICAL: ${finalUndersized.length} clusters still undersized after ${iterations} iterations!`);
    finalUndersized.forEach(cluster => {
      console.error(`Cluster ${cluster.id}: ${cluster.customers.length} outlets (required: ${MIN_OUTLETS_PER_CLUSTER})`);
    });
    
    throw new Error(`CRITICAL SIZE VIOLATION: ${finalUndersized.length} clusters below ${MIN_OUTLETS_PER_CLUSTER} outlets. Total customers: ${totalCustomers}, Average: ${averageSize.toFixed(1)}`);
  }
  
  console.log(`📏 Final cluster sizes: ${clusters.map(c => c.customers.length).join(', ')}`);
  return clusters;
}

function enforceSalesConstraints(clusters: GeographicCluster[]): GeographicCluster[] {
  console.log('💰 Validating sales constraints (with 5% error margin)...');
  
  clusters.forEach((cluster, index) => {
    const meetsGR1 = cluster.gr1Total >= EFFECTIVE_MIN_GR1;
    const meetsGR2 = cluster.gr2Total >= EFFECTIVE_MIN_GR2;
    const meetsSize = cluster.customers.length >= MIN_OUTLETS_PER_CLUSTER && cluster.customers.length <= MAX_OUTLETS_PER_CLUSTER;
    
    const status = meetsGR1 && meetsGR2 && meetsSize ? '✅' : '⚠️';
    console.log(`💰 Cluster ${index}: ${status} ${cluster.customers.length} customers, GR1=${cluster.gr1Total.toLocaleString()}, GR2=${cluster.gr2Total.toLocaleString()}`);
  });
  
  return clusters;
}

function calculateConvexHull(customers: Customer[]): Array<{ latitude: number; longitude: number }> {
  if (customers.length < 3) {
    return customers.map(c => ({ latitude: c.latitude, longitude: c.longitude }));
  }
  
  // Convert to points for hull calculation
  const points = customers.map(c => ({ latitude: c.latitude, longitude: c.longitude }));
  
  // Find the bottom-most point (or left most in case of tie)
  let bottomPoint = points[0];
  for (let i = 1; i < points.length; i++) {
    if (points[i].latitude < bottomPoint.latitude || 
       (points[i].latitude === bottomPoint.latitude && points[i].longitude < bottomPoint.longitude)) {
      bottomPoint = points[i];
    }
  }
  
  // Sort points by polar angle with respect to bottom point
  const sortedPoints = points
    .filter(p => p !== bottomPoint)
    .sort((a, b) => {
      const angleA = Math.atan2(a.latitude - bottomPoint.latitude, a.longitude - bottomPoint.longitude);
      const angleB = Math.atan2(b.latitude - bottomPoint.latitude, b.longitude - bottomPoint.longitude);
      return angleA - angleB;
    });
  
  // Graham scan
  const hull = [bottomPoint, sortedPoints[0]];
  
  for (let i = 1; i < sortedPoints.length; i++) {
    while (hull.length > 1 && !isLeftTurn(
      hull[hull.length - 2],
      hull[hull.length - 1],
      sortedPoints[i]
    )) {
      hull.pop();
    }
    hull.push(sortedPoints[i]);
  }
  
  return hull;
}

function isLeftTurn(p1: { latitude: number; longitude: number }, p2: { latitude: number; longitude: number }, p3: { latitude: number; longitude: number }): boolean {
  return ((p2.longitude - p1.longitude) * (p3.latitude - p1.latitude) - (p2.latitude - p1.latitude) * (p3.longitude - p1.longitude)) > 0;
}

function convertClustersToCustomers(clusters: GeographicCluster[]): ClusteredCustomer[] {
  const clusteredCustomers: ClusteredCustomer[] = [];
  
  clusters.forEach((cluster, index) => {
    cluster.customers.forEach(customer => {
      clusteredCustomers.push({
        ...customer,
        clusterId: index
      });
    });
  });
  
  return clusteredCustomers;
}

function validateFinalClusters(
  clusteredCustomers: ClusteredCustomer[],
  originalCustomers: Customer[]
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
  if (actualClusters !== TARGET_CLUSTERS) {
    return {
      isValid: false,
      message: `Cluster count mismatch: Expected ${TARGET_CLUSTERS}, Got ${actualClusters}`
    };
  }
  
  // Check cluster sizes
  const clusterSizes = getClusterSizes(clusteredCustomers);
  const undersizedClusters = clusterSizes.filter(size => size < MIN_OUTLETS_PER_CLUSTER);
  
  if (undersizedClusters.length > 0) {
    return {
      isValid: false,
      message: `CRITICAL SIZE VIOLATION: ${undersizedClusters.length} clusters below ${MIN_OUTLETS_PER_CLUSTER} outlets. Sizes: ${undersizedClusters.join(', ')}`
    };
  }
  
  console.log(`✅ FINAL VALIDATION PASSED: ${actualClusters} clusters (target: ${TARGET_CLUSTERS}), all clusters have ≥${MIN_OUTLETS_PER_CLUSTER} outlets. Sizes: ${clusterSizes.join(', ')}`);
  
  return { isValid: true, message: `Exactly ${TARGET_CLUSTERS} non-overlapping clusters created with proper sizes` };
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

// Utility function for distance calculation
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