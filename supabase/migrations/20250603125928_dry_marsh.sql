/*
  # Set up authentication and admin user
  
  1. Changes
    - Create admin user with proper UUID
    - Configure authentication settings
    - Disable email confirmations
  
  2. Security
    - Admin user is created with secure password
    - Email signup is disabled for security
*/

-- Create admin user
INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'admin@itc.com',
  crypt('EDIS_2024-25', gen_salt('bf')),
  now(),
  now(),
  now()
)
ON CONFLICT (email) DO NOTHING;

-- Enable email auth and disable confirmations
UPDATE auth.config 
SET enable_signup = false,
    enable_confirmations = false;