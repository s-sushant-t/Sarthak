/*
  # Update RLS policies for distributor_routes table
  
  1. Changes
    - Add policies for both admin (EDIS) and distributor access
    - Ensure proper read/write permissions
    - Fix authentication checks
  
  2. Security
    - Enable RLS
    - Add comprehensive policies for all operations
    - Maintain data isolation between distributors
*/

-- First, drop existing policies
DROP POLICY IF EXISTS "Admins can read all routes" ON distributor_routes;
DROP POLICY IF EXISTS "Distributors can read their own routes" ON distributor_routes;
DROP POLICY IF EXISTS "Admins can insert routes" ON distributor_routes;
DROP POLICY IF EXISTS "Admins can update all routes" ON distributor_routes;
DROP POLICY IF EXISTS "Distributors can update their own routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can insert their own distributor routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can read their own distributor routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can update their own distributor routes" ON distributor_routes;

-- Enable RLS
ALTER TABLE distributor_routes ENABLE ROW LEVEL SECURITY;

-- Create policy for admin read access
CREATE POLICY "Admins can read all routes" ON distributor_routes
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt()->>'email' = 'EDIS') OR
    (distributor_code = auth.uid()::text)
  );

-- Create policy for admin insert access
CREATE POLICY "Admins can insert routes" ON distributor_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.jwt()->>'email' = 'EDIS') OR
    (distributor_code = auth.uid()::text)
  );

-- Create policy for admin update access
CREATE POLICY "Admins can update routes" ON distributor_routes
  FOR UPDATE
  TO authenticated
  USING (
    (auth.jwt()->>'email' = 'EDIS') OR
    (distributor_code = auth.uid()::text)
  )
  WITH CHECK (
    (auth.jwt()->>'email' = 'EDIS') OR
    (distributor_code = auth.uid()::text)
  );

-- Create policy for admin delete access
CREATE POLICY "Admins can delete routes" ON distributor_routes
  FOR DELETE
  TO authenticated
  USING (auth.jwt()->>'email' = 'EDIS');