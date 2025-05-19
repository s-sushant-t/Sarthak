import React, { useRef, useState } from 'react';
import { Upload, File } from 'lucide-react';

interface FileUploadProps {
  onFileUpload: (file: File) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileUpload }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFileSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const file = files[0];
    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    
    if (fileExtension !== 'xlsx' && fileExtension !== 'xls') {
      alert('Please upload an Excel file (.xlsx or .xls)');
      return;
    }
    
    setFileName(file.name);
    setIsProcessing(true);
    
    try {
      await onFileUpload(file);
    } catch (error) {
      console.error('Error processing file:', error);
      alert(error instanceof Error ? error.message : 'Error processing file');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelected(e.dataTransfer.files);
  };

  const triggerFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  return (
    <div className="w-full">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-gray-800 mb-2">Upload Customer Data</h2>
        <p className="text-gray-600">
          Upload an Excel file containing customer and distributor location data to generate optimized sales routes.
        </p>
      </div>
      
      <div 
        className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors
          ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={triggerFileInput}
      >
        <input 
          type="file" 
          ref={fileInputRef}
          className="hidden" 
          accept=".xlsx,.xls"
          onChange={(e) => handleFileSelected(e.target.files)}
        />
        
        <div className="flex flex-col items-center justify-center space-y-4">
          <div className="bg-blue-100 p-3 rounded-full">
            <Upload size={24} className="text-blue-600" />
          </div>
          
          {isProcessing ? (
            <div className="flex flex-col items-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-2"></div>
              <p className="text-blue-600">Processing file...</p>
            </div>
          ) : fileName ? (
            <>
              <div className="flex items-center">
                <File size={16} className="mr-2 text-blue-600" />
                <span className="text-blue-700 font-medium">{fileName}</span>
              </div>
              <p className="text-sm text-gray-500">File selected. Click to change.</p>
            </>
          ) : (
            <>
              <p className="text-gray-700 font-medium">Drag and drop your Excel file here</p>
              <p className="text-sm text-gray-500">Or click to browse files</p>
              <p className="text-xs text-gray-400 mt-2">Supported formats: .xlsx, .xls</p>
            </>
          )}
        </div>
      </div>
      
      <div className="mt-6">
        <h3 className="font-medium text-gray-800 mb-2">Required Format</h3>
        <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
          <p className="text-sm text-gray-600 mb-2">Your Excel file should include these columns:</p>
          <ul className="text-sm space-y-1 text-gray-700">
            <li>• <span className="font-medium">WD_Latitude, WD_Longitude</span> - Distributor coordinates</li>
            <li>• <span className="font-medium">DMS Customer ID</span> - Unique customer identifier</li>
            <li>• <span className="font-medium">OL_Latitude, OL_Longitude</span> - Customer coordinates</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default FileUpload;