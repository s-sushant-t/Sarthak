import { LocationData, AlgorithmType, AlgorithmResult } from '../types';
import { nearestNeighbor } from './nearestNeighbor';

export const executeAlgorithm = async (
  algorithmType: AlgorithmType,
  locationData: LocationData
): Promise<AlgorithmResult> => {
  const startTime = performance.now();
  
  let result: AlgorithmResult;
  
  switch (algorithmType) {
    case 'nearest-neighbor':
      result = await nearestNeighbor(locationData);
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
};