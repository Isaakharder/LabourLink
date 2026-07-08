import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden bg-gray-50">
        <div className="flex-1 flex flex-col p-8 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
