/**
 * 元信息路由：/api/health、/api/config、/api/models（兼容保留）
 *
 * 前端启动时先拉 /api/config，拿到情绪/策略/阶段/分类的展示元数据与推送公钥，
 * 这样前端**不需要**硬编码这些数据（需求 §27.2：不做假 UI，数据一律来自后端真值）。
 */

import { Router } from 'express';
import {
  EMOTION_LIST,
  MEMORY_CATEGORY_LIST,
  STAGE_LIST,
  STRATEGY_LIST,
  APP_NAME,
  APP_TAGLINE,
  APP_VERSION,
} from '../../shared/constants.js';
import { env, isAiConfigured } from '../env.js';
import { dbHealth } from '../db/index.js';
import { asyncHandler } from '../errors.js';
import { ok } from '../http.js';
import type { ConfigResponse, HealthResponse } from '../types.js';

export const metaRoutes = Router();

/**
 * 健康检查。
 * 注意：缺 API Key 时这里返回 status='degraded' 而不是 500——
 * 前端要能区分「服务器挂了」和「AI 还没配好」。
 */
metaRoutes.get(
  '/health',
  asyncHandler((_req, res) => {
    const body: HealthResponse = {
      status: dbHealth() ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      version: APP_VERSION,
      aiConfigured: isAiConfigured(),
      ollamaConfigured: isAiConfigured(),
      database: dbHealth(),
    };
    ok(res, body);
  }),
);

/** 前端启动配置 */
metaRoutes.get(
  '/config',
  asyncHandler((_req, res) => {
    const body: ConfigResponse = {
      app: {
        name: APP_NAME,
        tagline: APP_TAGLINE,
        version: APP_VERSION,
        aiDisclosure:
          '這是一個 AI 角色，不是真人。它不會真的出現在現實世界，也不會取代你身邊的人。',
      },
      emotionMeta: EMOTION_LIST.map((e) => ({
        emotion: e.emotion,
        label: e.label,
        color: e.color,
        icon: e.icon,
      })),
      strategyMeta: STRATEGY_LIST.map((s) => ({ strategy: s.strategy, label: s.label })),
      relationshipStages: STAGE_LIST.map((s) => ({
        stage: s.stage,
        label: s.label,
        threshold: s.threshold,
      })),
      memoryCategories: MEMORY_CATEGORY_LIST,
      push: {
        vapidPublicKey: env.vapidPublicKey,
        enabled: Boolean(env.vapidPublicKey && env.vapidPrivateKey),
      },
      features: {
        proactive: env.proactiveEnabled,
        memory: true,
        push: Boolean(env.vapidPublicKey && env.vapidPrivateKey),
      },
    };
    ok(res, body);
  }),
);

/**
 * 兼容保留的模板端点（架构文档 §4.1 第 44 项）。
 * MVP 隐藏模型选择，这里只回内置列表；失败也永远返回 200，不阻塞前端。
 */
metaRoutes.get(
  '/models',
  asyncHandler((_req, res) => {
    ok(res, {
      models: [
        { modelId: env.ollamaModel, name: env.ollamaModel },
        { modelId: env.ollamaLightModel, name: env.ollamaLightModel },
      ],
      defaultModel: env.ollamaModel,
    });
  }),
);
