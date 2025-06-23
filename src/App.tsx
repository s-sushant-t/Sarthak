import React, { useState, useCallback, useEffect } from 'react';
import { ChevronRight, Upload, Map, BarChart2, Download, MenuIcon } from 'lucide-react';
import FileUpload from './components/FileUpload';
import MapView from './components/MapView';
import AlgorithmSelector from './components/AlgorithmSelector';
import ResultsView from './components/ResultsView';
import Login from './components/Login';
import BeatHygieneCorrection from './components/BeatHygieneCorrection';
import ClusteringConfiguration, { ClusteringConfig } from './components/ClusteringConfiguration';
import { processExcelFile } from './utils/excelParser';
import { RouteData, LocationData, AlgorithmType, AlgorithmResult } from './types';
import { executeAlgorithm } from './algorithms';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isDistributor, setIsDistributor] = useState(false);
  const [rawLocationData, setRawLocationData] = useState<LocationData | null>(null);
  const [clusteringConfig, setClusteringConfig] = useState<ClusteringConfig | null>(null);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [locationData, setLocationData] = useState<LocationData | null>(() => {
    const stored = localStorage.getItem('locationData');
    return stored ? JSON.parse(stored) : null;
  });

  const [algorithmResults, setAlgorithmResults] = useState<Record<AlgorithmType, AlgorithmResult | null>>(() => {
    const stored = localStorage.getItem('algorithmResults');
    return stored ? JSON.parse(stored) : {
      'nearest-neighbor': null,
      'simulated-annealing': null,
      'custom': null
    };
  });

  const [selectedAlgorithm, setSelectedAlgorithm] = useState<AlgorithmType | null>(() => {
    return (localStorage.getItem('selectedAlgorithm') as AlgorithmType | null) || null;
  });

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<'upload' | 'map' | 'results'>(() => {
    return (localStorage.getItem('activeTab') as 'upload' | 'map' | 'results') || 'upload';
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = useCallback((loginId: string, password: string) => {
    if (loginId === 'EDIS' && password === 'EDIS_2024-25') {
      setIsAuthenticated(true);
      setIsDistributor(false);
      localStorage.setItem('isAuthenticated', 'true');
      localStorage.setItem('userType', 'admin');
    } else {
      throw new Error('Invalid credentials');
    }
  }, []);

  const handleLogout = useCallback(() => {
    setIsAuthenticated(false);
    setIsDistributor(false);
    setRawLocationData(null);
    setClusteringConfig(null);
    setLocationData(null);
    setAlgorithmResults({
      'nearest-neighbor': null,
      'simulated-annealing': null,
      'custom': null
    });
    setSelectedAlgorithm(null);
    setActiveTab('upload');
    localStorage.clear();
  }, []);

  useEffect(() => {
    const isAuth = localStorage.getItem('isAuthenticated') === 'true';
    const userType = localStorage.getItem('userType');
    if (isAuth) {
      setIsAuthenticated(true);
      setIsDistributor(userType === 'distributor');
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  const handleFileUpload = async (file: File) => {
    setIsLoading(true);
    setError(null);
    
    try {
      // First, process the file without clustering to get raw data
      const rawData = await processExcelFile(file);
      
      if (!rawData || !rawData.customers || rawData.customers.length === 0) {
        throw new Error('No valid customer data found in the file');
      }
      
      setRawLocationData(rawData);
      setShowConfigModal(true);
      
    } catch (error) {
      console.error("Error processing file:", error);
      setError(error instanceof Error ? error.message : 'Unknown error processing file');
      setRawLocationData(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfigurationSet = async (config: ClusteringConfig) => {
    if (!rawLocationData) return;
    
    setIsLoading(true);
    setError(null);
    setShowConfigModal(false);
    setClusteringConfig(config);
    
    try {
      // Apply clustering to the raw data
      const { clusterCustomers } = await import('./utils/clustering');
      const clusteredCustomers = await clusterCustomers(rawLocationData.customers.map(c => ({
        id: c.id,
        latitude: c.latitude,
        longitude: c.longitude,
        outletName: c.outletName
      })), config);
      
      const finalData = {
        distributor: rawLocationData.distributor,
        customers: clusteredCustomers
      };
      
      setLocationData(finalData);
      localStorage.setItem('locationData', JSON.stringify(finalData));
      localStorage.setItem('clusteringConfig', JSON.stringify(config));
      
      const algorithms: AlgorithmType[] = ['nearest-neighbor', 'simulated-annealing'];
      
      for (const algorithm of algorithms) {
        try {
          const result = await executeAlgorithm(algorithm, finalData, config);
          setAlgorithmResults(prev => {
            const updated = { ...prev, [algorithm]: result };
            localStorage.setItem('algorithmResults', JSON.stringify(updated));
            return updated;
          });
        } catch (algorithmError) {
          console.error(`Error processing ${algorithm}:`, algorithmError);
          setError(`Error processing ${algorithm}: ${algorithmError instanceof Error ? algorithmError.message : 'Unknown error'}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      
      setSelectedAlgorithm('nearest-neighbor');
      localStorage.setItem('selectedAlgorithm', 'nearest-neighbor');
      setActiveTab('map');
      
    } catch (error) {
      console.error("Error processing configuration:", error);
      setError(error instanceof Error ? error.message : 'Unknown error processing configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfigurationCancel = () => {
    setShowConfigModal(false);
    setRawLocationData(null);
  };

  const handleRouteUpdate = useCallback((updatedRoutes: RouteData) => {
    if (!selectedAlgorithm || !algorithmResults[selectedAlgorithm]) return;
    
    const totalDistance = updatedRoutes.reduce((total, route) => total + route.totalDistance, 0);
    
    const customResult: AlgorithmResult = {
      name: 'Custom Route',
      totalDistance,
      totalSalesmen: updatedRoutes.length,
      processingTime: 0,
      routes: updatedRoutes,
      isCustom: true
    };

    setAlgorithmResults(prev => {
      const updated = { ...prev, custom: customResult };
      localStorage.setItem('algorithmResults', JSON.stringify(updated));
      return updated;
    });

    setSelectedAlgorithm('custom');
    localStorage.setItem('selectedAlgorithm', 'custom');
  }, [selectedAlgorithm, algorithmResults]);

  const handleSelectAlgorithm = useCallback((algorithm: AlgorithmType) => {
    setSelectedAlgorithm(algorithm);
    localStorage.setItem('selectedAlgorithm', algorithm);
  }, []);

  const handleExportCSV = useCallback(() => {
    if (!selectedAlgorithm || !algorithmResults[selectedAlgorithm]) return;
  }, [selectedAlgorithm, algorithmResults]);

  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} />;
  }

  if (isDistributor) {
    return <BeatHygieneCorrection />;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex justify-between items-center shadow-sm">
        <div className="flex items-center">
          <button 
            className="mr-3 text-gray-500 md:hidden" 
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <MenuIcon size={20} />
          </button>
          <h1 className="text-xl font-semibold text-gray-800">Sales Route Optimizer</h1>
        </div>
        <div className="flex items-center space-x-4">
          <button
            onClick={handleLogout}
            className="text-gray-600 hover:text-gray-800 text-sm"
          >
            Logout
          </button>
          {locationData && selectedAlgorithm && (
            <button 
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-green-500 text-white text-sm hover:bg-green-600 transition-colors"
              onClick={handleExportCSV}
            >
              <Download size={16} />
              <span>Export CSV</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-grow flex-col md:flex-row">
        <aside className={`bg-white border-r border-gray-200 w-full md:w-80 ${sidebarOpen ? 'block' : 'hidden'} md:block`}>
          <div className="p-4">
            <div className="space-y-4">
              <div className="space-y-2">
                <div 
                  className={`flex items-center p-3 rounded-lg cursor-pointer ${activeTab === 'upload' ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}
                  onClick={() => setActiveTab('upload')}
                >
                  <Upload size={18} className="mr-3" />
                  <div className="flex-grow">Upload Data</div>
                  {locationData && <div className="text-green-500">✓</div>}
                  {!locationData && <ChevronRight size={16} />}
                </div>
                
                <div 
                  className={`flex items-center p-3 rounded-lg cursor-pointer ${activeTab === 'map' ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'} ${!locationData ? 'opacity-50 pointer-events-none' : ''}`}
                  onClick={() => locationData && setActiveTab('map')}
                >
                  <Map size={18} className="mr-3" />
                  <div className="flex-grow">View Routes</div>
                  <ChevronRight size={16} />
                </div>
                
                <div 
                  className={`flex items-center p-3 rounded-lg cursor-pointer ${activeTab === 'results' ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'} ${!selectedAlgorithm ? 'opacity-50 pointer-events-none' : ''}`}
                  onClick={() => selectedAlgorithm && setActiveTab('results')}
                >
                  <BarChart2 size={18} className="mr-3" />
                  <div className="flex-grow">Compare Results</div>
                  <ChevronRight size={16} />
                </div>
              </div>
              
              <hr className="my-4" />
              
              {locationData && (
                <AlgorithmSelector 
                  results={algorithmResults}
                  selectedAlgorithm={selectedAlgorithm} 
                  onSelect={handleSelectAlgorithm}
                />
              )}
            </div>
          </div>
        </aside>

        <main className="flex-grow p-4">
          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          )}
          
          {isLoading && (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
              <span className="ml-3 text-gray-600">Processing data...</span>
            </div>
          )}
          
          {!isLoading && activeTab === 'upload' && (
            <div className="max-w-xl mx-auto mt-10">
              <FileUpload onFileUpload={handleFileUpload} />
            </div>
          )}
          
          {!isLoading && activeTab === 'map' && locationData && selectedAlgorithm && algorithmResults[selectedAlgorithm] && (
            <MapView 
              locationData={locationData}
              routes={algorithmResults[selectedAlgorithm]?.routes || []}
              onRouteUpdate={handleRouteUpdate}
            />
          )}
          
          {!isLoading && activeTab === 'results' && locationData && selectedAlgorithm && (
            <ResultsView
              results={algorithmResults}
              selectedAlgorithm={selectedAlgorithm}
              onSelectAlgorithm={handleSelectAlgorithm}
              onExportCSV={handleExportCSV}
              showAssignDistributor={true}
              onAssignDistributor={(code) => {
                sessionStorage.setItem('distributorCode', code);
              }}
            />
          )}
        </main>
      </div>

      {showConfigModal && rawLocationData && (
        <ClusteringConfiguration
          totalCustomers={rawLocationData.customers.length}
          onConfigurationSet={handleConfigurationSet}
          onCancel={handleConfigurationCancel}
        />
      )}
    </div>
  );
}

export default App;