/**
 * 应用根组件
 *
 * 结构：手机外壳（.xl-phone，桌面预览时带手机边框）
 *   └── flex 列：页面内容（自带 header + 滚动区） + 底部 TabBar
 *
 * 路由：
 *   /                     首页
 *   /chat?c=<characterId> 聊天页（全屏，隐藏 TabBar）
 *   /characters           角色管理
 *   /characters/new       新建角色
 *   /characters/:id       编辑角色
 *   /memories             记忆管理
 *   /settings             设置
 */

import { lazy, Suspense } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { ProtectedRoute } from '@/components/common/ProtectedRoute';
import { TabBar } from '@/components/common/TabBar';
import { ToastHost } from '@/components/common/Toast';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { HomePage } from '@/pages/HomePage';
import { LoginPage } from '@/pages/LoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { useUserId } from '@/hooks/useUserId';

// 懒加载：首屏只打包 Home / Login / Register，其余页面（聊天、设置、记忆实验室…）
// 拆成独立 chunk，进入对应路由时才下载，显著减小首屏 JS 体积、加快首屏可交互。
const AccountPage = lazy(() =>
  import('@/pages/AccountPage').then((m) => ({ default: m.AccountPage })),
);
const ChatPage = lazy(() => import('@/pages/ChatPage').then((m) => ({ default: m.ChatPage })));
const CharacterListPage = lazy(() =>
  import('@/pages/CharacterListPage').then((m) => ({ default: m.CharacterListPage })),
);
const CharacterEditPage = lazy(() =>
  import('@/pages/CharacterEditPage').then((m) => ({ default: m.CharacterEditPage })),
);
const CharacterDetailPage = lazy(() =>
  import('@/pages/CharacterDetailPage').then((m) => ({ default: m.CharacterDetailPage })),
);
const UnfinishedPage = lazy(() =>
  import('@/pages/UnfinishedPage').then((m) => ({ default: m.UnfinishedPage })),
);
const MemoryPage = lazy(() =>
  import('@/pages/MemoryPage').then((m) => ({ default: m.MemoryPage })),
);
const StoryPage = lazy(() => import('@/pages/StoryPage').then((m) => ({ default: m.StoryPage })));
const LearnedPage = lazy(() =>
  import('@/pages/LearnedPage').then((m) => ({ default: m.LearnedPage })),
);
const GrowthPage = lazy(() =>
  import('@/pages/GrowthPage').then((m) => ({ default: m.GrowthPage })),
);
const MemoryLabPage = lazy(() =>
  import('@/pages/MemoryLabPage').then((m) => ({ default: m.MemoryLabPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

/**
 * 这些路由是「沉浸式」页面：全屏显示，不显示底部导航。
 * 登录 / 注册同样不该出现 TabBar——用户这时还没进入「陪伴空间」。
 */
const IMMERSIVE_PREFIXES = ['/chat', '/characters/', '/login', '/register', '/account'];

function isImmersive(pathname: string): boolean {
  return IMMERSIVE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export default function App(): React.ReactElement {
  const location = useLocation();
  // 触发一次 userId 初始化：确保 localStorage 里的 ID 在任何页面请求发出前就位
  useUserId();

  const showTabBar = !isImmersive(location.pathname);

  return (
    <div className="xl-phone">
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<PageSkeleton />}>
          <Routes>
            {/* 认证页：公开，不需要登录 */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />

            {/* 主页与账号页需要登录（ALLOW_ANONYMOUS=1 时守卫会放行匿名用户） */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <HomePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/account"
              element={
                <ProtectedRoute>
                  <AccountPage />
                </ProtectedRoute>
              }
            />

            <Route path="/chat" element={<ChatPage />} />
            <Route path="/characters" element={<CharacterListPage />} />
            <Route path="/characters/new" element={<CharacterEditPage />} />
            <Route path="/characters/:id" element={<CharacterEditPage />} />
            <Route path="/characters/:id/detail" element={<CharacterDetailPage />} />
            <Route path="/unfinished" element={<UnfinishedPage />} />
            <Route path="/memories" element={<MemoryPage />} />
            <Route path="/stories" element={<StoryPage />} />
            <Route path="/learned" element={<LearnedPage />} />
            <Route path="/growth" element={<GrowthPage />} />
            <Route path="/memory-lab" element={<MemoryLabPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* 兜底：未知路径回首页，避免白屏 */}
            <Route
              path="*"
              element={
                <ProtectedRoute>
                  <HomePage />
                </ProtectedRoute>
              }
            />
          </Routes>
        </Suspense>
      </div>

      {showTabBar ? <TabBar /> : null}
      <ToastHost />
    </div>
  );
}
