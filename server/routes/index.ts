/**
 * 路由汇总挂载
 *
 * 新增路由模块时：在这里 import 并 mount 一次即可，不要散落到 server/index.ts。
 * 挂载顺序有讲究：更具体的路径要放在参数化路径之前（Express 4 按注册顺序匹配）。
 */

import { Router } from 'express';
import { env } from '../env.js';
import { metaRoutes } from './metaRoutes.js';
import { authRoutes } from './authRoutes.js';
import { userRoutes } from './userRoutes.js';
import { characterRoutes } from './characterRoutes.js';
import { chatRoutes } from './chatRoutes.js';
import { memoryRoutes } from './memoryRoutes.js';
import { proactiveRoutes } from './proactiveRoutes.js';
import { pushRoutes } from './pushRoutes.js';
import { debugRoutes } from './debugRoutes.js';

export const apiRoutes = Router();

// ---- 元信息（无需登录）----
apiRoutes.use(metaRoutes);

// ---- 认证（register / login / status 无需登录，其余需要会话）----
apiRoutes.use('/auth', authRoutes);

// ---- 用户（bootstrap 不需要身份，内部按需处理）----
apiRoutes.use('/users', userRoutes);

// ---- 角色 ----
apiRoutes.use('/characters', characterRoutes);

// ---- 聊天 / 会话 / 消息 ----
apiRoutes.use('/chat', chatRoutes);

// ---- 长期记忆 ----
apiRoutes.use('/memories', memoryRoutes);

// ---- 主动聊天 ----
apiRoutes.use('/proactive', proactiveRoutes);

// ---- 推送与在线状态 ----
apiRoutes.use('/push', pushRoutes);

// ---- 调试（仅 ENABLE_DEBUG_ROUTES=true 时挂载；生产请关闭，避免泄露 env 信息）----
if (env.enableDebugRoutes) {
  apiRoutes.use('/debug', debugRoutes);
}

export { metaRoutes };
