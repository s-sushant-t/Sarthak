/*
  # Update RLS policies for distributor_routes table
  
  1. Changes
    - Drop all existing policies
    - Re-enable RLS
    - Create comprehensive policies for both admin and distributor access
    
  2. Security
    - Admin (EDIS) has full access to all routes
    - Distributors can only access and update their own routes
    - Proper authentication checks using auth.uid()
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
DROP POLICY IF EXISTS "Admins can delete routes" ON distributor_routes;

-- Enable RLS
ALTER TABLE distributor_routes ENABLE ROW LEVEL SECURITY;

-- Create unified read policy for both admin and distributors
CREATE POLICY "Users can read routes" ON distributor_routes
  FOR SELECT
  TO authenticated
  USING (
    auth.jwt()->>'email' = 'EDIS' OR 
    distributor_code = COALESCE(auth.uid()::text, '')
  );

-- Create unified insert policy
CREATE POLICY "Users can insert routes" ON distributor_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.jwt()->>'email' = 'EDIS' OR 
    distributor_code = COALESCE(auth.uid()::text, '')
  );

-- Create unified update policy
CREATE POLICY "Users can update routes" ON distributor_routes
  FOR UPDATE
  TO authenticated
  USING (
    auth.jwt()->>'email' = 'EDIS' OR 
    distributor_code = COALESCE(auth.uid()::text, '')
  )
  WITH CHECK (
    auth.jwt()->>'email' = 'EDIS' OR 
    distributor_code = COALESCE(auth.uid()::text, '')
  );

-- Create admin-only delete policy
CREATE POLICY "Admins can delete routes" ON distributor_routes
  FOR DELETE
  TO authenticated
  USING (auth.jwt()->>'email' = 'EDIS');