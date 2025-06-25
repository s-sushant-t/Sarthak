import React, { useState, useEffect } from 'react';
import { Settings, Target, Users, MapPin, Clock, Calculator, Shield } from 'lucide-react';

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
  // New enhanced constraints
  dbscanEps: number;
  dbscanMinSamples: number;
  maxConvexHullArea: number;
  maxConvexHullAreaSmall: number;
  enablePercentileMode: boolean;
  percentileModeThreshold: number;
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
    travelSpeedKmh: 30,
    // Enhanced constraints with defaults
    dbscanEps: 0.3,
    dbscanMinSamples: 4,
    maxConvexHullArea: 3.0,
    maxConvexHullAreaSmall: 2.5,
    enablePercentileMode: true,
    percentileModeThreshold: 90
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const calculateMetrics = () => {
    const totalBeats = config.totalClusters * config.beatsPerCluster;
    const avgOutletsPerBeat = Math.ceil(totalCustomers / totalBeats);
    const avgOutletsPerCluster = Math.ceil(totalCustomers / config.totalClusters);
    
    // More realistic working time estimation
    const estimatedTravelTime = avgOutletsPerBeat * 8; // 8 minutes average travel between outlets
    const estimatedVisitTime = avgOutletsPerBeat * config.customerVisitTimeMinutes;
    const estimatedWorkingTime = estimatedTravelTime + estimatedVisitTime;
    
    // Enhanced feasibility check
    const feasible = totalBeats <= totalCustomers && 
                    avgOutletsPerBeat <= config.maxOutletsPerBeat * 1.2 && // Allow 20% flexibility
                    estimatedWorkingTime <= config.maxWorkingTimeMinutes * 1.1; // Allow 10% flexibility
    
    return {
      totalBeats,
      avgOutletsPerBeat,
      avgOutletsPerCluster,
      estimatedWorkingTime,
      feasible
    };
  };

  const validateConfiguration = (currentConfig: ClusteringConfig): Record<string, string> => {
    const newErrors: Record<string, string> = {};

    if (currentConfig.totalClusters < 1 || currentConfig.totalClusters > 20) {
      newErrors.totalClusters = 'Number of clusters must be between 1 and 20';
    }

    if (currentConfig.beatsPerCluster < 1 || currentConfig.beatsPerCluster > 20) {
      newErrors.beatsPerCluster = 'Beats per cluster must be between 1 and 20';
    }

    if (currentConfig.minOutletsPerBeat >= currentConfig.maxOutletsPerBeat) {
      newErrors.minOutletsPerBeat = 'Minimum outlets must be less than maximum outlets';
    }

    if (currentConfig.minOutletsPerBeat < 1) {
      newErrors.minOutletsPerBeat = 'Minimum outlets per beat must be at least 1';
    }

    if (currentConfig.maxOutletsPerBeat > 100) {
      newErrors.maxOutletsPerBeat = 'Maximum outlets per beat cannot exceed 100';
    }

    if (currentConfig.maxWorkingTimeMinutes < 60 || currentConfig.maxWorkingTimeMinutes > 720) {
      newErrors.maxWorkingTimeMinutes = 'Working time must be between 1 and 12 hours';
    }

    if (currentConfig.customerVisitTimeMinutes < 1 || currentConfig.customerVisitTimeMinutes > 60) {
      newErrors.customerVisitTimeMinutes = 'Visit time must be between 1 and 60 minutes';
    }

    if (currentConfig.travelSpeedKmh < 5 || currentConfig.travelSpeedKmh > 100) {
      newErrors.travelSpeedKmh = 'Travel speed must be between 5 and 100 km/h';
    }

    // Enhanced constraint validations
    if (currentConfig.dbscanEps < 0.1 || currentConfig.dbscanEps > 2.0) {
      newErrors.dbscanEps = 'DBSCAN eps must be between 0.1 and 2.0 km';
    }

    if (currentConfig.dbscanMinSamples < 2 || currentConfig.dbscanMinSamples > 10) {
      newErrors.dbscanMinSamples = 'DBSCAN min samples must be between 2 and 10';
    }

    if (currentConfig.maxConvexHullArea < 1 || currentConfig.maxConvexHullArea > 10) {
      newErrors.maxConvexHullArea = 'Max convex hull area must be between 1 and 10 km²';
    }

    if (currentConfig.maxConvexHullAreaSmall < 0.5 || currentConfig.maxConvexHullAreaSmall > 5) {
      newErrors.maxConvexHullAreaSmall = 'Max small beat area must be between 0.5 and 5 km²';
    }

    if (currentConfig.percentileModeThreshold < 50 || currentConfig.percentileModeThreshold > 100) {
      newErrors.percentileModeThreshold = 'Percentile threshold must be between 50 and 100%';
    }

    const totalBeats = currentConfig.totalClusters * currentConfig.beatsPerCluster;
    if (totalBeats > totalCustomers) {
      newErrors.totalClusters = `Total beats (${totalBeats}) cannot exceed total customers (${totalCustomers})`;
    }

    return newErrors;
  };

  // Use useEffect to validate configuration when config changes
  useEffect(() => {
    const newErrors = validateConfiguration(config);
    setErrors(newErrors);
  }, [config, totalCustomers]);

  const handleSubmit = () => {
    if (Object.keys(errors).length === 0) {
      onConfigurationSet(config);
    }
  };

  const updateConfig = (field: keyof ClusteringConfig, value: number | boolean) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const isFormValid = Object.keys(errors).length === 0;
  const metrics = calculateMetrics();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="bg-blue-100 p-2 rounded-lg">
              <Settings className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-gray-800">🚀 Enhanced Route Configuration</h2>
              <p className="text-gray-600">Configure advanced constraints for {totalCustomers.toLocaleString()} customers</p>
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

          {/* Enhanced Constraints */}
          <div className="bg-purple-50 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Shield className="w-5 h-5 text-purple-600" />
              🚀 Enhanced Proximity Constraints
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  📦 DBSCAN Eps (km)
                </label>
                <input
                  type="number"
                  min="0.1"
                  max="2.0"
                  step="0.1"
                  value={config.dbscanEps}
                  onChange={(e) => updateConfig('dbscanEps', parseFloat(e.target.value) || 0.3)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.dbscanEps ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                <p className="text-xs text-gray-500 mt-1">Max distance for natural clustering</p>
                {errors.dbscanEps && (
                  <p className="text-red-500 text-sm mt-1">{errors.dbscanEps}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  📦 DBSCAN Min Samples
                </label>
                <input
                  type="number"
                  min="2"
                  max="10"
                  value={config.dbscanMinSamples}
                  onChange={(e) => updateConfig('dbscanMinSamples', parseInt(e.target.value) || 4)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.dbscanMinSamples ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                <p className="text-xs text-gray-500 mt-1">Min points to form cluster</p>
                {errors.dbscanMinSamples && (
                  <p className="text-red-500 text-sm mt-1">{errors.dbscanMinSamples}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  📉 Percentile Mode (%)
                </label>
                <input
                  type="number"
                  min="50"
                  max="100"
                  value={config.percentileModeThreshold}
                  onChange={(e) => updateConfig('percentileModeThreshold', parseInt(e.target.value) || 90)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.percentileModeThreshold ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                <p className="text-xs text-gray-500 mt-1">% of pairs within mode distance</p>
                {errors.percentileModeThreshold && (
                  <p className="text-red-500 text-sm mt-1">{errors.percentileModeThreshold}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  🧮 Max Convex Hull Area (km²)
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="0.5"
                  value={config.maxConvexHullArea}
                  onChange={(e) => updateConfig('maxConvexHullArea', parseFloat(e.target.value) || 3.0)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.maxConvexHullArea ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                <p className="text-xs text-gray-500 mt-1">For beats ≥35 outlets</p>
                {errors.maxConvexHullArea && (
                  <p className="text-red-500 text-sm mt-1">{errors.maxConvexHullArea}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  🧮 Max Small Beat Area (km²)
                </label>
                <input
                  type="number"
                  min="0.5"
                  max="5"
                  step="0.5"
                  value={config.maxConvexHullAreaSmall}
                  onChange={(e) => updateConfig('maxConvexHullAreaSmall', parseFloat(e.target.value) || 2.5)}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.maxConvexHullAreaSmall ? 'border-red-300' : 'border-gray-300'
                  }`}
                />
                <p className="text-xs text-gray-500 mt-1">For beats &lt;35 outlets</p>
                {errors.maxConvexHullAreaSmall && (
                  <p className="text-red-500 text-sm mt-1">{errors.maxConvexHullAreaSmall}</p>
                )}
              </div>
            </div>
          </div>

          {/* Time & Speed Constraints */}
          <div className="bg-orange-50 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Clock className="w-5 h-5 text-orange-600" />
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
                  ⚠️ Configuration may require adjustments during optimization, but the enhanced algorithm will handle this automatically.
                </p>
              </div>
            )}

            {Object.keys(errors).length > 0 && (
              <div className="mt-4 p-3 bg-red-100 border border-red-300 rounded-lg">
                <p className="text-red-800 text-sm">Please fix the validation errors above before proceeding.</p>
              </div>
            )}

            <div className="mt-4 p-3 bg-blue-100 border border-blue-300 rounded-lg">
              <p className="text-blue-800 text-sm">
                🚀 <strong>Enhanced Features:</strong> DBSCAN pre-clustering, convex hull area limits, percentile-based mode constraints, and inter-cluster transition penalties for optimal beat formation.
              </p>
            </div>
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
            disabled={!isFormValid}
            className={`px-6 py-2 rounded-lg transition-colors ${
              isFormValid
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            🚀 Apply Enhanced Configuration
          </button>
        </div>
      </div>
    </div>
  );
};

export default ClusteringConfiguration;