/*
  # Update RLS policies for distributor_routes table
  
  1. Changes
    - Drop existing policies to ensure clean state
    - Enable RLS on distributor_routes table
    - Create unified policies for both admin and distributor access
    - Add proper COALESCE handling for auth.uid()
    - Ensure proper access control for all operations
  
  2. Security
    - Admin (EDIS) has full access to all routes
    - Distributors can only access their own routes
    - Delete operations restricted to admin only
*/

-- First, drop existing policies to ensure clean state
DROP POLICY IF EXISTS "Admins can read all routes" ON distributor_routes;
DROP POLICY IF EXISTS "Distributors can read their own routes" ON distributor_routes;
DROP POLICY IF EXISTS "Admins can insert routes" ON distributor_routes;
DROP POLICY IF EXISTS "Admins can update all routes" ON distributor_routes;
DROP POLICY IF EXISTS "Distributors can update their own routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can insert their own distributor routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can read their own distributor routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can update their own distributor routes" ON distributor_routes;
DROP POLICY IF EXISTS "Admins can delete routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can read routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can insert routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can update routes" ON distributor_routes;

-- Enable RLS
ALTER TABLE distributor_routes ENABLE ROW LEVEL SECURITY;

-- Create unified read policy for both admin and distributors
CREATE POLICY "Users can read routes" ON distributor_routes
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt()->>'email' = 'EDIS') OR 
    (distributor_code = COALESCE(auth.uid()::text, ''))
  );

-- Create unified insert policy
CREATE POLICY "Users can insert routes" ON distributor_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.jwt()->>'email' = 'EDIS') OR 
    (distributor_code = COALESCE(auth.uid()::text, ''))
  );

-- Create unified update policy
CREATE POLICY "Users can update routes" ON distributor_routes
  FOR UPDATE
  TO authenticated
  USING (
    (auth.jwt()->>'email' = 'EDIS') OR 
    (distributor_code = COALESCE(auth.uid()::text, ''))
  )
  WITH CHECK (
    (auth.jwt()->>'email' = 'EDIS') OR 
    (distributor_code = COALESCE(auth.uid()::text, ''))
  );

-- Create admin-only delete policy
CREATE POLICY "Admins can delete routes" ON distributor_routes
  FOR DELETE
  TO authenticated
  USING (auth.jwt()->>'email' = 'EDIS');