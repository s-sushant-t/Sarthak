import { Customer, ClusteredCustomer } from '../types';
import { calculateHaversineDistance } from './distanceCalculator';

interface Point {
  x: number;
  y: number;
  customer: Customer;
}

export const clusterCustomers = async (
  customers: Customer[]
): Promise<ClusteredCustomer[]> => {
  try {
    if (!customers || customers.length === 0) {
      return [];
    }

    // Convert lat/lng to x/y coordinates using Mercator projection
    const points: Point[] = customers.map(customer => ({
      x: longitudeToX(customer.longitude),
      y: latitudeToY(customer.latitude),
      customer
    }));

    // Find the centroid of all points
    const centroid = findCentroid(points);

    // Sort points by angle and distance from centroid
    const sortedPoints = points.sort((a, b) => {
      const angleA = Math.atan2(a.y - centroid.y, a.x - centroid.x);
      const angleB = Math.atan2(b.y - centroid.y, b.x - centroid.x);
      if (angleA === angleB) {
        const distA = distance(centroid, a);
        const distB = distance(centroid, b);
        return distA - distB;
      }
      return angleA - angleB;
    });

    // Calculate optimal number of clusters based on dataset size
    const numClusters = Math.ceil(customers.length / 200);
    const sectorsPerCluster = Math.ceil(sortedPoints.length / numClusters);

    // Create non-overlapping sectors
    const clusters: Point[][] = [];
    for (let i = 0; i < sortedPoints.length; i += sectorsPerCluster) {
      const cluster = sortedPoints.slice(i, i + sectorsPerCluster);
      if (cluster.length > 0) {
        clusters.push(cluster);
      }

      // Allow UI to update between processing chunks
      if (i % 500 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Convert back to clustered customers
    const clusteredCustomers: ClusteredCustomer[] = [];
    clusters.forEach((cluster, clusterId) => {
      cluster.forEach(point => {
        clusteredCustomers.push({
          ...point.customer,
          clusterId
        });
      });
    });

    // Ensure no customer is left without a cluster
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

// Helper functions for coordinate conversion and geometric calculations
function longitudeToX(longitude: number): number {
  return longitude * Math.PI / 180;
}

function latitudeToY(latitude: number): number {
  const lat = latitude * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2));
}

function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function findCentroid(points: Point[]): Point {
  const sum = points.reduce((acc, point) => ({
    x: acc.x + point.x,
    y: acc.y + point.y,
    customer: point.customer
  }), { x: 0, y: 0, customer: points[0].customer });

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
    customer: sum.customer
  };
}