import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';
import { calculateHaversineDistance } from './distanceCalculator';

export const clusterCustomers = (
  customers: Customer[]
): ClusteredCustomer[] => {
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
      customers[0].latitude, // Using first customer's coordinates as distributor
      customers[0].longitude
    )
  }));

  // Sort customers by distance from distributor
  distributorDistances.sort((a, b) => a.distanceFromDistributor - b.distanceFromDistributor);

  // Create clusters based on distance bands
  const clusters: ClusteredCustomer[][] = [];
  let currentCluster: ClusteredCustomer[] = [];
  let currentDistanceBand = 0;
  const DISTANCE_BAND_SIZE = 5; // 5km bands

  distributorDistances.forEach(({ customer, distanceFromDistributor }) => {
    const distanceBand = Math.floor(distanceFromDistributor / DISTANCE_BAND_SIZE);
    
    if (distanceBand > currentDistanceBand && currentCluster.length >= MIN_CLUSTER_SIZE) {
      clusters.push(currentCluster);
      currentCluster = [];
      currentDistanceBand = distanceBand;
    }
    
    currentCluster.push({
      ...customer,
      clusterId: clusters.length
    });
    
    // If current cluster reaches minimum size and there are more customers,
    // start a new cluster
    if (currentCluster.length >= MIN_CLUSTER_SIZE && 
        distributorDistances.length - (clusters.length * MIN_CLUSTER_SIZE) > MIN_CLUSTER_SIZE) {
      clusters.push(currentCluster);
      currentCluster = [];
    }
  });

  // Add any remaining customers to the last cluster
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

  // Ensure all customers are assigned to a cluster
  return clusteredCustomers.length === customers.length
    ? clusteredCustomers
    : customers.map((customer, index) => ({
        ...customer,
        clusterId: Math.floor(index / MIN_CLUSTER_SIZE)
      }));
};