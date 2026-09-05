/**
 * 底部 Tab 导航
 *
 * 作为手机外壳 flex 列的最后一项渲染（不用 fixed），
 * 这样桌面预览的手机边框也能正确裁切，且天然适配 iPhone 底部安全区。
 */

import { NavLink } from 'react-router-dom';
import { Home, Users, BookOpen, User } from 'lucide-react';
import { TABS } from '@/config';

const ICONS = {
  home: Home,
  users: Users,
  book: BookOpen,
  user: User,
} as const;

export interface TabBarProps {
  className?: string;
}

export function TabBar({ className = '' }: TabBarProps): React.ReactElement {
  return (
    <nav
      className={`flex-none border-t border-[var(--xl-mist)] bg-[var(--xl-card)]/95 backdrop-blur xl-safe-bottom ${className}`}
      style={{ paddingLeft: 'var(--xl-safe-left)', paddingRight: 'var(--xl-safe-right)' }}
    >
      <div className="flex items-stretch">
        {TABS.map((tab) => {
          const Icon = ICONS[tab.icon];
          return (
            <NavLink
              key={tab.key}
              to={tab.path}
              end={tab.path === '/'}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
                  isActive ? 'text-[var(--xl-blush-deep)]' : 'text-[var(--xl-sub)]'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={21} strokeWidth={isActive ? 2.3 : 1.8} />
                  <span className={isActive ? 'font-medium' : ''}>{tab.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

export default TabBar;
