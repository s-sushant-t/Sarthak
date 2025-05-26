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
const OUTLIER_THRESHOLD = 0.5; // 50% above median distance is considered an outlier

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

    // Calculate median distance between outlets
    const distances: number[] = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const distance = calculateHaversineDistance(
          points[i].y, points[i].x,
          points[j].y, points[j].x
        );
        distances.push(distance);
      }
    }
    distances.sort((a, b) => a - b);
    const medianDistance = distances[Math.floor(distances.length / 2)];
    const outlierThreshold = medianDistance * (1 + OUTLIER_THRESHOLD);

    // Sort points by distance from centroid
    points.sort((a, b) => a.distance - b.distance);

    // Initialize clusters
    const clusters: Point[][] = [];
    let currentCluster: Point[] = [];
    let currentCentroid = centroid;

    // First pass: identify outliers and create initial clusters
    const outliers: Point[] = [];
    const nonOutliers: Point[] = [];

    for (const point of points) {
      // Check if point is an outlier based on average distance to nearest neighbors
      let avgDistance = 0;
      const kNearest = 5; // Check 5 nearest neighbors
      const distances = points
        .filter(p => p !== point)
        .map(p => calculateHaversineDistance(point.y, point.x, p.y, p.x))
        .sort((a, b) => a - b)
        .slice(0, kNearest);
      
      avgDistance = distances.reduce((sum, d) => sum + d, 0) / distances.length;

      if (avgDistance > outlierThreshold) {
        outliers.push(point);
      } else {
        nonOutliers.push(point);
      }

      // Allow UI to update
      if ((outliers.length + nonOutliers.length) % 100 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Process non-outliers into clusters
    for (const point of nonOutliers) {
      const distanceToCentroid = calculateHaversineDistance(
        currentCentroid.latitude,
        currentCentroid.longitude,
        point.y,
        point.x
      );

      if (currentCluster.length >= TARGET_CLUSTER_SIZE || 
          (currentCluster.length > 0 && distanceToCentroid > MAX_CLUSTER_RADIUS)) {
        if (currentCluster.length > 0) {
          clusters.push(currentCluster);
          currentCluster = [];
          currentCentroid = findCentroid(points.slice(clusters.length * TARGET_CLUSTER_SIZE));
        }
      }

      currentCluster.push(point);
    }

    // Add the last cluster if it has points
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    // Convert clusters and outliers to ClusteredCustomer format
    const clusteredCustomers: ClusteredCustomer[] = [];
    
    // Add clustered customers
    clusters.forEach((cluster, clusterId) => {
      cluster.forEach(point => {
        clusteredCustomers.push({
          ...point.customer,
          clusterId,
          isOutlier: false
        });
      });
    });

    // Add outliers with special cluster ID
    outliers.forEach((point, index) => {
      clusteredCustomers.push({
        ...point.customer,
        clusterId: clusters.length + Math.floor(index / TARGET_CLUSTER_SIZE),
        isOutlier: true
      });
    });

    return clusteredCustomers;

  } catch (error) {
    console.error('Clustering error:', error);
    // Fallback: assign all customers to a single cluster
    return customers.map(customer => ({
      ...customer,
      clusterId: 0,
      isOutlier: false
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