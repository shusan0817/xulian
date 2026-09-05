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

export const API_BASE: string = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
).replace(/\/+$/, '');
