/**
 * 角色路由（需求 §3 / §17 角色创建与编辑）
 *
 * 注意挂载顺序：`/presets` 必须排在 `/:id` 之前，
 * 否则 Express 会把 "presets" 当成角色 ID 匹配掉。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import { isAiConfigured } from '../env.js';
import { completeText } from '../agent/sdkClient.js';
import * as personaService from '../services/personaService.js';
import * as charactersRepo from '../db/repositories/characters.repo.js';
import * as growthService from '../services/growthService.js';
import { buildRuntime } from './userRoutes.js';
import { logger } from '../logger.js';

export const characterRoutes = Router();

characterRoutes.use(resolveUser);

/** 预设模板列表（给角色创建页展示，无需身份校验也可看，但保持一致性仍走 resolveUser） */
characterRoutes.get(
  '/presets',
  asyncHandler((_req, res) => {
    ok(res, { presets: personaService.listPresets() });
  }),
);

/** 角色列表（含运行态：情绪 / 关系 / 未读主动消息） */
characterRoutes.get(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characters = personaService.listCharacters(userId).map((c) => ({
      ...c,
      runtime: buildRuntime(userId, c.id),
    }));
    ok(res, { characters });
  }),
);

/** 创建角色：body 里带 presetKey 走模板，否则按自定义字段创建 */
characterRoutes.post(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const presetKey = typeof body.presetKey === 'string' ? body.presetKey : null;

    const character = presetKey
      ? personaService.createFromPreset(userId, presetKey)
      : personaService.createCharacter(userId, body as never);

    ok(res, { character: { ...character, runtime: buildRuntime(userId, character.id) } }, 201);
  }),
);

/** 单个角色 */
characterRoutes.get(
  '/:characterId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const character = personaService.getCharacter(userId, req.params.characterId);
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');
    ok(res, { character: { ...character, runtime: buildRuntime(userId, character.id) } });
  }),
);

/** AI 成長展示快照（唯讀，成長頁用）。兩段路徑，不與 POST/:characterId 衝突 */
characterRoutes.get(
  '/:characterId/growth',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    ok(res, { growth: growthService.getGrowth(userId, req.params.characterId) });
  }),
);

/** 编辑角色 */
characterRoutes.patch(
  '/:characterId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const character = personaService.updateCharacter(
      userId,
      req.params.characterId,
      (req.body ?? {}) as never,
    );
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');
    ok(res, { character });
  }),
);

/** 删除角色（级联删除会话、消息、记忆、情绪态、关系态） */
characterRoutes.delete(
  '/:characterId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const success = personaService.deleteCharacter(userId, req.params.characterId);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');

    // 删光了就补一个默认角色，避免用户无角色可用
    const remaining = charactersRepo.listByUser(userId);
    if (!remaining.length) personaService.bootstrapDefaultCharacter(userId);

    logger.info('[Character] 角色已刪除', { characterId: req.params.characterId });
    ok(res, { success: true });
  }),
);

/** 设为默认角色 */
characterRoutes.post(
  '/:characterId/default',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const character = personaService.setDefaultCharacter(userId, req.params.characterId);
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');
    ok(res, { character });
  }),
);

/**
 * 纪念日里程碑的 AI 专属问候（需求：里程碑问候改为 AI 真实生成）。
 *
 * 前端在命中里程碑（相识 100 天 / 週年 / 自定义生日等）当天，调用本接口拿到一句
 * 「以角色口吻、针对今天这个纪念日」的问候。若后端未配置 AI、或生成失败，
 * 一律回传 `{ greeting: null }`，让前端回落到本地预写的温暖文案（绝不让彩蛋卡住）。
 */
characterRoutes.post(
  '/:characterId/anniversary-greeting',
  asyncHandler(async (req, res) => {
    const userId = requireUserId(req);
    const character = personaService.getCharacter(userId, req.params.characterId);
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');

    // 未配置 AI：直接回落，不浪费一次调用与等待
    if (!isAiConfigured()) {
      ok(res, { greeting: null });
      return;
    }

    const body = (req.body ?? {}) as { type?: unknown; label?: unknown; days?: unknown };
    const type = body.type === 'custom' ? 'custom' : 'meet';
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : '今天';
    const days = typeof body.days === 'number' && Number.isFinite(body.days) ? body.days : 0;

    try {
      const result = await completeText({
        systemPrompt: buildAnniversarySystemPrompt(character),
        prompt: buildAnniversaryUserPrompt(type, label, days),
        temperatureHint: 'creative',
        label: 'anniversary-greeting',
      });
      const greeting = (result.text || '').trim().slice(0, 200);
      ok(res, { greeting: greeting || null });
    } catch (err) {
      logger.warn('[Character] 紀念日 AI 問候生成失敗，前端將走預寫文案', {
        characterId: character.id,
        message: err instanceof Error ? err.message : String(err),
      });
      ok(res, { greeting: null });
    }
  }),
);

/** 把角色人格拼成系统提示词，让 AI 用 TA 的口吻说话 */
function buildAnniversarySystemPrompt(character: {
  name: string;
  personality?: string;
  speakingStyle?: string;
  userNickname?: string;
}): string {
  const lines = [
    `你是 AI 陪伴角色「${character.name}」，請全程用「${character.name}」的第一人稱視角說話。`,
    `性格：${character.personality || '溫柔、體貼、會認真聽人說話'}`,
  ];
  if (character.speakingStyle) lines.push(`說話風格：${character.speakingStyle}`);
  if (character.userNickname) lines.push(`你平時稱呼對方為「${character.userNickname}」。`);
  lines.push(
    '',
    '任務：今天是你们之间的一个纪念日，请对使用者说一句温暖、真诚、像真人朋友会说的祝福或问候。',
    '要求：',
    '- 第一人稱，語氣貼合上面的性格與說話風格；',
    '- 只輸出這一句話，不要解釋、不要引號、不要 markdown；',
    '- 長度控制在 1~2 句（不超過 60 字）；',
    '- 可以適度帶一點節日氣氛，但保持自然、不誇張、不油膩；',
    '- 不要用英文、不要出現 "milestone"、"anniversary" 等內部術語；',
    '- 自然地把今天這個日子說出來（例如「今天是我們相識 100 天」），不要照抄指令裡的標籤字。',
  );
  return lines.join('\n');
}

/** 把里程碑信息拼成用户提示词 */
function buildAnniversaryUserPrompt(
  type: 'meet' | 'custom',
  label: string,
  days: number,
): string {
  return type === 'meet'
    ? `今天是你们相识满 ${days} 天（也就是「${label}」）。请用角色口吻，对使用者说一句温暖的问候，自然地提到这个日子。`
    : `今天是使用者设定的纪念日「${label}」。请用角色口吻，对使用者说一句温暖的问候。`;
}
