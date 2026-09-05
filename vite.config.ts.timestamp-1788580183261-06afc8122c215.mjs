// vite.config.ts
import { defineConfig } from "file:///D:/%E9%9C%80%E6%81%8B/xulian/node_modules/vite/dist/node/index.js";
import react from "file:///D:/%E9%9C%80%E6%81%8B/xulian/node_modules/@vitejs/plugin-react/dist/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
var __vite_injected_original_import_meta_url = "file:///D:/%E9%9C%80%E6%81%8B/xulian/vite.config.ts";
var here = path.dirname(fileURLToPath(__vite_injected_original_import_meta_url));
var vite_config_default = defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 前端用 @ 指向 src，@shared 指向前后端共享的纯 TS 目录
      "@": path.resolve(here, "src"),
      "@shared": path.resolve(here, "shared")
    }
  },
  server: {
    // host: true 让手机通过局域网 IP 也能访问（需求：手机端测试）
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      // SSE 关键点：不能用 ws（我们不用 websocket），且要保留 changeOrigin
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        ws: false
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: false
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJEOlxcXFxcdTk3MDBcdTYwNEJcXFxceHVsaWFuXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJEOlxcXFxcdTk3MDBcdTYwNEJcXFxceHVsaWFuXFxcXHZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9EOi8lRTklOUMlODAlRTYlODElOEIveHVsaWFuL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnO1xuaW1wb3J0IHBhdGggZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICdub2RlOnVybCc7XG5cbmNvbnN0IGhlcmUgPSBwYXRoLmRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgcGx1Z2luczogW3JlYWN0KCldLFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IHtcbiAgICAgIC8vIFx1NTI0RFx1N0FFRlx1NzUyOCBAIFx1NjMwN1x1NTQxMSBzcmNcdUZGMENAc2hhcmVkIFx1NjMwN1x1NTQxMVx1NTI0RFx1NTQwRVx1N0FFRlx1NTE3MVx1NEVBQlx1NzY4NFx1N0VBRiBUUyBcdTc2RUVcdTVGNTVcbiAgICAgICdAJzogcGF0aC5yZXNvbHZlKGhlcmUsICdzcmMnKSxcbiAgICAgICdAc2hhcmVkJzogcGF0aC5yZXNvbHZlKGhlcmUsICdzaGFyZWQnKSxcbiAgICB9LFxuICB9LFxuICBzZXJ2ZXI6IHtcbiAgICAvLyBob3N0OiB0cnVlIFx1OEJBOVx1NjI0Qlx1NjczQVx1OTAxQVx1OEZDN1x1NUM0MFx1NTdERlx1N0Y1MSBJUCBcdTRFNUZcdTgwRkRcdThCQkZcdTk1RUVcdUZGMDhcdTk3MDBcdTZDNDJcdUZGMUFcdTYyNEJcdTY3M0FcdTdBRUZcdTZENEJcdThCRDVcdUZGMDlcbiAgICBob3N0OiB0cnVlLFxuICAgIHBvcnQ6IDUxNzMsXG4gICAgc3RyaWN0UG9ydDogZmFsc2UsXG4gICAgcHJveHk6IHtcbiAgICAgIC8vIFNTRSBcdTUxNzNcdTk1MkVcdTcwQjlcdUZGMUFcdTRFMERcdTgwRkRcdTc1Mjggd3NcdUZGMDhcdTYyMTFcdTRFRUNcdTRFMERcdTc1Mjggd2Vic29ja2V0XHVGRjA5XHVGRjBDXHU0RTE0XHU4OTgxXHU0RkREXHU3NTU5IGNoYW5nZU9yaWdpblxuICAgICAgJy9hcGknOiB7XG4gICAgICAgIHRhcmdldDogJ2h0dHA6Ly9sb2NhbGhvc3Q6MzAwMCcsXG4gICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgICAgd3M6IGZhbHNlLFxuICAgICAgfSxcbiAgICB9LFxuICB9LFxuICBidWlsZDoge1xuICAgIG91dERpcjogJ2Rpc3QnLFxuICAgIHNvdXJjZW1hcDogZmFsc2UsXG4gIH0sXG4gIGNzczoge1xuICAgIHByZXByb2Nlc3Nvck9wdGlvbnM6IHtcbiAgICAgIGxlc3M6IHtcbiAgICAgICAgamF2YXNjcmlwdEVuYWJsZWQ6IHRydWUsXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBNE8sU0FBUyxvQkFBb0I7QUFDelEsT0FBTyxXQUFXO0FBQ2xCLE9BQU8sVUFBVTtBQUNqQixTQUFTLHFCQUFxQjtBQUh1RyxJQUFNLDJDQUEyQztBQUt0TCxJQUFNLE9BQU8sS0FBSyxRQUFRLGNBQWMsd0NBQWUsQ0FBQztBQUV4RCxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTLENBQUMsTUFBTSxDQUFDO0FBQUEsRUFDakIsU0FBUztBQUFBLElBQ1AsT0FBTztBQUFBO0FBQUEsTUFFTCxLQUFLLEtBQUssUUFBUSxNQUFNLEtBQUs7QUFBQSxNQUM3QixXQUFXLEtBQUssUUFBUSxNQUFNLFFBQVE7QUFBQSxJQUN4QztBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVE7QUFBQTtBQUFBLElBRU4sTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sWUFBWTtBQUFBLElBQ1osT0FBTztBQUFBO0FBQUEsTUFFTCxRQUFRO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixjQUFjO0FBQUEsUUFDZCxJQUFJO0FBQUEsTUFDTjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxPQUFPO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsRUFDYjtBQUFBLEVBQ0EsS0FBSztBQUFBLElBQ0gscUJBQXFCO0FBQUEsTUFDbkIsTUFBTTtBQUFBLFFBQ0osbUJBQW1CO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
