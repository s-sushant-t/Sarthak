export interface Customer {
  id: string;
  latitude: number;
  longitude: number;
  outletName?: string;
  gr1Sale?: number;
  gr2Sale?: number;
}

export interface ClusteredCustomer extends Customer {
  clusterId: number;
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
  outletName?: string;
}

export interface SalesmanRoute {
  salesmanId: number;
  stops: RouteStop[];
  totalDistance: number;
  totalTime: number;
  clusterIds: number[];
  distributorLat: number;
  distributorLng: number;
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