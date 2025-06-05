/*
  # Temporarily disable RLS for troubleshooting
  
  1. Changes
    - Temporarily disable RLS on distributor_routes table
    - Drop existing policies for clean state
*/

-- First, drop all existing policies
DROP POLICY IF EXISTS "Users can read routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can insert routes" ON distributor_routes;
DROP POLICY IF EXISTS "Users can update routes" ON distributor_routes;
DROP POLICY IF EXISTS "Admins can delete routes" ON distributor_routes;

-- Disable RLS
ALTER TABLE distributor_routes DISABLE ROW LEVEL SECURITY;