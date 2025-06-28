export interface RouteConstraints {
  minOutletsPerBeat: number;
  maxOutletsPerBeat: number;
  maxWorkingTimeMinutes: number;
  customerVisitTimeMinutes: number;
  travelSpeedKmh: number;
  minIsolationDistanceKm: number;
  maxIntraBeatDistanceKm: number;
}

export interface ValidationResult {
  isValid: boolean;
  violations: ValidationViolation[];
  summary: ValidationSummary;
}

export interface ValidationViolation {
  type: 'outlet_count' | 'working_time' | 'isolation' | 'intra_beat_distance';
  severity: 'error' | 'warning';
  beatId?: number;
  message: string;
  details?: any;
}

export interface ValidationSummary {
  totalBeats: number;
  totalOutlets: number;
  avgOutletsPerBeat: number;
  avgWorkingTime: number;
  maxWorkingTime: number;
  isolationViolations: number;
  intraBeatViolations: number;
  outletCountViolations: number;
  workingTimeViolations: number;
  compliancePercentage: number;
  maxIntraBeatDistanceFound: number;
  avgIntraBeatDistance: number;
}

import { SalesmanRoute } from '../types';
import { calculateHaversineDistance, calculateTravelTime } from './distanceCalculator';

export const validateRouteConstraints = (
  routes: SalesmanRoute[],
  constraints: RouteConstraints
): ValidationResult => {
  console.log('🔍 Starting comprehensive route constraint validation...');
  console.log('Constraints:', {
    isolation: `${constraints.minIsolationDistanceKm * 1000}m`,
    intraBeat: `${constraints.maxIntraBeatDistanceKm * 1000}m`,
    outlets: `${constraints.minOutletsPerBeat}-${constraints.maxOutletsPerBeat}`,
    workingTime: `${constraints.maxWorkingTimeMinutes}min`
  });
  
  const violations: ValidationViolation[] = [];
  let totalOutlets = 0;
  let totalWorkingTime = 0;
  let maxWorkingTime =   0;
  let isolationViolations = 0;
  let intraBeatViolations = 0;
  let outletCountViolations = 0;
  let workingTimeViolations = 0;
  let maxIntraBeatDistanceFound = 0;
  let totalIntraBeatDistance = 0;
  let intraBeatDistanceCount = 0;

  // 1. VALIDATE OUTLET COUNT CONSTRAINTS
  console.log('📊 Validating outlet count constraints...');
  routes.forEach(route => {
    const outletCount = route.stops.length;
    totalOutlets += outletCount;

    if (outletCount < constraints.minOutletsPerBeat) {
      violations.push({
        type: 'outlet_count',
        severity: 'warning',
        beatId: route.salesmanId,
        message: `Beat ${route.salesmanId} has only ${outletCount} outlets (minimum: ${constraints.minOutletsPerBeat})`
      });
      outletCountViolations++;
    }

    if (outletCount > constraints.maxOutletsPerBeat) {
      violations.push({
        type: 'outlet_count',
        severity: 'error',
        beatId: route.salesmanId,
        message: `Beat ${route.salesmanId} has ${outletCount} outlets (maximum: ${constraints.maxOutletsPerBeat})`
      });
      outletCountViolations++;
    }
  });

  // 2. VALIDATE WORKING TIME CONSTRAINTS
  console.log('⏰ Validating working time constraints...');
  routes.forEach(route => {
    const workingTime = route.totalTime;
    totalWorkingTime += workingTime;
    maxWorkingTime = Math.max(maxWorkingTime, workingTime);

    if (workingTime > constraints.maxWorkingTimeMinutes) {
      violations.push({
        type: 'working_time',
        severity: 'error',
        beatId: route.salesmanId,
        message: `Beat ${route.salesmanId} working time is ${Math.round(workingTime)}min (maximum: ${constraints.maxWorkingTimeMinutes}min)`,
        details: { actualTime: workingTime, maxTime: constraints.maxWorkingTimeMinutes }
      });
      workingTimeViolations++;
    }
  });

  // 3. VALIDATE ISOLATION CONSTRAINTS (50m between beats)
  console.log('🚫 Validating isolation constraints...');
  for (let i = 0; i < routes.length; i++) {
    const beat1 = routes[i];
    
    for (let j = i + 1; j < routes.length; j++) {
      const beat2 = routes[j];
      
      // Check all customer pairs between these beats
      for (const customer1 of beat1.stops) {
        for (const customer2 of beat2.stops) {
          const distance = calculateHaversineDistance(
            customer1.latitude, customer1.longitude,
            customer2.latitude, customer2.longitude
          );
          
          if (distance < constraints.minIsolationDistanceKm) {
            violations.push({
              type: 'isolation',
              severity: 'error',
              message: `Isolation violation: Customer ${customer1.customerId} (Beat ${beat1.salesmanId}) and ${customer2.customerId} (Beat ${beat2.salesmanId}) are ${(distance * 1000).toFixed(0)}m apart (minimum: ${constraints.minIsolationDistanceKm * 1000}m)`,
              details: { 
                distance: distance * 1000, 
                minDistance: constraints.minIsolationDistanceKm * 1000,
                customer1: customer1.customerId,
                customer2: customer2.customerId,
                beat1: beat1.salesmanId,
                beat2: beat2.salesmanId
              }
            });
            isolationViolations++;
          }
        }
      }
    }
  }

  // 4. VALIDATE INTRA-BEAT DISTANCE CONSTRAINTS (200m within beats)
  console.log('📏 Validating intra-beat distance constraints...');
  routes.forEach(route => {
    for (let i = 0; i < route.stops.length; i++) {
      for (let j = i + 1; j < route.stops.length; j++) {
        const customer1 = route.stops[i];
        const customer2 = route.stops[j];
        
        const distance = calculateHaversineDistance(
          customer1.latitude, customer1.longitude,
          customer2.latitude, customer2.longitude
        );
        
        // Track statistics
        totalIntraBeatDistance += distance;
        intraBeatDistanceCount++;
        maxIntraBeatDistanceFound = Math.max(maxIntraBeatDistanceFound, distance);
        
        if (distance > constraints.maxIntraBeatDistanceKm) {
          violations.push({
            type: 'intra_beat_distance',
            severity: 'error',
            beatId: route.salesmanId,
            message: `Intra-beat violation: Customers ${customer1.customerId} and ${customer2.customerId} in Beat ${route.salesmanId} are ${(distance * 1000).toFixed(0)}m apart (maximum: ${constraints.maxIntraBeatDistanceKm * 1000}m)`,
            details: { 
              distance: distance * 1000, 
              maxDistance: constraints.maxIntraBeatDistanceKm * 1000,
              customer1: customer1.customerId,
              customer2: customer2.customerId,
              beatId: route.salesmanId
            }
          });
          intraBeatViolations++;
        }
      }
    }
  });

  // Calculate summary statistics
  const avgOutletsPerBeat = routes.length > 0 ? totalOutlets / routes.length : 0;
  const avgWorkingTime = routes.length > 0 ? totalWorkingTime / routes.length : 0;
  const avgIntraBeatDistance = intraBeatDistanceCount > 0 ? totalIntraBeatDistance / intraBeatDistanceCount : 0;
  
  const totalViolations = violations.length;
  const totalPossibleViolations = routes.length * 4; // 4 types of constraints per route
  const compliancePercentage = totalPossibleViolations > 0 ? 
    ((totalPossibleViolations - totalViolations) / totalPossibleViolations) * 100 : 100;

  const summary: ValidationSummary = {
    totalBeats: routes.length,
    totalOutlets,
    avgOutletsPerBeat,
    avgWorkingTime,
    maxWorkingTime,
    isolationViolations,
    intraBeatViolations,
    outletCountViolations,
    workingTimeViolations,
    compliancePercentage,
    maxIntraBeatDistanceFound: maxIntraBeatDistanceFound * 1000, // Convert to meters
    avgIntraBeatDistance: avgIntraBeatDistance * 1000 // Convert to meters
  };

  const isValid = violations.filter(v => v.severity === 'error').length === 0;

  console.log('📋 Validation Summary:');
  console.log(`- Total Beats: ${summary.totalBeats}`);
  console.log(`- Total Outlets: ${summary.totalOutlets}`);
  console.log(`- Avg Outlets/Beat: ${summary.avgOutletsPerBeat.toFixed(1)}`);
  console.log(`- Avg Working Time: ${summary.avgWorkingTime.toFixed(0)}min`);
  console.log(`- Max Working Time: ${summary.maxWorkingTime.toFixed(0)}min`);
  console.log(`- Isolation Violations: ${summary.isolationViolations}`);
  console.log(`- Intra-beat Violations: ${summary.intraBeatViolations}`);
  console.log(`- Max Intra-beat Distance: ${summary.maxIntraBeatDistanceFound.toFixed(0)}m`);
  console.log(`- Avg Intra-beat Distance: ${summary.avgIntraBeatDistance.toFixed(0)}m`);
  console.log(`- Compliance: ${summary.compliancePercentage.toFixed(1)}%`);
  console.log(`- Overall Valid: ${isValid ? '✅' : '❌'}`);

  return {
    isValid,
    violations,
    summary
  };
};

