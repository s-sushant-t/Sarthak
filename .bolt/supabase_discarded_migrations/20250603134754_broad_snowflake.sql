/*
  # Create distributor routes table

  1. New Tables
    - `distributor_routes`
      - `id` (uuid, primary key): Unique identifier for each route
      - `distributor_code` (text): Code identifying the distributor
      - `beat` (integer): Beat number
      - `stop_order` (integer): Order of the stop in the route
      - `dms_customer_id` (text): Customer ID from DMS
      - `outlet_name` (text): Name of the outlet
      - `latitude` (double precision): Latitude coordinate
      - `longitude` (double precision): Longitude coordinate
      - `distance_to_next` (double precision): Distance to next stop
      - `time_to_next` (integer): Time to next stop
      - `cluster_id` (integer): ID of the cluster this stop belongs to
      - `market_work_remark` (text): Remarks about market work
      - `updated_ol_name` (text): Updated outlet name
      - `owner_name` (text): Name of the outlet owner
      - `owner_contact` (text): Contact information of the owner
      - `ol_closure_time` (text): Outlet closure time
      - `visit_time` (timestamptz): Time when the outlet was visited
      - `created_at` (timestamptz): Record creation timestamp

  2. Security
    - Enable RLS on `distributor_routes` table
    - Add policies for:
      - Distributors can read their own routes
      - Distributors can update their own routes
      - Distributors can insert their own routes

  3. Constraints
    - Primary key on id
    - Unique constraint on distributor_code, beat, and stop_order combination
*/

-- Create the distributor_routes table
CREATE TABLE IF NOT EXISTS public.distributor_routes (
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
    created_at timestamptz DEFAULT now()
);

-- Create unique constraint for distributor_code, beat, and stop_order
ALTER TABLE public.distributor_routes
ADD CONSTRAINT unique_distributor_beat_stop UNIQUE (distributor_code, beat, stop_order);

-- Enable Row Level Security
ALTER TABLE public.distributor_routes ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can read their own distributor routes"
ON public.distributor_routes
FOR SELECT
TO authenticated
USING ((auth.uid())::text = distributor_code);

CREATE POLICY "Users can insert their own distributor routes"
ON public.distributor_routes
FOR INSERT
TO authenticated
WITH CHECK ((auth.uid())::text = distributor_code);

CREATE POLICY "Users can update their own distributor routes"
ON public.distributor_routes
FOR UPDATE
TO authenticated
USING ((auth.uid())::text = distributor_code)
WITH CHECK ((auth.uid())::text = distributor_code);