/*
  # Create distributor-specific table management
  
  1. Changes
    - Create a helper function to check if tables exist
    - Add policies for dynamic table access
    - Enable proper permissions for distributor table creation
  
  2. Security
    - Use invoker rights instead of definer rights
    - Proper RLS policies for distributor isolation
*/

-- Create a simple function to check if a table exists
CREATE OR REPLACE FUNCTION table_exists(table_name text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name = $1
  );
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION table_exists(text) TO authenticated;

-- Create a function to get the current user's distributor code
CREATE OR REPLACE FUNCTION get_current_distributor_code()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.uid()::text, '');
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_current_distributor_code() TO authenticated;

-- Create a view that can dynamically show distributor routes
-- This will be used by the application to query the correct table
CREATE OR REPLACE VIEW current_distributor_routes AS
SELECT 
  id,
  distributor_code,
  beat,
  stop_order,
  dms_customer_id,
  outlet_name,
  latitude,
  longitude,
  distance_to_next,
  time_to_next,
  cluster_id,
  market_work_remark,
  updated_ol_name,
  owner_name,
  owner_contact,
  ol_closure_time,
  visit_time,
  created_at,
  auditor_name,
  auditor_designation,
  is_being_audited
FROM distributor_routes
WHERE distributor_code = get_current_distributor_code()
   OR auth.jwt()->>'email' = 'EDIS';

-- Grant select permission on the view
GRANT SELECT ON current_distributor_routes TO authenticated;

-- Create a function to safely create distributor tables
CREATE OR REPLACE FUNCTION create_distributor_table(dist_code text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  table_name text;
  sql_stmt text;
BEGIN
  -- Sanitize the distributor code to create a safe table name
  table_name := 'distributor_routes_' || regexp_replace(lower(dist_code), '[^a-z0-9_]', '', 'g');
  
  -- Check if table already exists
  IF table_exists(table_name) THEN
    RETURN true;
  END IF;
  
  -- Create the table with the same structure as distributor_routes
  sql_stmt := format('
    CREATE TABLE %I (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      distributor_code text NOT NULL,
      beat integer NOT NULL,
      stop_order integer NOT NULL,
      dms_customer_id text NOT NULL,
      outlet_name text,
      latitude double precision NOT NULL,
      longitude double precision NOT NULL,
      distance_to_next double precision,
      time_to_next integer,
      cluster_id integer,
      market_work_remark text,
      updated_ol_name text,
      owner_name text,
      owner_contact text,
      ol_closure_time text,
      visit_time timestamptz,
      created_at timestamptz DEFAULT now(),
      auditor_name text,
      auditor_designation text,
      is_being_audited boolean DEFAULT false,
      
      CONSTRAINT %I UNIQUE (distributor_code, beat, stop_order)
    )', table_name, table_name || '_unique_constraint');
  
  EXECUTE sql_stmt;
  
  -- Enable RLS on the new table
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  
  -- Create policies for the new table
  EXECUTE format('
    CREATE POLICY "Users can access their routes" ON %I
    FOR ALL
    TO authenticated
    USING (
      (auth.jwt()->>''email'' = ''EDIS'') OR 
      (distributor_code = auth.uid()::text)
    )
    WITH CHECK (
      (auth.jwt()->>''email'' = ''EDIS'') OR 
      (distributor_code = auth.uid()::text)
    )', table_name);
  
  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but don't fail
    RAISE NOTICE 'Error creating table %: %', table_name, SQLERRM;
    RETURN false;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION create_distributor_table(text) TO authenticated;