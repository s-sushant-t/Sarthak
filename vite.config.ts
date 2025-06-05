import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';

dotenv.config();

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  define: {
    // Explicitly define environment variables for client-side use
    'process.env.VITE_SUPABASE_URL': JSON.stringify(process.env.VITE_SUPABASE_URL),
    'process.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.VITE_SUPABASE_ANON_KEY)
  },
  server: {
    // Add CORS headers to allow Supabase requests
    proxy: {
      '/rest': {
        target: process.env.VITE_SUPABASE_URL,
        changeOrigin: true,
        secure: false,
      }
    }
  }
});