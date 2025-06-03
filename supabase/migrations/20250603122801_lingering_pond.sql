/*
  # Create distributor routes table

  1. New Tables
    - `distributor_routes`
      - `id` (uuid, primary key)
      - `distributor_code` (text) - Unique code for distributor
      - `beat` (integer) - Beat number
      - `stop_order` (integer) - Order of stop in the beat
      - `dms_customer_id` (text) - Customer ID from DMS
      - `outlet_name` (text) - Name of the outlet
      - `latitude` (double precision) - Outlet latitude
      - `longitude` (double precision) - Outlet longitude
      - `distance_to_next` (double precision) - Distance to next stop in km
      - `time_to_next` (integer) - Time to next stop in minutes
      - `cluster_id` (integer) - Cluster ID for the stop
      - `market_work_remark` (text) - Market work remarks
      - `updated_ol_name` (text) - Updated outlet name
      - `owner_name` (text) - Owner name
      - `owner_contact` (text) - Owner contact details
      - `ol_closure_time` (text) - Outlet closure time
      - `visit_time` (timestamptz) - Time when visit was marked
      - `created_at` (timestamptz) - Record creation time

  2. Security
    - Enable RLS on `distributor_routes` table
    - Add policies for authenticated users
*/

CREATE TABLE distributor_routes (
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
  
  CONSTRAINT unique_distributor_beat_stop UNIQUE (distributor_code, beat, stop_order)
);

ALTER TABLE distributor_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own distributor routes"
  ON distributor_routes
  FOR SELECT
  TO authenticated
  USING (auth.uid()::text = distributor_code);

CREATE POLICY "Users can insert their own distributor routes"
  ON distributor_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid()::text = distributor_code);

CREATE POLICY "Users can update their own distributor routes"
  ON distributor_routes
  FOR UPDATE
  TO authenticated
  USING (auth.uid()::text = distributor_code)
  WITH CHECK (auth.uid()::text = distributor_code);