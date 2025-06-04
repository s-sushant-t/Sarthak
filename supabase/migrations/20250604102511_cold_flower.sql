/*
  # Add auditor columns to distributor_routes table

  1. Changes
    - Add auditor_name column
    - Add auditor_designation column
    - Add is_being_audited column
*/

ALTER TABLE distributor_routes 
ADD COLUMN IF NOT EXISTS auditor_name text,
ADD COLUMN IF NOT EXISTS auditor_designation text,
ADD COLUMN IF NOT EXISTS is_being_audited boolean DEFAULT false;