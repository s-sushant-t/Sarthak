import { Customer, ClusteredCustomer } from '../types';
import { calculateHaversineDistance } from './distanceCalculator';

interface Point {
  x: number;
  y: number;
  customer: Customer;
  distance: number;
}

const MAX_CLUSTER_RADIUS = 5; // Maximum radius in kilometers for a cluster
const TARGET_CLUSTER_SIZE = 200; // Target number of customers per cluster

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    // Find the centroid of all customers to use as a reference point
    const centroid = findCentroid(customers);

    // Calculate distances and angles from centroid for all customers
    const points: Point[] = customers.map(customer => {
      const distance = calculateHaversineDistance(
        centroid.latitude,
        centroid.longitude,
        customer.latitude,
        customer.longitude
      );
      
      return {
        x: customer.longitude,
        y: customer.latitude,
        customer,
        distance
      };
    });

    // Sort points by distance from centroid
    points.sort((a, b) => a.distance - b.distance);

    // Initialize clusters
    const clusters: Point[][] = [];
    let currentCluster: Point[] = [];
    let currentCentroid = centroid;

    for (const point of points) {
      // Check if point is within acceptable distance of current cluster centroid
      const distanceToCentroid = calculateHaversineDistance(
        currentCentroid.latitude,
        currentCentroid.longitude,
        point.y,
        point.x
      );

      // Start a new cluster if:
      // 1. Current cluster is full (reached target size)
      // 2. Point is too far from current cluster centroid
      if (currentCluster.length >= TARGET_CLUSTER_SIZE || 
          (currentCluster.length > 0 && distanceToCentroid > MAX_CLUSTER_RADIUS)) {
        if (currentCluster.length > 0) {
          clusters.push(currentCluster);
          currentCluster = [];
          // Update centroid for new cluster
          currentCentroid = findCentroid(points.slice(clusters.length * TARGET_CLUSTER_SIZE));
        }
      }

      currentCluster.push(point);

      // Allow UI to update between processing chunks
      if (clusters.length % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Add the last cluster if it has points
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    // Convert clusters back to ClusteredCustomer format
    const clusteredCustomers: ClusteredCustomer[] = [];
    clusters.forEach((cluster, clusterId) => {
      cluster.forEach(point => {
        clusteredCustomers.push({
          ...point.customer,
          clusterId
        });
      });
    });

    // Ensure all customers are assigned to a cluster
    return clusteredCustomers.length === customers.length
      ? clusteredCustomers
      : customers.map((customer, index) => ({
          ...customer,
          clusterId: Math.floor(index / TARGET_CLUSTER_SIZE)
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

function findCentroid(customers: Customer[]): { latitude: number; longitude: number } {
  const sum = customers.reduce(
    (acc, customer) => ({
      latitude: acc.latitude + customer.latitude,
      longitude: acc.longitude + customer.longitude
    }),
    { latitude: 0, longitude: 0 }
  );

  return {
    latitude: sum.latitude / customers.length,
    longitude: sum.longitude / customers.length
  };
}