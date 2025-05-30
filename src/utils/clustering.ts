import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';
import { calculateHaversineDistance } from './distanceCalculator';

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    const MIN_CLUSTER_SIZE = 210;
    
    // Calculate distances from distributor
    const distributorDistances = customers.map((customer, index) => ({
      customer,
      index,
      distanceFromDistributor: calculateHaversineDistance(
        customer.latitude,
        customer.longitude,
        customers[0].latitude,
        customers[0].longitude
      )
    }));

    // Sort customers by distance from distributor
    distributorDistances.sort((a, b) => a.distanceFromDistributor - b.distanceFromDistributor);

    // Create clusters based on distance bands and proximity
    const clusters: ClusteredCustomer[][] = [];
    let currentCluster: ClusteredCustomer[] = [];
    let currentDistanceBand = 0;
    const DISTANCE_BAND_SIZE = 5; // 5km bands

    // Process customers in chunks to handle large datasets
    const CHUNK_SIZE = 500;
    for (let i = 0; i < distributorDistances.length; i += CHUNK_SIZE) {
      const chunk = distributorDistances.slice(i, i + CHUNK_SIZE);
      
      for (const { customer, distanceFromDistributor } of chunk) {
        const distanceBand = Math.floor(distanceFromDistributor / DISTANCE_BAND_SIZE);
        
        // Check proximity to current cluster
        let shouldStartNewCluster = currentCluster.length >= MIN_CLUSTER_SIZE;
        
        if (currentCluster.length > 0) {
          const avgClusterLat = currentCluster.reduce((sum, c) => sum + c.latitude, 0) / currentCluster.length;
          const avgClusterLng = currentCluster.reduce((sum, c) => sum + c.longitude, 0) / currentCluster.length;
          
          const distanceToCluster = calculateHaversineDistance(
            customer.latitude,
            customer.longitude,
            avgClusterLat,
            avgClusterLng
          );
          
          // Start new cluster if too far from current cluster center
          if (distanceToCluster > DISTANCE_BAND_SIZE * 2) {
            shouldStartNewCluster = true;
          }
        }
        
        if (shouldStartNewCluster && currentCluster.length >= MIN_CLUSTER_SIZE) {
          clusters.push(currentCluster);
          currentCluster = [];
          currentDistanceBand = distanceBand;
        }
        
        currentCluster.push({
          ...customer,
          clusterId: clusters.length
        });
      }
      
      // Allow UI to update between chunks
      if (i + CHUNK_SIZE < distributorDistances.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Add remaining customers to the last cluster
    if (currentCluster.length > 0) {
      if (clusters.length > 0 && currentCluster.length < MIN_CLUSTER_SIZE) {
        // Add remaining customers to the last cluster if it's too small
        clusters[clusters.length - 1].push(...currentCluster);
      } else {
        clusters.push(currentCluster);
      }
    }

    // Flatten clusters back into a single array
    const clusteredCustomers = clusters.flatMap((cluster, clusterId) =>
      cluster.map(customer => ({
        ...customer,
        clusterId
      }))
    );

    // Ensure all customers have a cluster ID
    return clusteredCustomers.length > 0 
      ? clusteredCustomers 
      : customers.map((customer, index) => ({
          ...customer,
          clusterId: 0 // All customers in same cluster if clustering fails
        }));
  } catch (error) {
    console.error('Clustering error:', error);
    // Fallback: assign all customers to a single cluster
    return customers.map(customer => ({
      ...customer,
      clusterId: 0
    }));
  }
}