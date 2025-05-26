import { Customer, ClusteredCustomer } from '../types';
import { calculateHaversineDistance } from './distanceCalculator';

interface Point {
  x: number;
  y: number;
  customer: Customer;
}

const TARGET_CLUSTER_SIZE = 200; // Target number of customers per cluster

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    // Find the centroid of all customers
    const centroid = findCentroid(customers);

    // Convert customers to points with relative coordinates
    const points: Point[] = customers.map(customer => ({
      x: customer.longitude,
      y: customer.latitude,
      customer
    }));

    // Divide space into quadrants based on centroid
    const quadrants: Point[][] = [[], [], [], []]; // NE, SE, SW, NW

    // Assign points to quadrants
    points.forEach(point => {
      const relativeX = point.x - centroid.longitude;
      const relativeY = point.y - centroid.latitude;

      if (relativeY >= 0) {
        if (relativeX >= 0) quadrants[0].push(point); // NE
        else quadrants[3].push(point); // NW
      } else {
        if (relativeX >= 0) quadrants[1].push(point); // SE
        else quadrants[2].push(point); // SW
      }
    });

    // Further divide each quadrant if needed
    const clusters: Point[][] = [];
    let clusterId = 0;

    for (const quadrant of quadrants) {
      if (quadrant.length === 0) continue;

      // If quadrant is small enough, keep it as one cluster
      if (quadrant.length <= TARGET_CLUSTER_SIZE) {
        clusters.push(quadrant);
        continue;
      }

      // Find quadrant centroid
      const quadrantCentroid = findCentroid(quadrant.map(p => p.customer));

      // Sort points by distance from quadrant centroid
      const sortedPoints = quadrant.sort((a, b) => {
        const distA = calculateHaversineDistance(
          quadrantCentroid.latitude,
          quadrantCentroid.longitude,
          a.y,
          a.x
        );
        const distB = calculateHaversineDistance(
          quadrantCentroid.latitude,
          quadrantCentroid.longitude,
          b.y,
          b.x
        );
        return distA - distB;
      });

      // Create subclusters within quadrant
      const numSubclusters = Math.ceil(quadrant.length / TARGET_CLUSTER_SIZE);
      const pointsPerSubcluster = Math.ceil(quadrant.length / numSubclusters);

      for (let i = 0; i < sortedPoints.length; i += pointsPerSubcluster) {
        const subcluster = sortedPoints.slice(i, i + pointsPerSubcluster);
        if (subcluster.length > 0) {
          clusters.push(subcluster);
        }
      }

      // Allow UI to update between processing quadrants
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // Convert clusters back to ClusteredCustomer format
    const clusteredCustomers: ClusteredCustomer[] = [];
    clusters.forEach((cluster, index) => {
      cluster.forEach(point => {
        clusteredCustomers.push({
          ...point.customer,
          clusterId: index
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