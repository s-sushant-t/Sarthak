/*
  # Remove all RLS policies

  This migration removes all Row Level Security (RLS) policies from the database tables
  to resolve authentication issues with the EDIS admin user and distributor access.

  1. Security Changes
    - Disable RLS on distributor_routes table
    - Disable RLS on distributor_table_mapping table
    - Drop all existing RLS policies
    - Remove authentication requirements for data access

  2. Access Control
    - All authenticated users can now access all data
    - No row-level restrictions based on user identity
    - Simplified access model for the application
*/

-- Disable RLS on distributor_routes table
ALTER TABLE distributor_routes DISABLE ROW LEVEL SECURITY;

-- Disable RLS on distributor_table_mapping table
ALTER TABLE distributor_table_mapping DISABLE ROW LEVEL SECURITY;

-- Drop all existing policies on distributor_routes
DROP POLICY IF EXISTS "Admins can update routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can read their own routes" ON distributor_routes;
DROP POLICY IF EXISTS "Allow distributors to read their routes" ON distributor_routes;
DROP POLICY IF EXISTS "Allow distributors to update their routes" ON distributor_routes;

-- Drop all existing policies on distributor_table_mapping
DROP POLICY IF EXISTS "Admins can manage mappings" ON distributor_table_mapping;
DROP POLICY IF EXISTS "Allow EDIS to insert table mappings" ON distributor_table_mapping;
DROP POLICY IF EXISTS "Allow EDIS to read table mappings" ON distributor_table_mapping;
DROP POLICY IF EXISTS "Users can read their own mapping" ON distributor_table_mapping;

-- Update the execute_sql function to remove authentication check
CREATE OR REPLACE FUNCTION execute_sql(sql_query text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Allow all authenticated users to execute SQL
  EXECUTE sql_query;
END;
$$;

-- Update the register_distributor_table function to remove authentication check
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

-- Grant full access to authenticated users on both tables
GRANT ALL ON distributor_routes TO authenticated;
GRANT ALL ON distributor_table_mapping TO authenticated;

-- Grant usage on sequences
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Ensure the functions can be executed by authenticated users
GRANT EXECUTE ON FUNCTION execute_sql(text) TO authenticated;
GRANT EXECUTE ON FUNCTION register_distributor_table(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_distributor_table_name(text) TO authenticated;