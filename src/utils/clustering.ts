import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

// Cache for clustering results
const clusterCache = new Map<string, ClusteredCustomer[]>();

// Worker pool for parallel processing
const workerPool = {
  maxWorkers: 4,
  activeWorkers: 0,
  queue: [] as (() => void)[],
  
  async execute<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeWorkers >= this.maxWorkers) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    
    this.activeWorkers++;
    try {
      return await task();
    } finally {
      this.activeWorkers--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
};

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }
    
    const cacheKey = JSON.stringify(customers);
    const cached = clusterCache.get(cacheKey);
    if (cached) return cached;
    
    const TARGET_MIN_SIZE = 180;
    const TARGET_MAX_SIZE = 210;
    let maxDistance = 5;
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    
    // Process customers in parallel batches
    const batchSize = 100;
    const batches = [];
    
    for (let i = 0; i < customers.length; i += batchSize) {
      batches.push(customers.slice(i, i + batchSize));
    }
    
    const processBatch = async (batch: Customer[]) => {
      return await workerPool.execute(async () => {
        const points = batch.map(customer => 
          point([customer.longitude, customer.latitude], { 
            customerId: customer.id 
          })
        );
        
        return points;
      });
    };
    
    const processedBatches = await Promise.all(
      batches.map(batch => processBatch(batch))
    );
    
    const points = processedBatches.flat();
    const pointCollection = featureCollection(points);
    
    while (attempts < MAX_ATTEMPTS) {
      const options = {
        minPoints: Math.floor(TARGET_MIN_SIZE * 0.1),
        maxDistance: maxDistance,
        units: 'kilometers'
      };
      
      const clustered = clustersDbscan(pointCollection, options.maxDistance, {
        minPoints: options.minPoints,
        units: options.units
      });
      
      const clusterSizes = new Map<number, number>();
      clustered.features.forEach(feature => {
        const dbscanCluster = feature.properties?.cluster;
        if (dbscanCluster !== undefined) {
          clusterSizes.set(
            dbscanCluster,
            (clusterSizes.get(dbscanCluster) || 0) + 1
          );
        }
      });
      
      let validClusters = true;
      clusterSizes.forEach((size, _) => {
        if (size < TARGET_MIN_SIZE || size > TARGET_MAX_SIZE) {
          validClusters = false;
        }
      });
      
      if (validClusters && clusterSizes.size > 0) {
        const result = clustered.features.map((feature, index) => ({
          id: customers[index].id,
          latitude: feature.geometry.coordinates[1],
          longitude: feature.geometry.coordinates[0],
          clusterId: feature.properties?.cluster || 0
        }));
        
        clusterCache.set(cacheKey, result);
        return result;
      }
      
      maxDistance = maxDistance * (attempts % 2 === 0 ? 1.5 : 0.75);
      attempts++;
      
      // Yield to main thread occasionally
      if (attempts % 2 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    // Fallback clustering
    const result = customers.map((customer, index) => ({
      ...customer,
      clusterId: Math.floor(index / TARGET_MAX_SIZE)
    }));
    
    clusterCache.set(cacheKey, result);
    return result;
    
  } catch (error) {
    console.error('Clustering error:', error);
    return customers.map(customer => ({
      ...customer,
      clusterId: 0
    }));
  }
};

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