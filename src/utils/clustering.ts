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

    // Convert customers to GeoJSON points for DBSCAN
    const points = customers.map(customer => 
      point([customer.longitude, customer.latitude], { 
        customerId: customer.id 
      })
    );
    
    const pointCollection = featureCollection(points);

    // DBSCAN parameters
    const options = {
      minPoints: 5, // Minimum points to form a cluster
      maxDistance: 2, // Maximum distance (in km) between points in the same cluster
      units: 'kilometers'
    };

    // Perform DBSCAN clustering
    const clustered = clustersDbscan(pointCollection, options.maxDistance, {
      minPoints: options.minPoints,
      units: options.units
    });

    // Process clustering results
    const clusterMap = new Map<number, number>();
    let nextClusterId = 0;

    // Map DBSCAN cluster numbers to sequential cluster IDs
    clustered.features.forEach(feature => {
      const dbscanCluster = feature.properties?.cluster;
      
      if (dbscanCluster !== undefined && !clusterMap.has(dbscanCluster)) {
        clusterMap.set(dbscanCluster, nextClusterId++);
      }
    });

    // Convert back to ClusteredCustomer format
    const clusteredCustomers: ClusteredCustomer[] = clustered.features.map((feature, index) => {
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

    // Optimize small clusters
    const MIN_CLUSTER_SIZE = 10;
    const clusterSizes = new Map<number, number>();
    
    // Count customers in each cluster
    clusteredCustomers.forEach(customer => {
      clusterSizes.set(
        customer.clusterId,
        (clusterSizes.get(customer.clusterId) || 0) + 1
      );
    });

    // Merge small clusters with nearest larger cluster
    for (const customer of clusteredCustomers) {
      const size = clusterSizes.get(customer.clusterId) || 0;
      
      if (size < MIN_CLUSTER_SIZE) {
        let nearestCluster = customer.clusterId;
        let minDistance = Infinity;

        // Find nearest larger cluster
        clusteredCustomers.forEach(other => {
          if (other.clusterId !== customer.clusterId && 
              (clusterSizes.get(other.clusterId) || 0) >= MIN_CLUSTER_SIZE) {
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
          }
        });

        if (nearestCluster !== customer.clusterId) {
          customer.clusterId = nearestCluster;
          clusterSizes.set(
            nearestCluster,
            (clusterSizes.get(nearestCluster) || 0) + 1
          );
        }
      }
    }

    // Ensure we have valid clusters
    return clusteredCustomers.length > 0 
      ? clusteredCustomers 
      : customers.map(customer => ({
          ...customer,
          clusterId: 0
        }));

  } catch (error) {
    console.error('Clustering error:', error);
    // Fallback: assign all customers to a single cluster
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