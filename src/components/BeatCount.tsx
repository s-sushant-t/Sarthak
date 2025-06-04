import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const getBeatCount = async (distributorCode: string) => {
  const { data, error } = await supabase
    .from('distributor_routes')
    .select('beat')
    .eq('distributor_code', distributorCode);
    
  if (error) throw error;
  
  const uniqueBeats = [...new Set(data.map(row => row.beat))];
  console.log('Total unique beats:', uniqueBeats.length);
  console.log('Beat numbers:', uniqueBeats.sort((a,b) => a-b));
  
  return uniqueBeats.length;
};