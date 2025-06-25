/*
  # Fix Authentication and RLS Policies

  1. Policies
    - Add missing INSERT policy for distributor_table_mapping
    - Add missing SELECT policy for distributor_table_mapping
  
  2. RPC Functions
    - Drop and recreate register_distributor_table function
    - Create get_distributor_table_name function
    - Create execute_sql function for dynamic table creation
  
  3. Security
    - All functions use SECURITY DEFINER for proper permissions
    - RLS policies check for EDIS email authentication
*/

-- Add missing INSERT policy for distributor_table_mapping
CREATE POLICY "Allow EDIS to insert table mappings" 
ON distributor_table_mapping 
FOR INSERT 
TO authenticated 
WITH CHECK ((auth.jwt()->>'email' = 'EDIS'));

-- Add missing SELECT policy for distributor_table_mapping if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'distributor_table_mapping' 
    AND policyname = 'Allow EDIS to read table mappings'
  ) THEN
    CREATE POLICY "Allow EDIS to read table mappings" 
    ON distributor_table_mapping 
    FOR SELECT 
    TO authenticated 
    USING ((auth.jwt()->>'email' = 'EDIS'));
  END IF;
END $$;

-- Drop existing function if it exists to avoid return type conflicts
DROP FUNCTION IF EXISTS register_distributor_table(text, text);

-- Create RPC function to register distributor table mapping
CREATE OR REPLACE FUNCTION register_distributor_table(dist_code text, tbl_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO distributor_table_mapping (distributor_code, table_name)
  VALUES (dist_code, tbl_name)
  ON CONFLICT (distributor_code) 
  DO UPDATE SET table_name = EXCLUDED.table_name;
END;
$$;

-- Drop existing function if it exists to avoid conflicts
DROP FUNCTION IF EXISTS get_distributor_table_name(text);

-- Create RPC function to get distributor table name
CREATE OR REPLACE FUNCTION get_distributor_table_name(dist_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  table_name text;
BEGIN
  SELECT dtm.table_name INTO table_name
  FROM distributor_table_mapping dtm
  WHERE dtm.distributor_code = dist_code;
  
  RETURN COALESCE(table_name, 'distributor_routes');
END;
$$;

-- Drop existing function if it exists to avoid conflicts
DROP FUNCTION IF EXISTS execute_sql(text);

-- Create RPC function to execute SQL (for creating distributor tables)
CREATE OR REPLACE FUNCTION execute_sql(sql_query text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Only allow EDIS to execute SQL
  IF (auth.jwt()->>'email' != 'EDIS') THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  EXECUTE sql_query;
END;
$$;

-- Grant execute permissions on RPC functions
GRANT EXECUTE ON FUNCTION register_distributor_table(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_distributor_table_name(text) TO authenticated;
GRANT EXECUTE ON FUNCTION execute_sql(text) TO authenticated;