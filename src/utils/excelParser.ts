import { read, utils } from 'xlsx';
import { LocationData, Customer } from '../types';
import { clusterCustomers } from './clustering';

export const processExcelFile = async (file: File): Promise<LocationData> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        if (!e.target?.result) {
          throw new Error('Failed to read file content');
        }
        
        const data = new Uint8Array(e.target.result as ArrayBuffer);
        const workbook = read(data, { type: 'array' });
        
        if (workbook.SheetNames.length === 0) {
          throw new Error('Excel file contains no sheets');
        }
        
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = utils.sheet_to_json(worksheet, { 
          raw: false,
          defval: '',
          header: 1
        });
        
        if (jsonData.length <= 1) {
          throw new Error('Excel file is empty or contains only headers');
        }
        
        const headers = jsonData[0] as string[];
        const requiredColumns = [
          'WD_Latitude', 'WD_Longitude', 
          'OL_Latitude', 'OL_Longitude', 
          'DMS Customer ID',
          'Outlet_Name'
        ];
        
        const headerMap = new Map(headers.map((header, index) => [header?.trim() || '', index]));
        
        const missingColumns = requiredColumns.filter(col => !headerMap.has(col));
        if (missingColumns.length > 0) {
          throw new Error(
            `Missing required columns: ${missingColumns.join(', ')}. \n` +
            'Please ensure your Excel file contains all required columns: \n' +
            '- WD_Latitude (Distributor latitude)\n' +
            '- WD_Longitude (Distributor longitude)\n' +
            '- OL_Latitude (Customer latitude)\n' +
            '- OL_Longitude (Customer longitude)\n' +
            '- DMS Customer ID (Customer identifier)\n' +
            '- Outlet_Name (Customer outlet name)'
          );
        }
        
        const dataRows = jsonData.slice(1) as any[];
        let distributorFound = false;
        let distributor = { latitude: 0, longitude: 0 };
        
        for (const row of dataRows) {
          if (!Array.isArray(row)) continue;
          
          const wdLat = parseFloat(row[headerMap.get('WD_Latitude')] || '');
          const wdLng = parseFloat(row[headerMap.get('WD_Longitude')] || '');
          
          if (!isNaN(wdLat) && !isNaN(wdLng) && wdLat !== 0 && wdLng !== 0) {
            distributor = { latitude: wdLat, longitude: wdLng };
            distributorFound = true;
            break;
          }
        }
        
        if (!distributorFound) {
          throw new Error(
            'No valid distributor coordinates found. Please ensure:\n' +
            '- The Excel file contains WD_Latitude and WD_Longitude columns\n' +
            '- At least one row has valid non-zero coordinates'
          );
        }
        
        const customers: Customer[] = [];
        
        for (const row of dataRows) {
          if (!Array.isArray(row)) continue;
          
          const lat = parseFloat(row[headerMap.get('OL_Latitude')] || '');
          const lng = parseFloat(row[headerMap.get('OL_Longitude')] || '');
          const id = row[headerMap.get('DMS Customer ID')]?.toString();
          const outletName = row[headerMap.get('Outlet_Name')]?.toString() || '';
          
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0 && id) {
            customers.push({
              id,
              latitude: lat,
              longitude: lng,
              outletName
            });
          }
        }
        
        if (customers.length === 0) {
          throw new Error(
            'No valid customer data found. Please ensure:\n' +
            '- OL_Latitude and OL_Longitude contain valid numbers\n' +
            '- Coordinates are not zero (0)\n' +
            '- Each customer has a valid DMS Customer ID'
          );
        }
        
        const clusteredCustomers = await clusterCustomers(customers);
        
        resolve({ distributor, customers: clusteredCustomers });
        
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Unknown error processing Excel file'));
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Error reading the file'));
    };
    
    reader.readAsArrayBuffer(file);
  });
};