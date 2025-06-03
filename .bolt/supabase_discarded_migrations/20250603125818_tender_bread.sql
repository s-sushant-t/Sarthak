/*
  # Set up authentication users and policies
  
  1. Create admin user (EDIS)
  2. Enable email/password auth
  3. Add RLS policies
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
  'edis',
  'authenticated',
  'authenticated',
  'admin@itc.com',
  crypt('EDIS_2024-25', gen_salt('bf')),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- Enable email auth
UPDATE auth.config 
SET enable_signup = false,
    enable_confirmations = false;