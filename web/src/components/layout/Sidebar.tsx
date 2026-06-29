import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  FileText,
  Activity,
  Leaf,
  Sprout,
  MapPin,
  Map,
  Truck,
  UsersRound,
  PenLine,
  BarChart3,
  Settings,
  ChevronDown,
  ChevronRight,
  Sprout as Logo,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavLeaf {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
}

interface NavGroup {
  label: string;
  icon?: React.ComponentType<{ className?: string; size?: number }>;
  children: NavLeaf[];
}

type NavItem = NavLeaf | NavGroup;

function isGroup(item: NavItem): item is NavGroup {
  return 'children' in item;
}

const navigation: NavItem[] = [
  { label: 'Dashboard', path: '/', icon: LayoutDashboard },
  {
    label: 'Basic Data',
    children: [
      { label: 'Employees', path: '/employees', icon: Users },
      { label: 'Contracts', path: '/contracts', icon: FileText },
      { label: 'Activities', path: '/activities', icon: Activity },
      { label: 'Crops', path: '/crops', icon: Leaf },
      { label: 'Varieties', path: '/varieties', icon: Sprout },
      { label: 'Location Groups', path: '/location-groups', icon: MapPin },
      { label: 'Locations', path: '/locations', icon: Map },
      { label: 'Carriers', path: '/carriers', icon: Truck },
      { label: 'Teams', path: '/teams', icon: UsersRound },
    ],
  },
  { label: 'Input', path: '/input', icon: PenLine },
  { label: 'Reports', path: '/reports', icon: BarChart3 },
  { label: 'Configuration', path: '/configuration', icon: Settings },
];

export function Sidebar() {
  const location = useLocation();

  const basicDataPaths = [
    '/employees', '/contracts', '/activities', '/crops', '/varieties',
    '/location-groups', '/locations', '/carriers', '/teams',
  ];
  const basicDataActive = basicDataPaths.some((p) =>
    location.pathname.startsWith(p)
  );

  const [basicDataOpen, setBasicDataOpen] = useState(basicDataActive || true);

  return (
    <aside className="flex h-screen w-60 flex-shrink-0 flex-col bg-[hsl(var(--sidebar))] border-r border-[hsl(var(--sidebar-border))]">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-[hsl(var(--sidebar-border))]">
        <Logo size={20} className="text-emerald-400 flex-shrink-0" />
        <span className="text-white font-semibold text-base tracking-tight">
          LabourLink
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {navigation.map((item) => {
          if (!isGroup(item)) {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-[hsl(var(--sidebar-active))] text-white font-medium'
                      : 'text-[hsl(var(--sidebar-foreground))] hover:bg-white/5 hover:text-white'
                  )
                }
              >
                <Icon size={16} className="flex-shrink-0" />
                {item.label}
              </NavLink>
            );
          }

          return (
            <div key={item.label}>
              <button
                onClick={() => setBasicDataOpen((o) => !o)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  basicDataActive
                    ? 'text-white'
                    : 'text-[hsl(var(--sidebar-foreground))] hover:bg-white/5 hover:text-white'
                )}
              >
                <span className="flex-1 text-left">{item.label}</span>
                {basicDataOpen ? (
                  <ChevronDown size={14} className="flex-shrink-0" />
                ) : (
                  <ChevronRight size={14} className="flex-shrink-0" />
                )}
              </button>

              {basicDataOpen && (
                <div className="mt-0.5 ml-3 space-y-0.5 border-l border-[hsl(var(--sidebar-border))] pl-3">
                  {item.children.map((child) => {
                    const Icon = child.icon;
                    return (
                      <NavLink
                        key={child.path}
                        to={child.path}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                            isActive
                              ? 'bg-[hsl(var(--sidebar-active))] text-white font-medium'
                              : 'text-[hsl(var(--sidebar-foreground))] hover:bg-white/5 hover:text-white'
                          )
                        }
                      >
                        <Icon size={15} className="flex-shrink-0" />
                        {child.label}
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[hsl(var(--sidebar-border))]">
        <p className="text-xs text-[hsl(var(--sidebar-muted))]">
          Local-first · v0.1.0
        </p>
      </div>
    </aside>
  );
}
