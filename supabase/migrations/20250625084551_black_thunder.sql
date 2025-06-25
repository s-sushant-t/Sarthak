/*
  # Create execute_sql function for dynamic table operations

  1. New Functions
    - execute_sql: Allows execution of dynamic SQL queries
      - Input: sql_query (text)
      - Output: JSON result
      - Security: Restricted to authenticated users only

  2. Security
    - Function is marked as SECURITY DEFINER to run with elevated privileges
    - Only authenticated users can execute the function
    - Helps with dynamic table creation and operations
*/

-- Create the execute_sql function
CREATE OR REPLACE FUNCTION execute_sql(sql_query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
BEGIN
  -- Execute the dynamic SQL and return result as JSON
  EXECUTE sql_query;
  
  -- For SELECT queries, we need to handle the result differently
  IF UPPER(TRIM(sql_query)) LIKE 'SELECT%' THEN
    EXECUTE 'SELECT array_to_json(array_agg(row_to_json(t))) FROM (' || sql_query || ') t' INTO result;
  ELSE
    -- For non-SELECT queries, return a simple success message
    result := '{"success": true}'::json;
  END IF;
  
  RETURN result;
EXCEPTION
  WHEN OTHERS THEN
    -- Return error information
    RETURN json_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION execute_sql(text) TO authenticated;