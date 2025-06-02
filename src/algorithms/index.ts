import { LocationData, AlgorithmType, AlgorithmResult } from '../types';
import { nearestNeighbor } from './nearestNeighbor';
import { simulatedAnnealing } from './simulatedAnnealing';

// Cache for algorithm results
const resultCache = new Map<string, AlgorithmResult>();

// Debounce function
const debounce = <T extends (...args: any[]) => Promise<any>>(
  func: T,
  wait: number
) => {
  let timeout: NodeJS.Timeout;
  
  return (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return new Promise((resolve) => {
      clearTimeout(timeout);
      timeout = setTimeout(async () => {
        const result = await func(...args);
        resolve(result as ReturnType<T>);
      }, wait);
    });
  };
};

// Process data in batches
const processBatch = async (
  algorithm: (data: LocationData) => Promise<AlgorithmResult>,
  data: LocationData,
  batchSize: number = 50
): Promise<AlgorithmResult> => {
  const { distributor, customers } = data;
  const batches = [];
  
  for (let i = 0; i < customers.length; i += batchSize) {
    batches.push({
      distributor,
      customers: customers.slice(i, i + batchSize)
    });
  }
  
  const results = await Promise.all(
    batches.map(batch => algorithm(batch))
  );
  
  // Merge batch results
  return results.reduce((merged, result) => ({
    ...result,
    totalDistance: merged.totalDistance + result.totalDistance,
    totalSalesmen: merged.totalSalesmen + result.totalSalesmen,
    routes: [...merged.routes, ...result.routes]
  }));
};

// Memoized algorithm execution
const executeMemoized = async (
  algorithm: (data: LocationData) => Promise<AlgorithmResult>,
  data: LocationData,
  cacheKey: string
): Promise<AlgorithmResult> => {
  const cached = resultCache.get(cacheKey);
  if (cached) return cached;
  
  const result = await processBatch(algorithm, data);
  resultCache.set(cacheKey, result);
  return result;
};

// Debounced execute function
const debouncedExecute = debounce(async (
  algorithmType: AlgorithmType,
  locationData: LocationData
): Promise<AlgorithmResult> => {
  const startTime = performance.now();
  const cacheKey = `${algorithmType}-${JSON.stringify(locationData)}`;
  
  let result: AlgorithmResult;
  
  switch (algorithmType) {
    case 'nearest-neighbor':
      result = await executeMemoized(nearestNeighbor, locationData, cacheKey);
      break;
    case 'simulated-annealing':
      result = await executeMemoized(simulatedAnnealing, locationData, cacheKey);
      break;
    default:
      throw new Error(`Unknown algorithm type: ${algorithmType}`);
  }
  
  const endTime = performance.now();
  const processingTime = endTime - startTime;
  
  return {
    ...result,
    processingTime
  };
}, 250);

export const executeAlgorithm = debouncedExecute;