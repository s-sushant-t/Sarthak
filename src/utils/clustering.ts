import clustersDbscan from '@turf/clusters-dbscan';
import { point, featureCollection } from '@turf/helpers';
import { Customer, ClusteredCustomer } from '../types';

export const clusterCustomers = (
  customers: Customer[],
  distanceThreshold: number = 2, // 2km radius
  minPoints: number = 3 // minimum points to form a cluster
): ClusteredCustomer[] => {
  // Convert customers to GeoJSON points
  const points = customers.map(customer => 
    point([customer.longitude, customer.latitude], { 
      customerId: customer.id 
    })
  );
  
  const pointCollection = featureCollection(points);
  
  // Perform DBSCAN clustering
  const clustered = clustersDbscan(pointCollection, distanceThreshold, {
    minPoints,
    units: 'kilometers'
  });
  
  // Process clustering results
  return customers.map((customer, index) => {
    const cluster = clustered.features[index].properties.cluster;
    return {
      ...customer,
      clusterId: cluster !== null ? cluster : -1 // -1 for noise points
    };
  });
};