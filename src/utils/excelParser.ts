import { read, utils } from 'xlsx';
import { LocationData, Customer } from '../types';
import { clusterCustomers } from './clustering';

export const processExcelFile = async (file: File): Promise<LocationData> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        console.log('Starting Excel file processing...');
        
        if (!e.target?.result) {
          throw new Error('Failed to read file content');
        }
        
        const data = new Uint8Array(e.target.result as ArrayBuffer);
        const workbook = read(data, { type: 'array' });
        
        console.log('Workbook loaded, sheets:', workbook.SheetNames);
        
        if (workbook.SheetNames.length === 0) {
          throw new Error('Excel file contains no sheets');
        }
        
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        console.log('Processing first sheet:', workbook.SheetNames[0]);
        
        const jsonData = utils.sheet_to_json(worksheet, { 
          raw: false,
          defval: '',
          header: 1
        });
        
        console.log('Converted to JSON, rows:', jsonData.length);
        
        if (jsonData.length <= 1) {
          throw new Error('Excel file is empty or contains only headers');
        }
        
        // Get headers from first row
        const headers = jsonData[0] as string[];
        console.log('Headers found:', headers);
        
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
        
        // Process data rows
        const dataRows = jsonData.slice(1) as any[];
        console.log('Processing', dataRows.length, 'data rows');
        
        let distributorFound = false;
        let distributor = { latitude: 0, longitude: 0 };
        
        for (const row of dataRows) {
          if (!Array.isArray(row)) continue;
          
          const wdLat = parseFloat(row[headerMap.get('WD_Latitude')] || '');
          const wdLng = parseFloat(row[headerMap.get('WD_Longitude')] || '');
          
          if (!isNaN(wdLat) && !isNaN(wdLng) && wdLat !== 0 && wdLng !== 0) {
            distributor = { latitude: wdLat, longitude: wdLng };
            distributorFound = true;
            console.log('Found distributor coordinates:', distributor);
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
        const invalidCustomers: string[] = [];
        
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
            
            if (customers.length % 100 === 0) {
              console.log(`Processed ${customers.length} valid customers...`);
            }
          } else if (id) {
            invalidCustomers.push(id);
          }
        }
        
        console.log('Total valid customers:', customers.length);
        console.log('Invalid customers:', invalidCustomers.length);
        
        if (customers.length === 0) {
          throw new Error(
            'No valid customer data found. Please ensure:\n' +
            '- OL_Latitude and OL_Longitude contain valid numbers\n' +
            '- Coordinates are not zero (0)\n' +
            '- Each customer has a valid DMS Customer ID'
          );
        }
        
        // Perform clustering on customers with proper error handling
        console.log('Starting customer clustering...');
        let clusteredCustomers: Customer[] = [];
        
        try {
          clusteredCustomers = await clusterCustomers(customers);
          
          if (!Array.isArray(clusteredCustomers) || clusteredCustomers.length === 0) {
            console.warn('Clustering produced no results, using fallback');
            clusteredCustomers = customers.map((customer, index) => ({
              ...customer,
              clusterId: 0
            }));
          }
        } catch (error) {
          console.error('Clustering error:', error);
          // Fallback: assign all customers to a single cluster
          clusteredCustomers = customers.map(customer => ({
            ...customer,
            clusterId: 0
          }));
        }
        
        const clusters = new Set(clusteredCustomers.map(c => c.clusterId));
        console.log(`Clustering complete: ${clusteredCustomers.length} customers in ${clusters.size} clusters`);
        
        const result = { distributor, customers: clusteredCustomers };
        console.log('Data processing complete');
        resolve(result);
        
      } catch (error) {
        console.error('Excel processing error:', error);
        reject(error instanceof Error ? error : new Error('Unknown error processing Excel file'));
      }
    };
    
    reader.onerror = (error) => {
      console.error('FileReader error:', error);
      reject(new Error('Error reading the file'));
    };
    
    console.log('Starting file read...');
    reader.readAsArrayBuffer(file);
  });
};