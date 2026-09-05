import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // GitHub Pages 项目站子路径：仓库名 xulian → 站点根目录为 /xulian/
  // 前端所有静态资源（JS/CSS/图片/manifest）都会以此为前缀，避免部署后 404。
  base: '/xulian/',
  plugins: [react()],
  resolve: {
    alias: {
      // 前端用 @ 指向 src，@shared 指向前后端共享的纯 TS 目录
      '@': path.resolve(here, 'src'),
      '@shared': path.resolve(here, 'shared'),
    },
  },
  server: {
    // host: true 让手机通过局域网 IP 也能访问（需求：手机端测试）
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      // SSE 关键点：不能用 ws（我们不用 websocket），且要保留 changeOrigin
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true,
      },
    },
  },
});
