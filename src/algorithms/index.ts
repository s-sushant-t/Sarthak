import { LocationData, AlgorithmType, AlgorithmResult } from '../types';
import { ClusteringConfig } from '../components/ClusteringConfiguration';
import { nearestNeighbor } from './nearestNeighbor';
import { simulatedAnnealing } from './simulatedAnnealing';
import { dbscan } from './dbscan';

export const executeAlgorithm = async (
  algorithmType: AlgorithmType,
  locationData: LocationData,
  config: ClusteringConfig
): Promise<AlgorithmResult> => {
  const startTime = performance.now();
  
  let result: AlgorithmResult;
  
  try {
    switch (algorithmType) {
      case 'nearest-neighbor':
        result = await nearestNeighbor(locationData, config);
        break;
      case 'simulated-annealing':
        console.log('Starting optimized simulated annealing...');
        result = await simulatedAnnealing(locationData, config);
        break;
      case 'dbscan':
        console.log('Starting optimized DBSCAN...');
        result = await dbscan(locationData, config);
        break;
      case 'custom':
        throw new Error('Custom algorithm cannot be executed directly');
      default:
        throw new Error(`Unknown algorithm type: ${algorithmType}`);
    }
    
    const endTime = performance.now();
    const processingTime = endTime - startTime;
    
    console.log(`${algorithmType} completed in ${processingTime.toFixed(2)}ms`);
    
    return {
      ...result,
      processingTime
    };
  } catch (error) {
    console.error(`Error executing ${algorithmType}:`, error);
    
    // Only fallback to nearest neighbor if there's a critical error
    if (error instanceof Error && (
      error.message.includes('timeout') || 
      error.message.includes('memory') ||
      error.message.includes('critical')
    )) {
      console.warn(`${algorithmType} failed with critical error, falling back to nearest neighbor`);
      result = await nearestNeighbor(locationData, config);
      const endTime = performance.now();
      return {
        ...result,
        name: `${algorithmType} (Fallback to Nearest Neighbor)`,
        processingTime: endTime - startTime
      };
    }
    
    // Re-throw non-critical errors
    throw error;
  }
};