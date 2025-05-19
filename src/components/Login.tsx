import React, { useState, useEffect } from 'react';
import { LogIn, Binary, Network, Cpu } from 'lucide-react';

interface LoginProps {
  onLogin: () => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [particles, setParticles] = useState<Array<{ x: number; y: number; vx: number; vy: number }>>([]);

  useEffect(() => {
    // Create initial particles
    const initialParticles = Array.from({ length: 50 }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2
    }));
    setParticles(initialParticles);

    // Animation loop
    let animationId: number;
    const animate = () => {
      setParticles(prevParticles => 
        prevParticles.map(particle => ({
          x: (particle.x + particle.vx + window.innerWidth) % window.innerWidth,
          y: (particle.y + particle.vy + window.innerHeight) % window.innerHeight,
          vx: particle.vx,
          vy: particle.vy
        }))
      );
      animationId = requestAnimationFrame(animate);
    };
    animate();

    return () => cancelAnimationFrame(animationId);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (loginId === 'EDIS' && password === 'EDIS_2024-25') {
      onLogin();
    } else {
      setError('Invalid credentials. Please try again.');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8 relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0 z-0">
        <svg className="w-full h-full">
          {particles.map((particle, i) => (
            <circle
              key={i}
              cx={particle.x}
              cy={particle.y}
              r="1"
              fill="#ffffff"
              opacity="0.2"
            />
          ))}
        </svg>
      </div>

      {/* Floating icons */}
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
                  onChange={(e) => setLoginId(e.target.value)}
                  className="appearance-none block w-full px-3 py-2 border border-white/20 rounded-md shadow-sm placeholder-blue-300/50 bg-white/10 text-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  placeholder="Enter your login ID"
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
                />
              </div>
            </div>

            {error && (
              <div className="text-red-400 text-sm bg-red-900/20 px-3 py-2 rounded-md border border-red-500/20">
                {error}
              </div>
            )}

            <div>
              <button
                type="submit"
                className="w-full flex justify-center items-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transform transition-all duration-200 hover:scale-[1.02]"
              >
                <LogIn className="w-4 h-4 mr-2" />
                Access System
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Login;