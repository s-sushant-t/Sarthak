import React, { useState, useCallback } from 'react';
import { ChevronRight, Upload, Map, BarChart2, Download, MenuIcon } from 'lucide-react';
import FileUpload from './components/FileUpload';
import MapView from './components/MapView';
import AlgorithmSelector from './components/AlgorithmSelector';
import ResultsView from './components/ResultsView';
import Login from './components/Login';
import { processExcelFile } from './utils/excelParser';
import { RouteData, LocationData, AlgorithmType, AlgorithmResult } from './types';
import { executeAlgorithm } from './algorithms';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<'upload' | 'map' | 'results'>('upload');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locationData, setLocationData] = useState<LocationData | null>(null);
  const [algorithmResults, setAlgorithmResults] = useState<Record<AlgorithmType, AlgorithmResult | null>>({
    'nearest-neighbor': null,
    'simulated-annealing': null,
    'custom': null
  });
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<AlgorithmType | null>(null);

  const handleLogin = useCallback(() => {
    setIsAuthenticated(true);
    sessionStorage.setItem('isAuthenticated', 'true');
  }, []);

  const handleFileUpload = async (file: File) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const data = await processExcelFile(file);
      
      if (data.customers.length > 1000) {
        throw new Error('Dataset too large. Maximum 1000 customers supported.');
      }
      
      setLocationData(data);
      sessionStorage.setItem('locationData', JSON.stringify(data));
      setActiveTab('map');
      
      const algorithms: AlgorithmType[] = ['nearest-neighbor', 'simulated-annealing'];
      const results: Record<AlgorithmType, AlgorithmResult> = {} as Record<AlgorithmType, AlgorithmResult>;
      
      for (const algorithm of algorithms) {
        try {
          results[algorithm] = await executeAlgorithm(algorithm, data);
          
          setAlgorithmResults(prev => {
            const updated = { ...prev, [algorithm]: results[algorithm] };
            sessionStorage.setItem('algorithmResults', JSON.stringify(updated));
            return updated;
          });
          
        } catch (algorithmError) {
          console.error(`Error processing ${algorithm}:`, algorithmError);
          results[algorithm] = null;
        }
        
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      
      setSelectedAlgorithm('nearest-neighbor');
      sessionStorage.setItem('selectedAlgorithm', 'nearest-neighbor');
      
    } catch (error) {
      console.error("Error processing file:", error);
      setError(error instanceof Error ? error.message : 'Unknown error processing file');
      
      setLocationData(null);
      setAlgorithmResults({
        'nearest-neighbor': null,
        'simulated-annealing': null,
        'custom': null
      });
      sessionStorage.removeItem('locationData');
      sessionStorage.removeItem('algorithmResults');
      sessionStorage.removeItem('selectedAlgorithm');
      
    } finally {
      setIsLoading(false);
    }
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
      sessionStorage.setItem('algorithmResults', JSON.stringify(updated));
      return updated;
    });

    setSelectedAlgorithm('custom');
    sessionStorage.setItem('selectedAlgorithm', 'custom');
  }, [selectedAlgorithm, algorithmResults]);

  const handleSelectAlgorithm = useCallback((algorithm: AlgorithmType) => {
    setSelectedAlgorithm(algorithm);
    sessionStorage.setItem('selectedAlgorithm', algorithm);
  }, []);

  const handleExportCSV = useCallback(() => {
    if (!selectedAlgorithm || !algorithmResults[selectedAlgorithm]) return;
    
    const csvData = algorithmResults[selectedAlgorithm]?.routes || [];
  }, [selectedAlgorithm, algorithmResults]);

  React.useEffect(() => {
    const storedAuth = sessionStorage.getItem('isAuthenticated');
    if (storedAuth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} />;
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
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;