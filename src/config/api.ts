/**
 * 统一 API 基地址配置。
 *
 * 设计原则（对应需求：禁止在代码里散落 localhost、生产用正式 HTTPS 地址）：
 * - 同源部署（后端直接托管前端）：VITE_API_BASE_URL 留空 → API_BASE=''，
 *   所有请求走相对路径 /api/...，天然兼容 HTTPS 与任意设备/网络。
 * - 前后端分域名（如前端在 GitHub Pages、API 在 api.yourdomain.com）：
 *   构建时设 VITE_API_BASE_URL=https://api.yourdomain.com，统一在此前缀。
 *
 * 前端所有请求都必须经过 src/api/client.ts 的 buildUrl / src/api/sse.ts 的 postSse，
 * 它们会自动套用这里的 API_BASE，不要在组件里手写完整 URL。
 */

// 默认后端地址：Hugging Face Spaces 免费部署（无需域名 / 服务器）。
// GitHub Pages 只能托管静态前端，后端单独跑在 HF Spaces；
// 把“未设置 VITE_API_BASE_URL 时的默认值”直接指向 HF 后端，
// 这样公开测试版打开即为可用状态，无需再依赖 GitHub Secret（API_BASE_URL）。
// 真实 Hugging Face Space 后端网址（已替换占位符，2026-09-05）。
const HF_BACKEND_URL = 'https://shusan0817-xulian.hf.space';

export const API_BASE: string = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? HF_BACKEND_URL
).replace(/\/+$/, '');
