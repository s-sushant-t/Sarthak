export interface Customer {
  id: string;
  latitude: number;
  longitude: number;
}

export interface ClusteredCustomer extends Customer {
  clusterId: number;
  isOutlier?: boolean;
}

export interface Distributor {
  latitude: number;
  longitude: number;
}

export interface LocationData {
  distributor: Distributor;
  customers: ClusteredCustomer[];
}

export interface RouteStop {
  customerId: string;
  latitude: number;
  longitude: number;
  distanceToNext: number;
  timeToNext: number;
  visitTime: number;
  clusterId: number;
  isOutlier?: boolean;
}

export interface SalesmanRoute {
  salesmanId: number;
  stops: RouteStop[];
  totalDistance: number;
  totalTime: number;
  clusterIds: number[];
}

export type RouteData = SalesmanRoute[];

export type AlgorithmType = 
  | 'nearest-neighbor'
  | 'simulated-annealing'
  | 'custom';

export interface AlgorithmResult {
  name: string;
  totalDistance: number;
  totalSalesmen: number;
  processingTime: number;
  routes: RouteData;
  isCustom?: boolean;
}