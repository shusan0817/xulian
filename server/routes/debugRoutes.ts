/**
 * 调试路由（仅 ENABLE_DEBUG_ROUTES=true 时挂载）。
 *
 * /api/debug/ai-ping：用服务端**真实**环境变量（baseUrl / apiKey / model）直接打一次
 * Groq，把原始 HTTP 状态码、响应体片段、以及任何 fetch 报错原样回传。
 * 用途：排查「AI 服務暫時連不上 (E_AI_UNAVAILABLE)」时，确认到底是
 *   - 网络层连不上 Groq（fetch 抛错），还是
 *   - Groq 返回了非 2xx（Key 无效 / 模型不存在 / 配额耗尽）。
 * 生产环境务必将 ENABLE_DEBUG_ROUTES 设为 false，移除该端点。
 */

import { Router } from 'express';
import { env } from '../env.js';
import { asyncHandler } from '../errors.js';

export const debugRoutes = Router();

debugRoutes.get(
  '/ai-ping',
  asyncHandler(async (_req, res) => {
    const baseUrl = env.openaiBaseUrl.replace(/\/+$/, '');
    const key = env.openaiApiKey;
    const model = env.openaiModel;
    const out: Record<string, unknown> = {
      provider: env.aiProvider,
      baseUrl,
      model,
      keyPresent: Boolean(key),
      keyLength: key ? key.length : 0,
      keyPrefix: key ? key.slice(0, 6) : '',
    };

    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      out.httpStatus = r.status;
      out.bodySnippet = text.slice(0, 600);
    } catch (err) {
      out.fetchError = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && 'cause' in err) {
        out.fetchCause = String((err as { cause?: unknown }).cause);
      }
    }

    res.json({ ok: true, data: out });
  }),
);
