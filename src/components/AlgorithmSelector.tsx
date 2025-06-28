import React from 'react';
import { AlgorithmType, AlgorithmResult } from '../types';
import { Award } from 'lucide-react';

interface AlgorithmSelectorProps {
  results: Record<AlgorithmType, AlgorithmResult | null>;
  selectedAlgorithm: AlgorithmType | null;
  onSelect: (algorithm: AlgorithmType) => void;
}

interface AlgorithmCardProps {
  type: AlgorithmType;
  name: string;
  description: string;
  result: AlgorithmResult | null;
  isSelected: boolean;
  onSelect: () => void;
  isProcessed: boolean;
  isCustom?: boolean;
}

const AlgorithmCard: React.FC<AlgorithmCardProps> = ({ 
  type, name, description, result, isSelected, onSelect, isProcessed, isCustom 
}) => {
  const findBestResult = (results: AlgorithmResult | null): number | null => {
    if (!result || !results) return null;
    return result.totalDistance;
  };

  const bestDistance = findBestResult(result);
  const improvement = bestDistance && result?.totalDistance 
    ? ((bestDistance - result.totalDistance) / bestDistance) * 100 
    : null;

  return (
    <div 
      className={`p-4 rounded-lg border cursor-pointer transition-all
        ${isSelected 
          ? 'border-blue-500 bg-blue-50 shadow-sm' 
          : 'border-gray-200 hover:border-blue-300'}`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between">
        <div className="flex-grow">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-gray-800">{name}</h3>
            {isCustom && (
              <span className="px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full">
                Custom
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">{description}</p>
        </div>
        <div className={`h-4 w-4 rounded-full ${isSelected ? 'bg-blue-500' : 'bg-gray-200'}`}></div>
      </div>
      
      {isProcessed && result && (
        <div className="mt-3 space-y-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>Total Distance:</span>
            <span className="font-medium">{result.totalDistance.toFixed(2)} km</span>
          </div>
          <div className="flex justify-between text-sm text-gray-600">
            <span>Beats Formed:</span>
            <span className="font-medium">{result.totalSalesmen}</span>
          </div>
          <div className="flex justify-between text-sm text-gray-600">
            <span>Clusters:</span>
            <span className="font-medium">
              {new Set(result.routes.flatMap(r => r.clusterIds)).size}
            </span>
          </div>
          {isCustom && improvement && (
            <div className={`text-sm ${improvement > 0 ? 'text-green-600' : 'text-red-600'}`}>
              {improvement > 0 
                ? `${improvement.toFixed(1)}% improvement over best algorithm`
                : `${Math.abs(improvement).toFixed(1)}% worse than best algorithm`}
            </div>
          )}
        </div>
      )}
      
      {isProcessed && !result && (
        <div className="mt-2 text-sm text-gray-500 italic">Processing failed</div>
      )}
      
      {!isProcessed && (
        <div className="mt-2 flex items-center">
          <div className="animate-spin h-3 w-3 border-t-2 border-blue-500 rounded-full mr-2"></div>
          <span className="text-xs text-gray-500">Processing...</span>
        </div>
      )}
    </div>
  );
};

const AlgorithmSelector: React.FC<AlgorithmSelectorProps> = ({ results, selectedAlgorithm, onSelect }) => {
  const algorithms = [
    {
      type: 'nearest-neighbor' as AlgorithmType,
      name: 'Nearest Neighbor',
      description: 'Cluster-based approach that builds routes by selecting the closest unvisited customer within each cluster'
    },
    {
      type: 'simulated-annealing' as AlgorithmType,
      name: 'Simulated Annealing',
      description: 'Advanced optimization technique that refines cluster-based routes through controlled randomization'
    },
    {
      type: 'dbscan' as AlgorithmType,
      name: 'DBSCAN Beat Formation',
      description: 'Density-based clustering that forms beats of outlets within 200m radius, creating compact geographical groups'
    }
  ];

  const getBestResult = () => {
    let bestDistance = Infinity;
    let bestType: AlgorithmType | null = null;

    algorithms.forEach(algo => {
      const result = results[algo.type];
      if (result && result.totalDistance < bestDistance) {
        bestDistance = result.totalDistance;
        bestType = algo.type;
      }
    });

    return bestType;
  };

  const bestAlgorithm = getBestResult();

  return (
    <div className="space-y-3">
      <h3 className="font-medium text-gray-800">Select Algorithm</h3>
      
      <div className="space-y-3">
        {algorithms.map(algo => (
          <AlgorithmCard
            key={algo.type}
            type={algo.type}
            name={algo.name}
            description={algo.description}
            result={results[algo.type]}
            isSelected={selectedAlgorithm === algo.type}
            onSelect={() => onSelect(algo.type)}
            isProcessed={results[algo.type] !== null}
          />
        ))}
        
        {results.custom && (
          <div className="relative pt-3">
            <div className="absolute inset-0 flex items-center\" aria-hidden="true">
              <div className="w-full border-t border-gray-200"></div>
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 bg-white text-sm text-gray-500">Custom Solution</span>
            </div>
          </div>
        )}
        
        {results.custom && (
          <AlgorithmCard
            type="custom"
            name="Custom Route"
            description="Manually optimized cluster-based route through drag-and-drop customization"
            result={results.custom}
            isSelected={selectedAlgorithm === 'custom'}
            onSelect={() => onSelect('custom')}
            isProcessed={true}
            isCustom={true}
          />
        )}
      </div>
    </div>
  );
};

export default AlgorithmSelector;