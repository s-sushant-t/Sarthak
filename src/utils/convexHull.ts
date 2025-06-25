import { RouteStop } from '../types';

export interface Point {
  latitude: number;
  longitude: number;
}

export const calculateConvexHull = (stops: RouteStop[]): Point[] => {
  if (stops.length < 3) return stops.map(s => ({ latitude: s.latitude, longitude: s.longitude }));
  
  const points = stops.map(stop => ({ latitude: stop.latitude, longitude: stop.longitude }));
  
  // Find the bottom-most point (and leftmost in case of tie)
  let bottomPoint = points[0];
  for (let i = 1; i < points.length; i++) {
    if (points[i].latitude < bottomPoint.latitude || 
       (points[i].latitude === bottomPoint.latitude && points[i].longitude < bottomPoint.longitude)) {
      bottomPoint = points[i];
    }
  }
  
  // Sort points by polar angle with respect to bottom point
  const sortedPoints = points
    .filter(p => p !== bottomPoint)
    .sort((a, b) => {
      const angleA = Math.atan2(a.latitude - bottomPoint.latitude, a.longitude - bottomPoint.longitude);
      const angleB = Math.atan2(b.latitude - bottomPoint.latitude, b.longitude - bottomPoint.longitude);
      return angleA - angleB;
    });
  
  // Graham scan
  const stack: Point[] = [bottomPoint, sortedPoints[0]];
  
  for (let i = 1; i < sortedPoints.length; i++) {
    while (stack.length > 1 && !isLeftTurn(
      stack[stack.length - 2],
      stack[stack.length - 1],
      sortedPoints[i]
    )) {
      stack.pop();
    }
    stack.push(sortedPoints[i]);
  }
  
  return stack;
};

export const calculateConvexHullArea = (hull: Point[]): number => {
  if (hull.length < 3) return 0;
  
  // Convert lat/lng to approximate meters using simple projection
  // This is approximate but sufficient for area comparison
  const EARTH_RADIUS = 6371000; // meters
  const avgLat = hull.reduce((sum, p) => sum + p.latitude, 0) / hull.length;
  const latToMeters = EARTH_RADIUS * Math.PI / 180;
  const lngToMeters = latToMeters * Math.cos(avgLat * Math.PI / 180);
  
  // Convert to meters
  const metersPoints = hull.map(p => ({
    x: p.longitude * lngToMeters,
    y: p.latitude * latToMeters
  }));
  
  // Calculate area using shoelace formula
  let area = 0;
  for (let i = 0; i < metersPoints.length; i++) {
    const j = (i + 1) % metersPoints.length;
    area += metersPoints[i].x * metersPoints[j].y;
    area -= metersPoints[j].x * metersPoints[i].y;
  }
  
  area = Math.abs(area) / 2;
  
  // Convert from square meters to square kilometers
  return area / 1000000;
};

function isLeftTurn(p1: Point, p2: Point, p3: Point): boolean {
  return ((p2.longitude - p1.longitude) * (p3.latitude - p1.latitude) - 
          (p2.latitude - p1.latitude) * (p3.longitude - p1.longitude)) > 0;
}