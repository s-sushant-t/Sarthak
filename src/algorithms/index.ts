import { LocationData, AlgorithmType, AlgorithmResult } from '../types';
import { nearestNeighbor } from './nearestNeighbor';
import { simulatedAnnealing } from './simulatedAnnealing';

export const executeAlgorithm = async (
  algorithmType: AlgorithmType,
  locationData: LocationData
): Promise<AlgorithmResult> => {
  const startTime = performance.now();
  
  let result: AlgorithmResult;
  
  try {
    switch (algorithmType) {
      case 'nearest-neighbor':
        result = await nearestNeighbor(locationData);
        break;
      case 'simulated-annealing':
        // Add timeout for simulated annealing to prevent infinite processing
        const timeoutPromise = new Promise<AlgorithmResult>((_, reject) => {
          setTimeout(() => reject(new Error('Algorithm timeout')), 30000); // 30 second timeout
        });
        result = await Promise.race([
          simulatedAnnealing(locationData),
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
      // Fallback to nearest neighbor if simulated annealing times out
      console.warn('Simulated annealing timed out, falling back to nearest neighbor');
      result = await nearestNeighbor(locationData);
      const endTime = performance.now();
      return {
        ...result,
        name: 'Simulated Annealing (Fallback)',
        processingTime: endTime - startTime
      };
    }
    console.error(`Error executing ${algorithmType}:`, error);
    throw error;
  }
};