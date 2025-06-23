import React, { useState } from 'react';
import { Settings, Target, Users, MapPin, Clock, Calculator } from 'lucide-react';

interface ClusteringConfigurationProps {
  totalCustomers: number;
  onConfigurationSet: (config: ClusteringConfig) => void;
  onCancel: () => void;
}

export interface ClusteringConfig {
  totalClusters: number;
  beatsPerCluster: number;
  minOutletsPerBeat: number;
  maxOutletsPerBeat: number;
  maxWorkingTimeMinutes: number;
  customerVisitTimeMinutes: number;
  travelSpeedKmh: number;
}

const ClusteringConfiguration: React.FC<ClusteringConfigurationProps> = ({
  totalCustomers,
  onConfigurationSet,
  onCancel
}) => {
  const [config, setConfig] = useState<ClusteringConfig>({
    totalClusters: 6,
    beatsPerCluster: 6,
    minOutletsPerBeat: 30,
    maxOutletsPerBeat: 45,
    maxWorkingTimeMinutes: 360,
    customerVisitTimeMinutes: 6,
    travelSpeedKmh: 30
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const calculateMetrics = () => {
    const totalBeats = config.totalClusters * config.beatsPerCluster;
    const avgOutletsPerBeat = Math.ceil(totalCustomers / totalBeats);
    const avgOutletsPerCluster = Math.ceil(totalCustomers / config.totalClusters);
    const estimatedWorkingTime = (config.customerVisitTimeMinutes * avgOutletsPerBeat) + 
                                (avgOutletsPerBeat * 10); // Estimated 10 min travel between outlets
    
    return {
      totalBeats,
      avgOutletsPerBeat,
      avgOutletsPerCluster,
      estimatedWorkingTime,
      feasible: estimatedWorkingTime <= config.maxWorkingTimeMinutes &&
                avgOutletsPerBeat >= config.minOutletsPerBeat &&
                avgOutletsPerBeat <= config.maxOutletsPerBeat
    };
  };

  const metrics = calculateMetrics();

  const validateConfiguration = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (config.totalClusters < 1 || config.totalClusters > 20) {
      newErrors.totalClusters = 'Number of clusters must be between 1 and 20';
    }

    if (config.beatsPerCluster < 1 || config.beatsPerCluster > 20) {
      newErrors.beatsPerCluster = 'Beats per cluster must be between 1 and 20';
    }

    if (config.minOutletsPerBeat >= config.maxOutletsPerBeat) {
      newErrors.minOutletsPerBeat = 'Minimum outlets must be less than maximum outlets';
    }

    if (config.minOutletsPerBeat < 1) {
      newErrors.minOutletsPerBeat = 'Minimum outlets per beat must be at least 1';
    }

    if (config.maxOutletsPerBeat > 100) {
      newErrors.maxOutletsPerBeat = 'Maximum outlets per beat cannot exceed 100';
    }

    if (config.maxWorkingTimeMinutes < 60 || config.maxWorkingTimeMinutes > 720) {
      newErrors.maxWorkingTimeMinutes = 'Working time must be between 1 and 12 hours';
    }

    if (config.customerVisitTimeMinutes < 1 || config.customerVisitTimeMinutes > 60) {
      newErrors.customerVisitTimeMinutes = 'Visit time must be between 1 and 60 minutes';
    }

    if (config.travelSpeedKmh < 5 || config.travelSpeedKmh > 100) {
      newErrors.travelSpeedKmh = 'Travel speed must be between 5 and 100 km/h';
    }

    const totalBeats = config.totalClusters * config.beatsPerCluster;
    if (totalBeats > totalCustomers) {
      newErrors.totalClusters = `Total beats (${totalBeats}) cannot exceed total customers (${totalCustomers})`;
    }

    if (!metrics.feasible) {
      newErrors.feasibility = 'Configuration may not be feasible with current constraints';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validateConfiguration()) {
      onConfigurationSet(config);
    }
  };

  const updateConfig = (field: keyof ClusteringConfig, value: number) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setErrors(prev => ({ ...prev, [field]: '', feasibility: '' }));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="bg-blue-100 p-2 rounded-lg">
              <Settings className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-gray-800">Configure Route Parameters</h2>
              <p className="text-gray-600">Set up clustering and routing constraints for {totalCustomers.toLocaleString()} customers</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-8">
          {/* Cluster Configuration */}
          <div className="bg-blue-50 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Target className="w-5 h-5 text-blue-600" />
              Cluster & Beat Configuration
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Number of Clusters
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={config.totalClusters}
                  onChange={(e) => updateConfig('totalClusters', parseInt(e.target.value) || 1)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.totalClusters ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                {errors.totalClusters && (
                  <p className="text-red-500 text-sm mt-1">{errors.totalClusters}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Beats per Cluster
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={config.beatsPerCluster}
                  onChange={(e) => updateConfig('beatsPerCluster', parseInt(e.target.value) || 1)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.beatsPerCluster ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                {errors.beatsPerCluster && (
                  <p className="text-red-500 text-sm mt-1">{errors.beatsPerCluster}</p>
                )}
              </div>
            </div>
          </div>

          {/* Beat Constraints */}
          <div className="bg-green-50 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-green-600" />
              Beat Size Constraints
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Minimum Outlets per Beat
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={config.minOutletsPerBeat}
                  onChange={(e) => updateConfig('minOutletsPerBeat', parseInt(e.target.value) || 1)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.minOutletsPerBeat ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                {errors.minOutletsPerBeat && (
                  <p className="text-red-500 text-sm mt-1">{errors.minOutletsPerBeat}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Maximum Outlets per Beat
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={config.maxOutletsPerBeat}
                  onChange={(e) => updateConfig('maxOutletsPerBeat', parseInt(e.target.value) || 1)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.maxOutletsPerBeat ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                {errors.maxOutletsPerBeat && (
                  <p className="text-red-500 text-sm mt-1">{errors.maxOutletsPerBeat}</p>
                )}
              </div>
            </div>
          </div>

          {/* Time & Speed Constraints */}
          <div className="bg-purple-50 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Clock className="w-5 h-5 text-purple-600" />
              Time & Speed Parameters
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Max Working Time (minutes)
                </label>
                <input
                  type="number"
                  min="60"
                  max="720"
                  step="30"
                  value={config.maxWorkingTimeMinutes}
                  onChange={(e) => updateConfig('maxWorkingTimeMinutes', parseInt(e.target.value) || 360)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.maxWorkingTimeMinutes ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                {errors.maxWorkingTimeMinutes && (
                  <p className="text-red-500 text-sm mt-1">{errors.maxWorkingTimeMinutes}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Visit Time per Customer (minutes)
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={config.customerVisitTimeMinutes}
                  onChange={(e) => updateConfig('customerVisitTimeMinutes', parseInt(e.target.value) || 6)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.customerVisitTimeMinutes ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                {errors.customerVisitTimeMinutes && (
                  <p className="text-red-500 text-sm mt-1">{errors.customerVisitTimeMinutes}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Travel Speed (km/h)
                </label>
                <input
                  type="number"
                  min="5"
                  max="100"
                  value={config.travelSpeedKmh}
                  onChange={(e) => updateConfig('travelSpeedKmh', parseInt(e.target.value) || 30)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.travelSpeedKmh ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                {errors.travelSpeedKmh && (
                  <p className="text-red-500 text-sm mt-1">{errors.travelSpeedKmh}</p>
                )}
              </div>
            </div>
          </div>

          {/* Calculated Metrics */}
          <div className="bg-gray-50 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Calculator className="w-5 h-5 text-gray-600" />
              Calculated Metrics
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-white p-4 rounded-lg border">
                <div className="text-2xl font-bold text-blue-600">{metrics.totalBeats}</div>
                <div className="text-sm text-gray-600">Total Beats</div>
              </div>
              <div className="bg-white p-4 rounded-lg border">
                <div className="text-2xl font-bold text-green-600">{metrics.avgOutletsPerBeat}</div>
                <div className="text-sm text-gray-600">Avg Outlets/Beat</div>
              </div>
              <div className="bg-white p-4 rounded-lg border">
                <div className="text-2xl font-bold text-purple-600">{metrics.avgOutletsPerCluster}</div>
                <div className="text-sm text-gray-600">Avg Outlets/Cluster</div>
              </div>
              <div className="bg-white p-4 rounded-lg border">
                <div className="text-2xl font-bold text-orange-600">{Math.round(metrics.estimatedWorkingTime)}</div>
                <div className="text-sm text-gray-600">Est. Working Time (min)</div>
              </div>
            </div>
            
            {!metrics.feasible && (
              <div className="mt-4 p-3 bg-yellow-100 border border-yellow-300 rounded-lg">
                <p className="text-yellow-800 text-sm">
                  ⚠️ Warning: Current configuration may not be feasible. Consider adjusting constraints.
                </p>
              </div>
            )}

            {errors.feasibility && (
              <div className="mt-4 p-3 bg-red-100 border border-red-300 rounded-lg">
                <p className="text-red-800 text-sm">{errors.feasibility}</p>
              </div>
            )}
          </div>
        </div>

        <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-6 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!metrics.feasible}
            className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Apply Configuration
          </button>
        </div>
      </div>
    </div>
  );
};

export default ClusteringConfiguration;