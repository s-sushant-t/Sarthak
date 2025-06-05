import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const getBeatCount = async (distributorCode: string) => {
  try {
    const { data, error } = await supabase
      .from('distributor_routes')
      .select('beat', { count: 'exact', head: false })
      .eq('distributor_code', distributorCode)
      .order('beat');

    if (error) throw error;

    // Get unique beats using Set to remove duplicates
    const uniqueBeats = [...new Set((data || [])
      .map(row => Number(row.beat))
      .filter(b => !isNaN(b)))]
      .sort((a, b) => a - b);

    console.log('✅ Beat count verification:', {
      distinctBeats: uniqueBeats.length,
      beatNumbers: uniqueBeats
    });

    return {
      count: uniqueBeats.length,
      beats: uniqueBeats
    };
  } catch (error) {
    console.error('❌ Error getting beat count:', error);
    throw error;
  }
};