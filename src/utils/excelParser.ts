import { read, utils } from 'xlsx';
import { LocationData, Customer } from '../types';
import { clusterCustomers } from './clustering';

export const processExcelFile = async (file: File): Promise<LocationData> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = read(data, { type: 'array' });
        
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        
        const jsonData = utils.sheet_to_json(worksheet, { 
          raw: false,
          defval: ''
        });
        
        if (jsonData.length === 0) {
          throw new Error('No data found in the Excel file');
        }

        const firstRow = jsonData[0] as any;
        const requiredColumns = ['WD_Latitude', 'WD_Longitude', 'OL_Latitude', 'OL_Longitude', 'DMS Customer ID'];
        const missingColumns = requiredColumns.filter(col => !(col in firstRow));
        
        if (missingColumns.length > 0) {
          throw new Error(
            `Missing required columns: ${missingColumns.join(', ')}. \n` +
            'Please ensure your Excel file contains all required columns: \n' +
            '- WD_Latitude (Distributor latitude)\n' +
            '- WD_Longitude (Distributor longitude)\n' +
            '- OL_Latitude (Customer latitude)\n' +
            '- OL_Longitude (Customer longitude)\n' +
            '- DMS Customer ID (Customer identifier)'
          );
        }
        
        const distributorRow = jsonData.find((row: any) => {
          const lat = parseFloat(row['WD_Latitude'] || '');
          const lng = parseFloat(row['WD_Longitude'] || '');
          return !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0;
        });
        
        if (!distributorRow) {
          const hasInvalidCoords = jsonData.some((row: any) => {
            const lat = row['WD_Latitude'];
            const lng = row['WD_Longitude'];
            return (lat !== '' || lng !== '') && 
                   (isNaN(parseFloat(lat)) || isNaN(parseFloat(lng)) || 
                    parseFloat(lat) === 0 || parseFloat(lng) === 0);
          });

          if (hasInvalidCoords) {
            throw new Error(
              'Invalid distributor coordinates found. Please ensure:\n' +
              '- WD_Latitude and WD_Longitude contain valid numbers\n' +
              '- Coordinates are not zero (0)\n' +
              '- Decimal numbers use a period (.) as decimal separator'
            );
          } else {
            throw new Error(
              'No distributor coordinates found. Please ensure:\n' +
              '- The Excel file contains WD_Latitude and WD_Longitude columns\n' +
              '- At least one row has valid distributor coordinates'
            );
          }
        }
        
        const distributor = {
          latitude: parseFloat(distributorRow['WD_Latitude']),
          longitude: parseFloat(distributorRow['WD_Longitude'])
        };
        
        const customers: Customer[] = [];
        const invalidCustomers: string[] = [];
        
        for (const row of jsonData) {
          const lat = parseFloat(row['OL_Latitude'] || '');
          const lng = parseFloat(row['OL_Longitude'] || '');
          const id = row['DMS Customer ID']?.toString();
          
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0 && id) {
            customers.push({
              id,
              latitude: lat,
              longitude: lng
            });
          } else if (id) {
            invalidCustomers.push(id);
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
        
        if (invalidCustomers.length > 0) {
          console.warn(`Warning: ${invalidCustomers.length} customers had invalid coordinates and were skipped.`);
        }
        
        // Perform DBSCAN clustering on customers
        const clusteredCustomers = clusterCustomers(customers);
        
        console.log(`Processed ${clusteredCustomers.length} valid customers in ${new Set(clusteredCustomers.map(c => c.clusterId)).size} clusters`);
        
        resolve({ distributor, customers: clusteredCustomers });
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