import { RouterProvider } from 'react-router-dom';
import { Sprout } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { LoginPage } from '@/pages/auth/LoginPage';
import { SetupPage } from '@/pages/auth/SetupPage';
import { router } from '@/routes';

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <Sprout className="animate-pulse text-emerald-500" size={28} />
    </div>
  );
}

export function AuthGate() {
  const { status } = useAuth();

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'needs-setup') return <SetupPage />;
  if (status === 'unauthenticated') return <LoginPage />;
  return <RouterProvider router={router} />;
}
