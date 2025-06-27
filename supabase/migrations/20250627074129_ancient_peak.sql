/*
  # Remove all RLS policies from database

  This migration removes Row Level Security (RLS) from all tables and drops all existing policies.
  
  1. Tables affected:
    - distributor_routes
    - distributor_table_mapping
    - distributor_routes_2506
    - distributor_routes_ca2599
    - distributor_routes_1234
    - distributor_routes_ds123
    - Any other distributor-specific tables
  
  2. Changes:
    - Disable RLS on all tables
    - Drop all existing policies
    - Grant full access to authenticated users
    - Remove authentication checks from functions
*/

-- Disable RLS on main tables
ALTER TABLE IF EXISTS distributor_routes DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS distributor_table_mapping DISABLE ROW LEVEL SECURITY;

-- Disable RLS on distributor-specific tables
ALTER TABLE IF EXISTS distributor_routes_2506 DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS distributor_routes_ca2599 DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS distributor_routes_1234 DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS distributor_routes_ds123 DISABLE ROW LEVEL SECURITY;

-- Function to disable RLS on all tables matching pattern
DO $$
DECLARE
    table_record RECORD;
BEGIN
    -- Find all tables that start with 'distributor_routes_'
    FOR table_record IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE 'distributor_routes_%'
    LOOP
        EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', table_record.tablename);
        RAISE NOTICE 'Disabled RLS on table: %', table_record.tablename;
    END LOOP;
END $$;

-- Drop all policies on distributor_routes
DROP POLICY IF EXISTS "Admins can update routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can read their own routes" ON distributor_routes;
DROP POLICY IF EXISTS "Allow distributors to read their routes" ON distributor_routes;
DROP POLICY IF EXISTS "Allow distributors to update their routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can access their routes" ON distributor_routes;

-- Drop all policies on distributor_table_mapping
DROP POLICY IF EXISTS "Admins can manage mappings" ON distributor_table_mapping;
DROP POLICY IF EXISTS "Allow EDIS to insert table mappings" ON distributor_table_mapping;
DROP POLICY IF EXISTS "Allow EDIS to read table mappings" ON distributor_table_mapping;
DROP POLICY IF EXISTS "Users can read their own mapping" ON distributor_table_mapping;

-- Drop policies on distributor-specific tables
DROP POLICY IF EXISTS "Users can access their routes" ON distributor_routes_2506;
DROP POLICY IF EXISTS "Users can access their routes" ON distributor_routes_ca2599;
DROP POLICY IF EXISTS "Users can access their routes" ON distributor_routes_1234;
DROP POLICY IF EXISTS "Users can access their routes" ON distributor_routes_ds123;

-- Function to drop all policies on tables matching pattern
DO $$
DECLARE
    table_record RECORD;
    policy_record RECORD;
BEGIN
    -- Find all tables that start with 'distributor_routes_'
    FOR table_record IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE 'distributor_routes_%'
    LOOP
        -- Drop all policies on this table
        FOR policy_record IN
            SELECT policyname
            FROM pg_policies
            WHERE tablename = table_record.tablename
            AND schemaname = 'public'
        LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_record.policyname, table_record.tablename);
            RAISE NOTICE 'Dropped policy % on table %', policy_record.policyname, table_record.tablename;
        END LOOP;
    END LOOP;
END $$;

-- Update functions to remove authentication checks
CREATE OR REPLACE FUNCTION execute_sql(sql_query text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Execute SQL without authentication check
  EXECUTE sql_query;
END;
$$;

CREATE OR REPLACE FUNCTION register_distributor_table(dist_code text, tbl_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Insert/update without authentication check
  INSERT INTO distributor_table_mapping (distributor_code, table_name)
  VALUES (dist_code, tbl_name)
  ON CONFLICT (distributor_code) 
  DO UPDATE SET table_name = EXCLUDED.table_name;
END;
$$;

CREATE OR REPLACE FUNCTION get_distributor_table_name(dist_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  table_name text;
BEGIN
  -- Get table name without authentication check
  SELECT dtm.table_name INTO table_name
  FROM distributor_table_mapping dtm
  WHERE dtm.distributor_code = dist_code;
  
  RETURN COALESCE(table_name, 'distributor_routes');
END;
$$;

-- Grant full access to all users on main tables
GRANT ALL ON distributor_routes TO public;
GRANT ALL ON distributor_table_mapping TO public;

-- Grant access to distributor-specific tables
GRANT ALL ON distributor_routes_2506 TO public;
GRANT ALL ON distributor_routes_ca2599 TO public;
GRANT ALL ON distributor_routes_1234 TO public;
GRANT ALL ON distributor_routes_ds123 TO public;

-- Function to grant access on all distributor tables
DO $$
DECLARE
    table_record RECORD;
BEGIN
    -- Find all tables that start with 'distributor_routes_'
    FOR table_record IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE 'distributor_routes_%'
    LOOP
        EXECUTE format('GRANT ALL ON %I TO public', table_record.tablename);
        RAISE NOTICE 'Granted full access on table: %', table_record.tablename;
    END LOOP;
END $$;

-- Grant usage on all sequences
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO public;

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION execute_sql(text) TO public;
GRANT EXECUTE ON FUNCTION register_distributor_table(text, text) TO public;
GRANT EXECUTE ON FUNCTION get_distributor_table_name(text) TO public;

-- Create a function to get distinct beats (used by beat count functionality)
CREATE OR REPLACE FUNCTION get_distinct_beats(distributor text)
RETURNS TABLE(beat integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- First try to get the distributor-specific table
  DECLARE
    table_name text;
  BEGIN
    SELECT get_distributor_table_name(distributor) INTO table_name;
    
    -- Return distinct beats from the appropriate table
    RETURN QUERY EXECUTE format('
      SELECT DISTINCT dr.beat::integer 
      FROM %I dr 
      WHERE dr.distributor_code = $1 
      ORDER BY dr.beat::integer
    ', table_name) USING distributor;
  END;
END;
$$;

-- Grant execute permission on the new function
GRANT EXECUTE ON FUNCTION get_distinct_beats(text) TO public;

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'Successfully removed all RLS policies and granted public access to all distributor tables';
END $$;