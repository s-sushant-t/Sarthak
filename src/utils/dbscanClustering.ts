import { ClusteredCustomer } from '../types';
import { calculateHaversineDistance } from './distanceCalculator';

export interface DBSCANCluster {
  id: number;
  customers: ClusteredCustomer[];
  centroid: { latitude: number; longitude: number };
}

export interface DBSCANConfig {
  eps: number; // Maximum distance between points in km
  minSamples: number; // Minimum number of points to form a cluster
}

export const performDBSCANClustering = (
  customers: ClusteredCustomer[],
  config: DBSCANConfig = { eps: 0.3, minSamples: 4 }
): DBSCANCluster[] => {
  console.log(`Starting DBSCAN clustering with eps=${config.eps}km, minSamples=${config.minSamples}`);
  
  const points = customers.map((customer, index) => ({
    ...customer,
    index,
    clusterId: -1, // -1 means unassigned
    isCore: false,
    visited: false
  }));
  
  let currentClusterId = 0;
  
  // Find neighbors within eps distance
  const getNeighbors = (pointIndex: number): number[] => {
    const neighbors: number[] = [];
    const point = points[pointIndex];
    
    for (let i = 0; i < points.length; i++) {
      if (i === pointIndex) continue;
      
      const distance = calculateHaversineDistance(
        point.latitude, point.longitude,
        points[i].latitude, points[i].longitude
      );
      
      if (distance <= config.eps) {
        neighbors.push(i);
      }
    }
    
    return neighbors;
  };
  
  // DBSCAN algorithm
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    
    if (point.visited) continue;
    point.visited = true;
    
    const neighbors = getNeighbors(i);
    
    if (neighbors.length < config.minSamples) {
      // Mark as noise (will be handled later)
      continue;
    }
    
    // Start new cluster
    point.clusterId = currentClusterId;
    point.isCore = true;
    
    // Expand cluster
    const seedSet = [...neighbors];
    let j = 0;
    
    while (j < seedSet.length) {
      const neighborIndex = seedSet[j];
      const neighbor = points[neighborIndex];
      
      if (!neighbor.visited) {
        neighbor.visited = true;
        const neighborNeighbors = getNeighbors(neighborIndex);
        
        if (neighborNeighbors.length >= config.minSamples) {
          neighbor.isCore = true;
          // Add new neighbors to seed set
          for (const nn of neighborNeighbors) {
            if (!seedSet.includes(nn)) {
              seedSet.push(nn);
            }
          }
        }
      }
      
      if (neighbor.clusterId === -1) {
        neighbor.clusterId = currentClusterId;
      }
      
      j++;
    }
    
    currentClusterId++;
  }
  
  // Handle noise points by assigning them to nearest cluster
  const noisyPoints = points.filter(p => p.clusterId === -1);
  console.log(`Found ${noisyPoints.length} noise points to reassign`);
  
  for (const noisyPoint of noisyPoints) {
    let nearestCluster = 0;
    let minDistance = Infinity;
    
    for (let clusterId = 0; clusterId < currentClusterId; clusterId++) {
      const clusterPoints = points.filter(p => p.clusterId === clusterId);
      if (clusterPoints.length === 0) continue;
      
      // Find distance to cluster centroid
      const centroid = calculateCentroid(clusterPoints);
      const distance = calculateHaversineDistance(
        noisyPoint.latitude, noisyPoint.longitude,
        centroid.latitude, centroid.longitude
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestCluster = clusterId;
      }
    }
    
    noisyPoint.clusterId = nearestCluster;
  }
  
  // Group points by cluster and create result
  const clusters: DBSCANCluster[] = [];
  
  for (let clusterId = 0; clusterId < currentClusterId; clusterId++) {
    const clusterPoints = points.filter(p => p.clusterId === clusterId);
    
    if (clusterPoints.length > 0) {
      const centroid = calculateCentroid(clusterPoints);
      
      clusters.push({
        id: clusterId,
        customers: clusterPoints.map(p => ({
          id: p.id,
          latitude: p.latitude,
          longitude: p.longitude,
          outletName: p.outletName,
          clusterId: p.clusterId // This will be the DBSCAN cluster ID
        })),
        centroid
      });
    }
  }
  
  console.log(`DBSCAN created ${clusters.length} natural clusters`);
  clusters.forEach((cluster, index) => {
    console.log(`DBSCAN Cluster ${index}: ${cluster.customers.length} customers`);
  });
  
  return clusters;
};

function calculateCentroid(points: any[]): { latitude: number; longitude: number } {
  const avgLat = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
  const avgLng = points.reduce((sum, p) => sum + p.longitude, 0) / points.length;
  
  return { latitude: avgLat, longitude: avgLng };
}