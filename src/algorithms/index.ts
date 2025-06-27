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
        // Add timeout for simulated annealing to prevent infinite processing
        const timeoutPromise = new Promise<AlgorithmResult>((_, reject) => {
          setTimeout(() => reject(new Error('Algorithm timeout')), 30000); // 30 second timeout
        });
        result = await Promise.race([
          simulatedAnnealing(locationData, config),
          timeoutPromise
        ]);
        break;
      case 'dbscan':
        // Add timeout for DBSCAN to prevent infinite processing
        const dbscanTimeoutPromise = new Promise<AlgorithmResult>((_, reject) => {
          setTimeout(() => reject(new Error('Algorithm timeout')), 35000); // 35 second timeout
        });
        result = await Promise.race([
          dbscan(locationData, config),
          dbscanTimeoutPromise
        ]);
        break;
      case 'custom':
        throw new Error('Custom algorithm cannot be executed directly');
      default:
        throw new Error(`Unknown algorithm type: ${algorithmType}`);
    }
    
    const endTime = performance.now();
    const processingTime = endTime - startTime;
    
    return {
      ...result,
      processingTime
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'Algorithm timeout') {
      // Fallback to nearest neighbor if algorithm times out
      console.warn(`${algorithmType} timed out, falling back to nearest neighbor`);
      result = await nearestNeighbor(locationData, config);
      const endTime = performance.now();
      return {
        ...result,
        name: `${algorithmType} (Fallback to Nearest Neighbor)`,
        processingTime: endTime - startTime
      };
    }
    console.error(`Error executing ${algorithmType}:`, error);
    throw error;
  }
};