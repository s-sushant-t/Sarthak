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
          'Outlet_Name',
          'GR1_Sale',
          'GR2_Sale'
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
            '- Outlet_Name (Customer outlet name)\n' +
            '- GR1_Sale (GR1 sales amount)\n' +
            '- GR2_Sale (GR2 sales amount)'
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
        const processedCustomerIds = new Set<string>();
        
        console.log(`Processing ${dataRows.length} data rows from Excel file...`);
        
        for (const row of dataRows) {
          if (!Array.isArray(row)) continue;
          
          const lat = parseFloat(row[headerMap.get('OL_Latitude')] || '');
          const lng = parseFloat(row[headerMap.get('OL_Longitude')] || '');
          const id = row[headerMap.get('DMS Customer ID')]?.toString()?.trim();
          const outletName = row[headerMap.get('Outlet_Name')]?.toString()?.trim() || '';
          const gr1Sale = parseFloat(row[headerMap.get('GR1_Sale')] || '0');
          const gr2Sale = parseFloat(row[headerMap.get('GR2_Sale')] || '0');
          
          // Validate data quality
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0 && id && !processedCustomerIds.has(id)) {
            customers.push({
              id,
              latitude: lat,
              longitude: lng,
              outletName,
              gr1Sale: isNaN(gr1Sale) ? 0 : gr1Sale,
              gr2Sale: isNaN(gr2Sale) ? 0 : gr2Sale
            });
            processedCustomerIds.add(id);
          } else if (id && processedCustomerIds.has(id)) {
            console.warn(`Duplicate customer ID found: ${id} - skipping duplicate entry`);
          }
        }
        
        console.log(`Extracted ${customers.length} unique valid customers from Excel file`);
        
        if (customers.length === 0) {
          throw new Error(
            'No valid customer data found. Please ensure:\n' +
            '- OL_Latitude and OL_Longitude contain valid numbers\n' +
            '- Coordinates are not zero (0)\n' +
            '- Each customer has a valid DMS Customer ID\n' +
            '- No duplicate customer IDs exist\n' +
            '- GR1_Sale and GR2_Sale columns contain numeric values'
          );
        }
        
        // Log sales data summary
        const totalGR1 = customers.reduce((sum, c) => sum + (c.gr1Sale || 0), 0);
        const totalGR2 = customers.reduce((sum, c) => sum + (c.gr2Sale || 0), 0);
        console.log(`Sales summary - Total GR1: ${totalGR1.toLocaleString()}, Total GR2: ${totalGR2.toLocaleString()}`);
        
        console.log('Starting clustering process with sales constraints...');
        const clusteredCustomers = await clusterCustomers(customers);
        
        console.log(`Clustering complete: ${clusteredCustomers.length} customers clustered`);
        
        resolve({ 
          distributor, 
          customers: clusteredCustomers 
        });
        
      } catch (error) {
        console.error('Excel processing error:', error);
        reject(error instanceof Error ? error : new Error('Unknown error processing Excel file'));
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Error reading the file'));
    };
    
    reader.readAsArrayBuffer(file);
  });
};