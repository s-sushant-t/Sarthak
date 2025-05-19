import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

export const clusterCustomers = (
  customers: Customer[]
): ClusteredCustomer[] => {
  const MIN_CLUSTER_SIZE = 180;
  const MAX_CLUSTER_SIZE = 210;
  const TARGET_SIZE = 195;
  
  let optimalDistance = 2; // Start with 2km
  let bestClustering: ClusteredCustomer[] = [];
  let bestScore = Infinity;
  
  // Binary search for optimal distance
  let minDistance = 0.5;
  let maxDistance = 10;
  let attempts = 0;
  const maxAttempts = 15;
  
  while (attempts < maxAttempts) {
    const points = customers.map(customer => 
      point([customer.longitude, customer.latitude], { 
        customerId: customer.id 
      })
    );
    
    const pointCollection = featureCollection(points);
    const clustered = clustersDbscan(pointCollection, optimalDistance, {
      minPoints: MIN_CLUSTER_SIZE,
      units: 'kilometers'
    });
    
    // Convert to ClusteredCustomer format
    const tempClustered = customers.map((customer, index) => {
      const cluster = clustered.features[index].properties.cluster;
      return {
        ...customer,
        clusterId: cluster !== null ? cluster : -1
      };
    });
    
    // Count customers per cluster
    const clusterSizes = tempClustered.reduce((acc, customer) => {
      if (customer.clusterId === -1) return acc;
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
    
    attempts++;
  }
  
  // If no valid clustering found, create balanced clusters manually
  if (bestClustering.length === 0 || bestScore === Infinity) {
    console.warn('Could not achieve ideal cluster sizes, using manual balancing');
    return customers.map((customer, index) => ({
      ...customer,
      clusterId: Math.floor(index / TARGET_SIZE)
    }));
  }
  
  return bestClustering;
};