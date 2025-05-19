import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

export const clusterCustomers = (
  customers: Customer[],
  targetClusterSize: number = 195 // Target size between 180-210
): ClusteredCustomer[] => {
  let optimalDistance = 2; // Start with 2km
  let clusteredCustomers: ClusteredCustomer[] = [];
  let attempts = 0;
  const maxAttempts = 10;
  
  // Binary search for optimal distance
  let minDistance = 0.5;
  let maxDistance = 10;
  
  while (attempts < maxAttempts) {
    const points = customers.map(customer => 
      point([customer.longitude, customer.latitude], { 
        customerId: customer.id 
      })
    );
    
    const pointCollection = featureCollection(points);
    const clustered = clustersDbscan(pointCollection, optimalDistance, {
      minPoints: 3,
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
    
    // Check if clusters are within desired range
    const isValidClustering = Object.values(clusterSizes).every(size => 
      size >= 180 && size <= 210
    );
    
    if (isValidClustering) {
      clusteredCustomers = tempClustered;
      break;
    }
    
    // Adjust distance based on cluster sizes
    const avgClusterSize = Object.values(clusterSizes).reduce((a, b) => a + b, 0) / Object.keys(clusterSizes).length;
    
    if (avgClusterSize < targetClusterSize) {
      minDistance = optimalDistance;
      optimalDistance = (optimalDistance + maxDistance) / 2;
    } else {
      maxDistance = optimalDistance;
      optimalDistance = (minDistance + optimalDistance) / 2;
    }
    
    attempts++;
  }
  
  // If no valid clustering found, use best attempt
  if (clusteredCustomers.length === 0) {
    console.warn('Could not achieve ideal cluster sizes, using best attempt');
    clusteredCustomers = customers.map((customer, index) => ({
      ...customer,
      clusterId: Math.floor(index / targetClusterSize)
    }));
  }
  
  return clusteredCustomers;
};