/**
 * AI 供应商选择（门面层唯一依赖点）。
 *
 * 本项目只使用自建的 Ollama 运行时：baseUrl / model 全部来自服务端 env，
 * 前端不可见、不可覆盖（需求：用户不必填任何 AI Key，也不能指定模型）。
 *
 * 实例做了缓存：env 在启动时即固定，重复调用不会反复 new / 反复打日志。
 */

import { env } from '../env.js';
import type { AIProvider } from './types.js';
import { OllamaProvider } from './ollamaProvider.js';
import { OpenAICompatibleProvider } from './openaiProvider.js';

let cached: AIProvider | null = null;

export function getAIProvider(): AIProvider {
  if (cached) return cached;
  // 云端 LLM 路径：Groq / Gemini 等 OpenAI 兼容接口，无需本地 Ollama
  if (env.aiProvider === 'openai') {
    cached = new OpenAICompatibleProvider(
      env.openaiBaseUrl,
      env.openaiApiKey,
      env.openaiModel,
      env.openaiLightModel,
      env.aiTimeoutMs,
    );
    return cached;
  }
  // 默认：本地自建 Ollama 运行时
  cached = new OllamaProvider(
    env.ollamaBaseUrl,
    env.ollamaModel,
    env.ollamaLightModel,
    env.aiTimeoutMs,
  );
  return cached;
}

export type { AIProvider, ChatMessage, AIStreamOptions, AIErrorCode, AIProviderError } from './types.js';
