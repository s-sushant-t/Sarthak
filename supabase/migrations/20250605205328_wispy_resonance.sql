/*
# Add get_distinct_beats stored function

This migration adds a stored function to efficiently retrieve distinct beat numbers
for a given distributor code.

1. New Functions
   - get_distinct_beats: Returns ordered list of distinct beat numbers
     - Input: distributor_code (text)
     - Output: table of beat numbers (integer)

2. Benefits
   - Improved performance by handling pagination server-side
   - Consistent ordering of results
   - Single database round trip
*/

-- Create the stored function for getting distinct beats
CREATE OR REPLACE FUNCTION get_distinct_beats(distributor text)
RETURNS TABLE(beat int) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT dr.beat
  FROM distributor_routes dr
  WHERE dr.distributor_code = distributor
  ORDER BY dr.beat;
END;
$$ LANGUAGE plpgsql;