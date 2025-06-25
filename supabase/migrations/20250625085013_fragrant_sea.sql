/*
  # Simple distributor table management
  
  1. Changes
    - Add a distributor_table_mapping table to track which table each distributor uses
    - Create simple helper functions that don't require elevated privileges
    - Use application-level logic for table creation and management
  
  2. Security
    - Enable RLS on new tables
    - Add policies for proper access control
*/

-- Create a table to track which table each distributor uses
CREATE TABLE IF NOT EXISTS distributor_table_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distributor_code text UNIQUE NOT NULL,
  table_name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS on the mapping table
ALTER TABLE distributor_table_mapping ENABLE ROW LEVEL SECURITY;

-- Create policies for the mapping table
CREATE POLICY "Users can read their own mapping" ON distributor_table_mapping
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt()->>'email' = 'EDIS') OR 
    (distributor_code = auth.uid()::text)
  );

CREATE POLICY "Admins can manage mappings" ON distributor_table_mapping
  FOR ALL
  TO authenticated
  USING (auth.jwt()->>'email' = 'EDIS')
  WITH CHECK (auth.jwt()->>'email' = 'EDIS');

-- Create a simple function to get table name for a distributor
CREATE OR REPLACE FUNCTION get_distributor_table_name(dist_code text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT table_name FROM distributor_table_mapping WHERE distributor_code = dist_code),
    'distributor_routes'
  );
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_distributor_table_name(text) TO authenticated;

-- Create a function to register a new distributor table
CREATE OR REPLACE FUNCTION register_distributor_table(dist_code text, tbl_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  INSERT INTO distributor_table_mapping (distributor_code, table_name)
  VALUES (dist_code, tbl_name)
  ON CONFLICT (distributor_code) 
  DO UPDATE SET table_name = EXCLUDED.table_name
  RETURNING true;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION register_distributor_table(text, text) TO authenticated;