import React, { useState } from 'react';
import { LogIn, Binary, Network, Cpu } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

interface LoginProps {
  onLogin: (loginId: string, password: string) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    try {
      if (loginId === 'EDIS' && password === 'EDIS_2024-25') {
        await onLogin(loginId, password);
      } else {
        // Check if this is a valid distributor code
        const { data, error: fetchError } = await supabase
          .from('distributor_routes')
          .select('distributor_code')
          .eq('distributor_code', loginId)
          .limit(1)
          .single();

        if (fetchError) {
          throw new Error('Invalid distributor code');
        }

        if (data && data.distributor_code === loginId && loginId === password) {
          localStorage.setItem('userType', 'distributor');
          await onLogin(loginId, loginId);
        } else {
          throw new Error('Invalid credentials');
        }
      }
    } catch (error) {
      console.error('Login error:', error);
      setError('Invalid credentials. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8 relative overflow-hidden">
      <div className="absolute inset-0 z-0">
        <Binary className="absolute text-blue-200 opacity-10 w-24 h-24 animate-float" style={{ top: '15%', left: '10%' }} />
        <Network className="absolute text-purple-200 opacity-10 w-32 h-32 animate-float-delayed" style={{ top: '60%', right: '15%' }} />
        <Cpu className="absolute text-indigo-200 opacity-10 w-28 h-28 animate-float" style={{ top: '30%', right: '25%' }} />
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md relative z-10">
        <div className="text-center">
          <h2 className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400 mb-2">
            ITC WD Sarthak
          </h2>
          <p className="text-lg text-blue-200 font-light">
            Route Optimization System
          </p>
          <div className="mt-2 text-sm text-blue-200 opacity-80">
            Powered by Advanced Algorithms
          </div>
        </div>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md relative z-10">
        <div className="bg-white/10 backdrop-blur-lg py-8 px-4 shadow-2xl sm:rounded-xl sm:px-10 border border-white/20">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="loginId" className="block text-sm font-medium text-blue-200">
                Login ID
              </label>
              <div className="mt-1">
                <input
                  id="loginId"
                  name="loginId"
                  type="text"
                  required
                  value={loginId}
                  onChange={(e) => {
                    setLoginId(e.target.value);
                    setPassword(e.target.value); // Auto-set password for distributor login
                  }}
                  className="appearance-none block w-full px-3 py-2 border border-white/20 rounded-md shadow-sm placeholder-blue-300/50 bg-white/10 text-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  placeholder="Enter EDIS or your distributor code"
                  disabled={isLoading}
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-blue-200">
                Password
              </label>
              <div className="mt-1">
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="appearance-none block w-full px-3 py-2 border border-white/20 rounded-md shadow-sm placeholder-blue-300/50 bg-white/10 text-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  placeholder="Enter your password"
                  disabled={isLoading}
                />
              </div>
            </div>

            {error && (
              <div className="text-red-400 text-sm bg-red-900/20 px-3 py-2 rounded-md border border-red-500/20">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full flex justify-center items-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transform transition-all duration-200 hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <div className="flex items-center">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                  Logging in...
                </div>
              ) : (
                <>
                  <LogIn className="w-4 h-4 mr-2" />
                  Access System
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Login;