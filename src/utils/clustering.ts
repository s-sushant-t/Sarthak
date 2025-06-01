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

    const TARGET_MIN_SIZE = 180;
    const TARGET_MAX_SIZE = 210;
    let maxDistance = 5; // Start with 5km radius
    let clusteredCustomers: ClusteredCustomer[] = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 10;

    while (attempts < MAX_ATTEMPTS) {
      // Convert customers to GeoJSON points for DBSCAN
      const points = customers.map(customer => 
        point([customer.longitude, customer.latitude], { 
          customerId: customer.id 
        })
      );
      
      const pointCollection = featureCollection(points);

      // DBSCAN parameters
      const options = {
        minPoints: Math.floor(TARGET_MIN_SIZE * 0.1), // 10% of target minimum size
        maxDistance: maxDistance,
        units: 'kilometers'
      };

      // Perform DBSCAN clustering
      const clustered = clustersDbscan(pointCollection, options.maxDistance, {
        minPoints: options.minPoints,
        units: options.units
      });

      // Process clustering results
      const clusterSizes = new Map<number, number>();
      const clusterMap = new Map<number, number>();
      let nextClusterId = 0;

      // Count points in each DBSCAN cluster
      clustered.features.forEach(feature => {
        const dbscanCluster = feature.properties?.cluster;
        if (dbscanCluster !== undefined) {
          clusterSizes.set(
            dbscanCluster,
            (clusterSizes.get(dbscanCluster) || 0) + 1
          );
        }
      });

      // Check if clusters are within desired size range
      let validClusters = true;
      clusterSizes.forEach((size, _) => {
        if (size < TARGET_MIN_SIZE || size > TARGET_MAX_SIZE) {
          validClusters = false;
        }
      });

      if (validClusters && clusterSizes.size > 0) {
        // Map DBSCAN cluster numbers to sequential cluster IDs
        clustered.features.forEach(feature => {
          const dbscanCluster = feature.properties?.cluster;
          if (dbscanCluster !== undefined && !clusterMap.has(dbscanCluster)) {
            clusterMap.set(dbscanCluster, nextClusterId++);
          }
        });

        // Convert to ClusteredCustomer format
        clusteredCustomers = clustered.features.map((feature, index) => {
          const dbscanCluster = feature.properties?.cluster;
          const clusterId = dbscanCluster !== undefined 
            ? clusterMap.get(dbscanCluster) || 0
            : nextClusterId++; // Noise points get their own clusters

          return {
            id: customers[index].id,
            latitude: feature.geometry.coordinates[1],
            longitude: feature.geometry.coordinates[0],
            clusterId
          };
        });

        // Handle remaining unassigned customers
        const unassignedCustomers = clusteredCustomers.filter(
          customer => !clusterMap.has(customer.clusterId)
        );

        if (unassignedCustomers.length > 0) {
          // Assign each unassigned customer to the nearest cluster
          unassignedCustomers.forEach(customer => {
            let nearestCluster = 0;
            let minDistance = Infinity;

            clusteredCustomers
              .filter(c => clusterMap.has(c.clusterId))
              .forEach(other => {
                const distance = calculateDistance(
                  customer.latitude,
                  customer.longitude,
                  other.latitude,
                  other.longitude
                );
                
                if (distance < minDistance) {
                  minDistance = distance;
                  nearestCluster = other.clusterId;
                }
              });

            customer.clusterId = nearestCluster;
          });
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

      // Adjust maxDistance based on cluster sizes
      const avgClusterSize = Array.from(clusterSizes.values())
        .reduce((sum, size) => sum + size, 0) / Math.max(clusterSizes.size, 1);

      if (avgClusterSize < TARGET_MIN_SIZE) {
        maxDistance *= 1.5; // Increase radius if clusters are too small
      } else {
        maxDistance *= 0.75; // Decrease radius if clusters are too large
      }

      attempts++;
    }

    // If we couldn't create valid clusters, create them manually
    if (clusteredCustomers.length === 0) {
      const numClusters = Math.ceil(customers.length / TARGET_MAX_SIZE);
      const customersPerCluster = Math.ceil(customers.length / numClusters);

      // Sort customers by latitude to create geographical clusters
      const sortedCustomers = [...customers].sort((a, b) => a.latitude - b.latitude);

      clusteredCustomers = sortedCustomers.map((customer, index) => ({
        ...customer,
        clusterId: Math.floor(index / customersPerCluster)
      }));
    }

    return clusteredCustomers;

  } catch (error) {
    console.error('Clustering error:', error);
    // Fallback: create evenly sized clusters
    const numClusters = Math.ceil(customers.length / TARGET_MAX_SIZE);
    const customersPerCluster = Math.ceil(customers.length / numClusters);

    return customers.map((customer, index) => ({
      ...customer,
      clusterId: Math.floor(index / customersPerCluster)
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