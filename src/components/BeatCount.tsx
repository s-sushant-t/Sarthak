import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const getBeatCount = async (distributorCode: string) => {
  try {
    // First, get a count of distinct beats
    const { data: distinctBeats, error: distinctError } = await supabase
      .from('distributor_routes')
      .select('beat')
      .eq('distributor_code', distributorCode)
      .order('beat');

    if (distinctError) throw distinctError;

    // Use Set to get unique beats and ensure proper sorting
    const uniqueBeats = Array.from(new Set(distinctBeats.map(row => row.beat)))
      .sort((a, b) => a - b);

    console.log('Beat count verification:', {
      totalRows: distinctBeats.length,
      distinctBeats: uniqueBeats.length,
      beatNumbers: uniqueBeats
    });

    return {
      count: uniqueBeats.length,
      beats: uniqueBeats
    };
  } catch (error) {
    console.error('Error getting beat count:', error);
    throw error;
  }
};