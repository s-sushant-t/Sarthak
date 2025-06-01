/**
 * Calculate the Haversine distance between two points on the Earth's surface.
 * 
 * @param lat1 Latitude of first point in decimal degrees
 * @param lon1 Longitude of first point in decimal degrees
 * @param lat2 Latitude of second point in decimal degrees
 * @param lon2 Longitude of second point in decimal degrees
 * @returns Distance in kilometers
 */
export const calculateHaversineDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  // Earth's radius in kilometers
  const R = 6371;
  
  // Convert latitude and longitude from degrees to radians
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  
  // Haversine formula
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  return distance;
};

/**
 * Calculate the travel time between two points based on distance and speed.
 * 
 * @param distance Distance in kilometers
 * @param speedKmPerHour Speed in kilometers per hour (defaults to 20 km/h)
 * @returns Travel time in minutes
 */
export const calculateTravelTime = (
  distance: number,
  speedKmPerHour: number = 20 // Updated default speed from 30 to 20
): number => {
  // Time = Distance / Speed (in hours)
  const timeInHours = distance / speedKmPerHour;
  
  // Convert hours to minutes
  return timeInHours * 60;
};