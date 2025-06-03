import React from 'react';
import { BarChart2, Award, Download } from 'lucide-react';
import { AlgorithmType, AlgorithmResult } from '../types';
import { exportToCSV } from '../utils/csvExporter';
import AssignDistributor from './AssignDistributor';

interface ResultsViewProps {
  results: Record<AlgorithmType, AlgorithmResult | null>;
  selectedAlgorithm: AlgorithmType;
  onSelectAlgorithm: (algorithm: AlgorithmType) => void;
  onExportCSV: () => void;
  showAssignDistributor?: boolean;
  onAssignDistributor?: (code: string) => void;
}

const ResultsView: React.FC<ResultsViewProps> = ({ 
  results, 
  selectedAlgorithm,
  onSelectAlgorithm,
  onExportCSV,
  showAssignDistributor,
  onAssignDistributor
}) => {
  const bestAlgorithm = Object.entries(results)
    .filter(([_, result]) => result !== null)
    .reduce<{ type: AlgorithmType; distance: number } | null>(
      (best, [type, result]) => {
        if (!result) return best;
        if (!best || result.totalDistance < best.distance) {
          return { type: type as AlgorithmType, distance: result.totalDistance };
        }
        return best;
      }, 
      null
    );

  const getMaxDistance = () => {
    return Object.values(results)
      .filter(result => result !== null)
      .reduce((max, result) => {
        return result && result.totalDistance > max ? result.totalDistance : max;
      }, 0);
  };

  const maxDistance = getMaxDistance();

  const handleExportCurrentAlgorithm = () => {
    if (!selectedAlgorithm || !results[selectedAlgorithm]) return;
    
    const selectedResult = results[selectedAlgorithm];
    if (!selectedResult) return;
    
    exportToCSV(selectedResult.routes, `routes_${selectedAlgorithm}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">Algorithm Comparison</h2>
        <p className="text-gray-600">Compare the performance of different routing algorithms</p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Object.entries(results)
          .filter(([_, result]) => result !== null)
          .map(([type, result]) => {
            if (!result) return null;
            
            const isSelected = type === selectedAlgorithm;
            const isBest = type === bestAlgorithm?.type;
            
            return (
              <div 
                key={type}
                className={`
                  p-4 rounded-lg border transition-all cursor-pointer
                  ${isSelected ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 hover:border-blue-300 bg-white'}
                  ${isBest ? 'ring-2 ring-yellow-300' : ''}
                `}
                onClick={() => onSelectAlgorithm(type as AlgorithmType)}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium text-gray-800">{result.name}</h3>
                    <p className="text-sm text-gray-500">
                      {result.totalSalesmen} beats • {result.processingTime.toFixed(2)}ms
                    </p>
                  </div>
                  {isBest && (
                    <div className="bg-yellow-100 p-1 rounded-full">
                      <Award size={16} className="text-yellow-600" />
                    </div>
                  )}
                </div>
                
                <div className="mt-3">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-sm text-gray-600">Total Distance:</span>
                    <span className="font-semibold">{result.totalDistance.toFixed(2)} km</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className={`h-2 rounded-full ${isBest ? 'bg-green-500' : 'bg-blue-500'}`}
                      style={{ width: `${(result.totalDistance / maxDistance) * 100}%` }}
                    ></div>
                  </div>
                </div>
                
                <div className="mt-4 flex justify-between items-center">
                  <div className="text-sm text-gray-500">
                    Average per beat: {(result.totalDistance / result.totalSalesmen).toFixed(2)} km
                  </div>
                  {isSelected && (
                    <button 
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-500 text-white hover:bg-green-600 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExportCurrentAlgorithm();
                      }}
                    >
                      <Download size={12} />
                      <span>Export</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
      </div>
      
      {selectedAlgorithm && results[selectedAlgorithm] && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="font-medium text-gray-800 mb-3">
            Details for {results[selectedAlgorithm]?.name}
          </h3>
          
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Route Distribution</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="px-4 py-2 text-left text-gray-500 font-medium">Beat</th>
                      <th className="px-4 py-2 text-left text-gray-500 font-medium">Customers</th>
                      <th className="px-4 py-2 text-left text-gray-500 font-medium">Distance</th>
                      <th className="px-4 py-2 text-left text-gray-500 font-medium">Working Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {results[selectedAlgorithm]?.routes.map(route => (
                      <tr key={route.salesmanId} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-medium">#{route.salesmanId}</td>
                        <td className="px-4 py-2">{route.stops.length}</td>
                        <td className="px-4 py-2">{route.totalDistance.toFixed(2)} km</td>
                        <td className="px-4 py-2">{Math.round(route.totalTime)} min</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Algorithm Description</h4>
              <p className="text-sm text-gray-600">
                {selectedAlgorithm === 'nearest-neighbor' && (
                  "Nearest Neighbor is a greedy algorithm that starts at the distributor and repeatedly selects the nearest unvisited customer until all customers are visited. It's simple but can lead to suboptimal routes."
                )}
                {selectedAlgorithm === 'simulated-annealing' && (
                  "Simulated Annealing is a probabilistic technique that mimics the physical process of annealing in metallurgy. It starts with a random solution and gradually 'cools' the system, decreasing the probability of accepting worse solutions as it explores the solution space."
                )}
                {selectedAlgorithm === 'custom' && (
                  "Custom Route is a manually optimized solution created through interactive adjustments to the generated routes. It allows for fine-tuning based on specific requirements or local knowledge."
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {showAssignDistributor && selectedAlgorithm && results[selectedAlgorithm] && (
        <AssignDistributor
          routes={results[selectedAlgorithm]!.routes}
          onAssign={(code) => onAssignDistributor?.(code)}
        />
      )}
    </div>
  );
};

export default ResultsView;