// Helper function to validate a single route
export const validateSingleRoute = (
  route: SalesmanRoute,
  constraints: RouteConstraints,
  allRoutes: SalesmanRoute[]
): ValidationViolation[] => {
  const violations: ValidationViolation[] = [];

  // Check outlet count
  const outletCount = route.stops.length;
  if (outletCount < constraints.minOutletsPerBeat) {
    violations.push({
      type: 'outlet_count',
      severity: 'warning',
      beatId: route.salesmanId,
      message: `Beat has only ${outletCount} outlets (minimum: ${constraints.minOutletsPerBeat})`
    });
  }

  if (outletCount > constraints.maxOutletsPerBeat) {
    violations.push({
      type: 'outlet_count',
      severity: 'error',
      beatId: route.salesmanId,
      message: `Beat has ${outletCount} outlets (maximum: ${constraints.maxOutletsPerBeat})`
    });
  }

  // Check working time
  if (route.totalTime > constraints.maxWorkingTimeMinutes) {
    violations.push({
      type: 'working_time',
      severity: 'error',
      beatId: route.salesmanId,
      message: `Working time is ${Math.round(route.totalTime)}min (maximum: ${constraints.maxWorkingTimeMinutes}min)`
    });
  }

  // Check intra-beat distances
  for (let i = 0; i < route.stops.length; i++) {
    for (let j = i + 1; j < route.stops.length; j++) {
      const customer1 = route.stops[i];
      const customer2 = route.stops[j];
      
      const distance = calculateHaversineDistance(
        customer1.latitude, customer1.longitude,
        customer2.latitude, customer2.longitude
      );
      
      if (distance > constraints.maxIntraBeatDistanceKm) {
        violations.push({
          type: 'intra_beat_distance',
          severity: 'error',
          beatId: route.salesmanId,
          message: `Customers ${customer1.customerId} and ${customer2.customerId} are ${(distance * 1000).toFixed(0)}m apart (maximum: ${constraints.maxIntraBeatDistanceKm * 1000}m)`
        });
      }
    }
  }

  // Check isolation with other routes
  allRoutes.forEach(otherRoute => {
    if (otherRoute.salesmanId === route.salesmanId) return;
    
    route.stops.forEach(customer1 => {
      otherRoute.stops.forEach(customer2 => {
        const distance = calculateHaversineDistance(
          customer1.latitude, customer1.longitude,
          customer2.latitude, customer2.longitude
        );
        
        if (distance < constraints.minIsolationDistanceKm) {
          violations.push({
            type: 'isolation',
            severity: 'error',
            beatId: route.salesmanId,
            message: `Customer ${customer1.customerId} is ${(distance * 1000).toFixed(0)}m from customer ${customer2.customerId} in Beat ${otherRoute.salesmanId} (minimum: ${constraints.minIsolationDistanceKm * 1000}m)`
          });
        }
      });
    });
  });

  return violations;
};

// Helper function to get constraint violations by type
export const getViolationsByType = (violations: ValidationViolation[], type: ValidationViolation['type']): ValidationViolation[] => {
  return violations.filter(v => v.type === type);
};

// Helper function to get violations by severity
export const getViolationsBySeverity = (violations: ValidationViolation[], severity: ValidationViolation['severity']): ValidationViolation[] => {
  return violations.filter(v => v.severity === severity);
};