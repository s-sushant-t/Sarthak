/*
  # Add auditor tracking fields

  1. New Columns
    - auditor_name (text): Name of the auditor
    - auditor_designation (text): Designation/role of the auditor
    - is_being_audited (boolean): Flag to track if a beat is currently being audited

  2. Changes
    - Added nullable columns for auditor information
    - Added boolean flag for audit status with default false
*/

ALTER TABLE distributor_routes 
ADD COLUMN IF NOT EXISTS auditor_name text,
ADD COLUMN IF NOT EXISTS auditor_designation text,
ADD COLUMN IF NOT EXISTS is_being_audited boolean DEFAULT false;