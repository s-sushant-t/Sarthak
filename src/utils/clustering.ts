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

    const TARGET_MIN_SIZE = 180; // Minimum cluster size (6 beats × 30 outlets)
    const TARGET_MAX_SIZE = 240; // Maximum cluster size (6 beats × 40 outlets)
    let maxDistance = 5; // Start with 5km radius
    let clusteredCustomers: ClusteredCustomer[] = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 10;

    while (attempts < MAX_ATTEMPTS) {
      const points = customers.map(customer => 
        point([customer.longitude, customer.latitude], { 
          customerId: customer.id 
        })
      );
      
      const pointCollection = featureCollection(points);

      const options = {
        minPoints: 30, // Ensure minimum cluster size matches minimum beat size
        maxDistance: maxDistance,
        units: 'kilometers'
      };

      const clustered = clustersDbscan(pointCollection, options.maxDistance, {
        minPoints: options.minPoints,
        units: options.units
      });

      const clusterSizes = new Map<number, number>();
      const clusterMap = new Map<number, number>();
      let nextClusterId = 0;

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
        clustered.features.forEach(feature => {
          const dbscanCluster = feature.properties?.cluster;
          if (dbscanCluster !== undefined && !clusterMap.has(dbscanCluster)) {
            clusterMap.set(dbscanCluster, nextClusterId++);
          }
        });

        clusteredCustomers = clustered.features.map((feature, index) => {
          const dbscanCluster = feature.properties?.cluster;
          const clusterId = dbscanCluster !== undefined 
            ? clusterMap.get(dbscanCluster) || 0
            : nextClusterId++;

          return {
            id: customers[index].id,
            latitude: feature.geometry.coordinates[1],
            longitude: feature.geometry.coordinates[0],
            clusterId
          };
        });

        const unassignedCustomers = clusteredCustomers.filter(
          customer => !clusterMap.has(customer.clusterId)
        );

        if (unassignedCustomers.length > 0) {
          for (const customer of unassignedCustomers) {
            let bestCluster = 0;
            let minDistance = Infinity;
            let bestClusterSize = Infinity;

            // Find clusters that aren't at maximum capacity
            for (const [clusterId, size] of clusterSizes.entries()) {
              if (size >= TARGET_MAX_SIZE) continue;

              const clusterCustomers = clusteredCustomers.filter(c => c.clusterId === clusterId);
              for (const clusterCustomer of clusterCustomers) {
                const distance = calculateDistance(
                  customer.latitude,
                  customer.longitude,
                  clusterCustomer.latitude,
                  clusterCustomer.longitude
                );

                // Prefer smaller clusters when distances are similar
                if (distance < minDistance || 
                   (Math.abs(distance - minDistance) < 0.1 && size < bestClusterSize)) {
                  minDistance = distance;
                  bestCluster = clusterId;
                  bestClusterSize = size;
                }
              }
            }

            customer.clusterId = bestCluster;
            clusterSizes.set(bestCluster, (clusterSizes.get(bestCluster) || 0) + 1);
          }
        }

        // Verify final cluster sizes
        const finalClusterSizes = new Map<number, number>();
        clusteredCustomers.forEach(customer => {
          finalClusterSizes.set(
            customer.clusterId,
            (finalClusterSizes.get(customer.clusterId) || 0) + 1
          );
        });

        let allClustersValid = true;
        finalClusterSizes.forEach((size, _) => {
          if (size < TARGET_MIN_SIZE || size > TARGET_MAX_SIZE) {
            allClustersValid = false;
          }
        });

        if (allClustersValid) {
          break;
        }
      }

      const avgClusterSize = Array.from(clusterSizes.values())
        .reduce((sum, size) => sum + size, 0) / Math.max(clusterSizes.size, 1);

      if (avgClusterSize < TARGET_MIN_SIZE) {
        maxDistance *= 1.5;
      } else {
        maxDistance *= 0.75;
      }

      attempts++;
    }

    if (clusteredCustomers.length === 0) {
      const numClusters = Math.ceil(customers.length / TARGET_MAX_SIZE);
      const customersPerCluster = Math.max(30, Math.ceil(customers.length / numClusters));

      const sortedCustomers = [...customers].sort((a, b) => a.latitude - b.latitude);

      clusteredCustomers = sortedCustomers.map((customer, index) => ({
        ...customer,
        clusterId: Math.floor(index / customersPerCluster)
      }));
    }

    return clusteredCustomers;

  } catch (error) {
    console.error('Clustering error:', error);
    const numClusters = Math.ceil(customers.length / TARGET_MAX_SIZE);
    const customersPerCluster = Math.max(30, Math.ceil(customers.length / numClusters));

    return customers.map((customer, index) => ({
      ...customer,
      clusterId: Math.floor(index / customersPerCluster)
    }));
  }
};

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