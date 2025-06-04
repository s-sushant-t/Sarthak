import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const getBeatCount = async (distributorCode: string) => {
  try {
    // First, get a count of distinct beats
    const { count, error: countError } = await supabase
      .from('distributor_routes')
      .select('beat', { count: 'exact', head: true })
      .eq('distributor_code', distributorCode);

    if (countError) throw countError;

    // Then get the actual beat numbers
    const { data, error } = await supabase
      .from('distributor_routes')
      .select('beat')
      .eq('distributor_code', distributorCode)
      .order('beat');

    if (error) throw error;

    // Use Set to get unique beats and ensure proper sorting
    const uniqueBeats = Array.from(new Set(data.map(row => row.beat)))
      .sort((a, b) => a - b);

    console.log('Beat count verification:', {
      totalRows: data.length,
      distinctBeats: uniqueBeats.length,
      beatNumbers: uniqueBeats,
      expectedCount: count
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