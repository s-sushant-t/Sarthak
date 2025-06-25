import { LocationData, AlgorithmType, AlgorithmResult } from '../types';
import { ClusteringConfig } from '../components/ClusteringConfiguration';
import { nearestNeighbor } from './nearestNeighbor';
import { simulatedAnnealing } from './simulatedAnnealing';
import { enhancedNearestNeighbor } from './enhancedNearestNeighbor';

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
        result = await enhancedNearestNeighbor(locationData, config);
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
      // Fallback to enhanced nearest neighbor if simulated annealing times out
      console.warn('Simulated annealing timed out, falling back to enhanced nearest neighbor');
      result = await enhancedNearestNeighbor(locationData, config);
      const endTime = performance.now();
      return {
        ...result,
        name: 'Simulated Annealing (Enhanced Fallback)',
        processingTime: endTime - startTime
      };
    }
    console.error(`Error executing ${algorithmType}:`, error);
    throw error;
  }
};