import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

export const clusterCustomers = (
  customers: Customer[]
): ClusteredCustomer[] => {
  // If no customers, return empty array
  if (!customers || customers.length === 0) {
    return [];
  }

  const MIN_CLUSTER_SIZE = 180;
  const MAX_CLUSTER_SIZE = 210;
  const TARGET_SIZE = 195;
  
  let optimalDistance = 2; // Start with 2km
  let bestClustering: ClusteredCustomer[] = customers.map((customer, index) => ({
    ...customer,
    clusterId: 0 // Initialize all customers to cluster 0 as fallback
  }));
  let bestScore = Infinity;
  
  // Binary search for optimal distance
  let minDistance = 0.5;
  let maxDistance = 10;
  let attempts = 0;
  const maxAttempts = 15;
  
  while (attempts < maxAttempts) {
    try {
      const points = customers.map(customer => 
        point([customer.longitude, customer.latitude], { 
          customerId: customer.id 
        })
      );
      
      const pointCollection = featureCollection(points);
      const clustered = clustersDbscan(pointCollection, optimalDistance, {
        minPoints: 2, // Reduced minimum points to ensure clusters form
        units: 'kilometers'
      });
      
      // Convert to ClusteredCustomer format
      const tempClustered = customers.map((customer, index) => {
        const cluster = clustered.features[index].properties.cluster;
        return {
          ...customer,
          // Ensure cluster ID is always a number, default to 0 if null
          clusterId: cluster !== null ? Number(cluster) : 0
        };
      });
      
      // Count customers per cluster
      const clusterSizes = tempClustered.reduce((acc, customer) => {
        acc[customer.clusterId] = (acc[customer.clusterId] || 0) + 1;
        return acc;
      }, {} as Record<number, number>);
      
      // Calculate score based on how well clusters meet size constraints
      const score = Object.values(clusterSizes).reduce((total, size) => {
        if (size < MIN_CLUSTER_SIZE) {
          return total + Math.pow(MIN_CLUSTER_SIZE - size, 2);
        }
        if (size > MAX_CLUSTER_SIZE) {
          return total + Math.pow(size - MAX_CLUSTER_SIZE, 2);
        }
        return total + Math.abs(size - TARGET_SIZE);
      }, 0);
      
      // Update best clustering if current score is better
      if (score < bestScore) {
        bestScore = score;
        bestClustering = tempClustered;
      }
      
      // Adjust distance based on average cluster size
      const avgClusterSize = Object.values(clusterSizes).reduce((a, b) => a + b, 0) / Object.keys(clusterSizes).length;
      
      if (avgClusterSize < TARGET_SIZE) {
        minDistance = optimalDistance;
        optimalDistance = (optimalDistance + maxDistance) / 2;
      } else {
        maxDistance = optimalDistance;
        optimalDistance = (minDistance + optimalDistance) / 2;
      }
    } catch (error) {
      console.warn('Error during clustering attempt:', error);
      // Continue to next attempt if there's an error
    }
    
    attempts++;
  }
  
  // If clustering produced no valid results, create balanced clusters manually
  if (bestClustering.length === 0 || bestScore === Infinity) {
    console.warn('Using manual balanced clustering');
    return customers.map((customer, index) => ({
      ...customer,
      clusterId: Math.floor(index / TARGET_SIZE)
    }));
  }
  
  // Ensure all customers have valid cluster IDs
  return bestClustering.map((customer, index) => ({
    ...customer,
    clusterId: typeof customer.clusterId === 'number' ? customer.clusterId : Math.floor(index / TARGET_SIZE)
  }));
};