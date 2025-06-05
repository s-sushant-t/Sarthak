/*
  # Enable RLS for distributor_routes table

  1. Security Changes
    - Enable RLS on distributor_routes table
    - Add policies for:
      - Authenticated users can read their own routes
      - Admins (EDIS) can read all routes
      - Admins can insert/update all routes
      - Distributors can update their own routes
  
  2. Notes
    - Preserves existing functionality while adding security
    - Maintains compatibility with current application features
    - Ensures data isolation between distributors
*/

-- Enable RLS
ALTER TABLE distributor_routes ENABLE ROW LEVEL SECURITY;

-- Create policy for admin read access
CREATE POLICY "Admins can read all routes" ON distributor_routes
  FOR SELECT
  TO authenticated
  USING (auth.jwt()->>'email' = 'EDIS');

-- Create policy for distributor read access
CREATE POLICY "Distributors can read their own routes" ON distributor_routes
  FOR SELECT
  TO authenticated
  USING (distributor_code = auth.uid()::text);

-- Create policy for admin insert access
CREATE POLICY "Admins can insert routes" ON distributor_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.jwt()->>'email' = 'EDIS');

-- Create policy for admin update access
CREATE POLICY "Admins can update all routes" ON distributor_routes
  FOR UPDATE
  TO authenticated
  USING (auth.jwt()->>'email' = 'EDIS')
  WITH CHECK (auth.jwt()->>'email' = 'EDIS');

-- Create policy for distributor update access
CREATE POLICY "Distributors can update their own routes" ON distributor_routes
  FOR UPDATE
  TO authenticated
  USING (distributor_code = auth.uid()::text)
  WITH CHECK (distributor_code = auth.uid()::text);