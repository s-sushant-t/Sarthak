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
      // Special case for EDIS admin - authenticate with Supabase using edis@example.com
      if (loginId === 'EDIS' && password === 'EDIS_2024-25') {
        const { data, error: authError } = await supabase.auth.signInWithPassword({
          email: 'edis@example.com',
          password: 'EDIS_2024-25'
        });

        if (authError) {
          throw new Error('EDIS admin authentication failed. Please ensure the edis@example.com user exists in Supabase Auth with password EDIS_2024-25');
        }

        if (data.user) {
          localStorage.setItem('isAuthenticated', 'true');
          localStorage.setItem('userType', 'admin');
          await onLogin(loginId, password);
          return;
        }
      }

      // For distributor codes (no @ symbol), check if they exist in the database
      if (!loginId.includes('@')) {
        // Check if this is a valid distributor code
        const { data, error: fetchError } = await supabase
          .from('distributor_routes')
          .select('distributor_code')
          .eq('distributor_code', loginId)
          .limit(1)
          .single();

        if (fetchError || !data) {
          throw new Error('Invalid distributor code. Please check your credentials or contact your administrator.');
        }

        // For distributor login, the password should match the distributor code
        if (data.distributor_code === loginId && loginId === password) {
          localStorage.setItem('isAuthenticated', 'true');
          localStorage.setItem('userType', 'distributor');
          localStorage.setItem('distributorCode', loginId);
          window.location.reload(); // Trigger app re-render to pick up new auth state
          return;
        } else {
          throw new Error('Invalid credentials. For distributor access, use your distributor code as both username and password.');
        }
      }

      // For email-based login, use Supabase authentication
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: loginId,
        password: password
      });

      if (authError) {
        throw authError;
      }

      if (data.user) {
        // Check if this user has distributor routes assigned
        const { data: routeData, error: fetchError } = await supabase
          .from('distributor_routes')
          .select('distributor_code')
          .eq('distributor_code', data.user.email)
          .limit(1);

        if (fetchError) {
          console.error('Error checking distributor routes:', fetchError);
          // Don't throw error here, user might be authenticated but no routes assigned yet
        }

        localStorage.setItem('isAuthenticated', 'true');
        localStorage.setItem('userType', 'distributor');
        localStorage.setItem('distributorCode', data.user.email || loginId);
        window.location.reload(); // Trigger app re-render to pick up new auth state
      }
    } catch (error: any) {
      console.error('Login error:', error);
      let errorMessage = 'Invalid credentials. Please try again.';
      
      if (error.message?.includes('Invalid login credentials')) {
        errorMessage = 'Invalid email or password. Please check your credentials.';
      } else if (error.message?.includes('Email not confirmed')) {
        errorMessage = 'Please confirm your email address before logging in.';
      } else if (error.message?.includes('Too many requests')) {
        errorMessage = 'Too many login attempts. Please try again later.';
      } else if (error.message?.includes('Invalid distributor code')) {
        errorMessage = error.message;
      } else if (error.message?.includes('distributor access')) {
        errorMessage = error.message;
      } else if (error.message?.includes('EDIS admin authentication failed')) {
        errorMessage = error.message;
      }
      
      setError(errorMessage);
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
                    // Auto-set password for distributor login (no @ symbol)
                    if (!e.target.value.includes('@')) {
                      setPassword(e.target.value);
                    }
                  }}
                  className="appearance-none block w-full px-3 py-2 border border-white/20 rounded-md shadow-sm placeholder-blue-300/50 bg-white/10 text-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  placeholder="Enter EDIS, distributor code, or email"
                  disabled={isLoading}
                />
              </div>
              <div className="mt-2 space-y-1">
                <p className="text-xs text-blue-300/70">
                  • Use 'EDIS' for administrator access
                </p>
                <p className="text-xs text-blue-300/70">
                  • Use your distributor code (e.g., DIST001) for distributor access
                </p>
                <p className="text-xs text-blue-300/70">
                  • Use your email address for registered user access
                </p>
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
              {!loginId.includes('@') && loginId && (
                <p className="mt-1 text-xs text-blue-300/70">
                  For distributor access, password should match your distributor code
                </p>
              )}
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
                  Authenticating...
                </div>
              ) : (
                <>
                  <LogIn className="w-4 h-4 mr-2" />
                  Access System
                </>
              )}
            </button>
          </form>

          <div className="mt-6 p-4 bg-blue-900/20 rounded-lg border border-blue-500/20">
            <h4 className="text-sm font-medium text-blue-200 mb-2">Access Methods:</h4>
            <ul className="text-xs text-blue-300/80 space-y-1">
              <li>• <strong>Admin:</strong> Use 'EDIS' with password 'EDIS_2024-25'</li>
              <li>• <strong>Distributor:</strong> Use your distributor code as both username and password</li>
              <li>• <strong>Registered User:</strong> Use your email address and assigned password</li>
              <li>• Contact your administrator for account setup if needed</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;