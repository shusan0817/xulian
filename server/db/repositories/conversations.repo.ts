/**
 * conversations / messages 数据访问
 *
 * 所有函数首参为 userId。
 * 跨表写操作（写消息 + 更新会话计数）统一放在 `db.transaction()` 里，
 * 保证「消息落库了但会话计数没更新」这类中间态不会出现。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { newId, nowIso } from '../helpers.js';
import type { MessagePage } from '../../types.js';
import type {
  Conversation,
  MessageMeta,
  MessageRecord,
  MessageRole,
} from '../../../shared/types.js';
import type { EmotionType, StrategyType } from '../../../shared/constants.js';
import { MAX_MESSAGE_PAGE_SIZE } from '../../../shared/constants.js';

// ============================================================
// 行 → 实体
// ============================================================

export interface ConversationRow {
  id: string;
  user_id: string;
  character_id: string;
  title: string;
  summary: string;
  summary_updated_to: string | null;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  character_id: string | null;
  role: string;
  content: string;
  ai_emotion: string | null;
  ai_emotion_intensity: number | null;
  strategy: string | null;
  user_emotion: string | null;
  is_proactive: number;
  is_read: number;
  error_code: string | null;
  meta: string;
  created_at: string;
}

export function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    title: row.title,
    summary: row.summary,
    summaryUpdatedTo: row.summary_updated_to,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    characterId: row.character_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    aiEmotion: row.ai_emotion as EmotionType | null,
    aiEmotionIntensity: row.ai_emotion_intensity,
    strategy: row.strategy as StrategyType | null,
    userEmotion: row.user_emotion as EmotionType | null,
    isProactive: row.is_proactive === 1,
    isRead: row.is_read === 1,
    errorCode: row.error_code,
    meta: jsonGet<MessageMeta>(row.meta, {}, 'messages.meta'),
    createdAt: row.created_at,
  };
}

// ============================================================
// 会话
// ============================================================

/** 取单个会话 */
export function getConversation(userId: string, conversationId: string): Conversation | null {
  const row = db
    .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId) as ConversationRow | undefined;
  return row ? rowToConversation(row) : null;
}

export interface ListConversationsOptions {
  characterId?: string;
  limit?: number;
}

/** 列出会话（按最后一条消息时间倒序） */
export function listConversations(
  userId: string,
  options: ListConversationsOptions = {},
): Conversation[] {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = options.characterId
    ? (db
        .prepare(
          'SELECT * FROM conversations WHERE user_id = ? AND character_id = ? ' +
            'ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT ?',
        )
        .all(userId, options.characterId, limit) as ConversationRow[])
    : (db
        .prepare(
          'SELECT * FROM conversations WHERE user_id = ? ' +
            'ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT ?',
        )
        .all(userId, limit) as ConversationRow[]);
  return rows.map(rowToConversation);
}

/** 新建会话 */
export function createConversation(
  userId: string,
  characterId: string,
  title = '',
): Conversation {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO conversations (id, user_id, character_id, title, summary, summary_updated_to,
                                message_count, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', NULL, 0, NULL, ?, ?)`,
  ).run(id, userId, characterId, title, now, now);
  const created = getConversation(userId, id);
  if (!created) throw new Error(`[DB] 建立會話後讀不回來：${id}`);
  return created;
}

/**
 * 取该角色「当前」会话：有就复用，没有就新建。
 * MVP 一个角色只维护一条主线会话（需求里没有多会话的诉求）。
 */
export function findOrCreateActive(userId: string, characterId: string): Conversation {
  const row = db
    .prepare(
      'SELECT * FROM conversations WHERE user_id = ? AND character_id = ? ' +
        'ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT 1',
    )
    .get(userId, characterId) as ConversationRow | undefined;
  return row ? rowToConversation(row) : createConversation(userId, characterId);
}

export type ConversationPatch = Partial<
  Pick<Conversation, 'title' | 'summary' | 'summaryUpdatedTo' | 'messageCount' | 'lastMessageAt'>
>;

/** 更新会话字段（滚动摘要、消息计数等） */
export function updateConversation(
  userId: string,
  conversationId: string,
  patch: ConversationPatch,
): Conversation | null {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.title !== undefined) {
    fields.push('title = ?');
    values.push(patch.title);
  }
  if (patch.summary !== undefined) {
    fields.push('summary = ?');
    values.push(patch.summary);
  }
  if (patch.summaryUpdatedTo !== undefined) {
    fields.push('summary_updated_to = ?');
    values.push(patch.summaryUpdatedTo);
  }
  if (patch.messageCount !== undefined) {
    fields.push('message_count = ?');
    values.push(Math.max(0, Math.trunc(patch.messageCount)));
  }
  if (patch.lastMessageAt !== undefined) {
    fields.push('last_message_at = ?');
    values.push(patch.lastMessageAt);
  }
  if (fields.length === 0) return getConversation(userId, conversationId);

  fields.push('updated_at = ?');
  values.push(nowIso(), conversationId, userId);
  db.prepare(
    `UPDATE conversations SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
  ).run(...values);
  return getConversation(userId, conversationId);
}

/** 删除会话（消息靠外键级联删除） */
export function deleteConversation(userId: string, conversationId: string): boolean {
  const result = db
    .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
    .run(conversationId, userId);
  return result.changes > 0;
}

// ============================================================
// 消息
// ============================================================

export interface InsertMessageInput {
  conversationId: string;
  characterId: string | null;
  role: MessageRole;
  content: string;
  aiEmotion?: EmotionType | null;
  aiEmotionIntensity?: number | null;
  strategy?: StrategyType | null;
  userEmotion?: EmotionType | null;
  isProactive?: boolean;
  isRead?: boolean;
  errorCode?: string | null;
  meta?: MessageMeta;
  id?: string;
  createdAt?: string;
  /** 前端幂等去重用的客户端消息 id（同一 id 重复提交会被 chatService 拦截） */
  clientMessageId?: string | null;
}

/**
 * 写入一条消息，并同步会话的消息计数与最后消息时间。
 * 两件事放同一个事务：否则刷新页面时可能出现"消息在、计数不对"的抖动。
 */
export function insertMessage(userId: string, input: InsertMessageInput): MessageRecord {
  const id = input.id ?? newId();
  const createdAt = input.createdAt ?? nowIso();

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, user_id, character_id, role, content,
                             ai_emotion, ai_emotion_intensity, strategy, user_emotion,
                             is_proactive, is_read, error_code, meta, created_at, client_message_id)
       VALUES (@id, @conversation_id, @user_id, @character_id, @role, @content,
               @ai_emotion, @ai_emotion_intensity, @strategy, @user_emotion,
               @is_proactive, @is_read, @error_code, @meta, @created_at, @client_message_id)`,
    ).run({
      id,
      conversation_id: input.conversationId,
      user_id: userId,
      character_id: input.characterId,
      role: input.role,
      content: input.content,
      ai_emotion: input.aiEmotion ?? null,
      ai_emotion_intensity: input.aiEmotionIntensity ?? null,
      strategy: input.strategy ?? null,
      user_emotion: input.userEmotion ?? null,
      is_proactive: input.isProactive ? 1 : 0,
      is_read: input.isRead === false ? 0 : 1,
      error_code: input.errorCode ?? null,
      meta: JSON.stringify(input.meta ?? {}),
      created_at: createdAt,
      client_message_id: input.clientMessageId ?? null,
    });

    db.prepare(
      `UPDATE conversations
          SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
              last_message_at = ?,
              updated_at = ?
        WHERE id = ? AND user_id = ?`,
    ).run(input.conversationId, createdAt, nowIso(), input.conversationId, userId);
  });

  run();
  const created = getMessage(userId, id);
  if (!created) throw new Error(`[DB] 寫入訊息後讀不回來：${id}`);
  return created;
}

/** 按 ID 取消息 */
export function getMessage(userId: string, messageId: string): MessageRecord | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?')
    .get(messageId, userId) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

/**
 * 按客户端消息 id 取消息（userId 作用域隔离，多租户安全）。
 * 用于 chatService 的幂等去重：同一 clientMessageId 重复提交时直接命中已有消息。
 */
export function getMessageByClientId(
  userId: string,
  clientMessageId: string,
): MessageRecord | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE user_id = ? AND client_message_id = ? LIMIT 1')
    .get(userId, clientMessageId) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

export interface ListMessagesOptions {
  limit?: number;
  /** 游标：只取 created_at < before 的消息（向前翻页） */
  before?: string;
}

/**
 * 分页取消息。
 * 实现：先按时间倒序取 limit+1 条判断是否还有更多，再正序返回（符合聊天界面的阅读顺序）。
 */
export function listMessages(
  userId: string,
  conversationId: string,
  options: ListMessagesOptions = {},
): MessagePage {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), MAX_MESSAGE_PAGE_SIZE);
  const rows = options.before
    ? (db
        .prepare(
          'SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? AND created_at < ? ' +
            'ORDER BY created_at DESC LIMIT ?',
        )
        .all(conversationId, userId, options.before, limit + 1) as MessageRow[])
    : (db
        .prepare(
          'SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ' +
            'ORDER BY created_at DESC LIMIT ?',
        )
        .all(conversationId, userId, limit + 1) as MessageRow[]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { messages: page.reverse().map(rowToMessage), hasMore };
}

/**
 * 取最近 N 条消息（正序）。
 * 用于组装短期上下文与情绪趋势判断。
 */
export function listRecentMessages(
  userId: string,
  conversationId: string,
  limit = 20,
): MessageRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE conversation_id = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT ?
       ) ORDER BY created_at ASC`,
    )
    .all(conversationId, userId, Math.min(Math.max(limit, 1), 200)) as MessageRow[];
  return rows.map(rowToMessage);
}

/** 取会话里的最后一条消息（首页预览用） */
export function getLastMessage(
  userId: string,
  conversationId: string,
): MessageRecord | null {
  const row = db
    .prepare(
      'SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(conversationId, userId) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

/** 统计某个角色收到的用户消息总数（记忆兜底抽取用） */
export function countUserMessages(userId: string, characterId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND character_id = ? AND role = 'user'",
    )
    .get(userId, characterId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 更新消息内容（重新生成是覆盖式的，见决策 11） */
export function updateMessage(
  userId: string,
  messageId: string,
  patch: Partial<Pick<MessageRecord, 'content' | 'aiEmotion' | 'aiEmotionIntensity' | 'strategy' | 'userEmotion' | 'errorCode' | 'meta'>>,
): MessageRecord | null {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.content !== undefined) {
    fields.push('content = ?');
    values.push(patch.content);
  }
  if (patch.aiEmotion !== undefined) {
    fields.push('ai_emotion = ?');
    values.push(patch.aiEmotion);
  }
  if (patch.aiEmotionIntensity !== undefined) {
    fields.push('ai_emotion_intensity = ?');
    values.push(patch.aiEmotionIntensity);
  }
  if (patch.strategy !== undefined) {
    fields.push('strategy = ?');
    values.push(patch.strategy);
  }
  if (patch.userEmotion !== undefined) {
    fields.push('user_emotion = ?');
    values.push(patch.userEmotion);
  }
  if (patch.errorCode !== undefined) {
    fields.push('error_code = ?');
    values.push(patch.errorCode);
  }
  if (patch.meta !== undefined) {
    fields.push('meta = ?');
    values.push(JSON.stringify(patch.meta));
  }
  if (fields.length === 0) return getMessage(userId, messageId);

  values.push(messageId, userId);
  db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(
    ...values,
  );
  return getMessage(userId, messageId);
}

/** 删除单条消息 */
export function deleteMessage(userId: string, messageId: string): boolean {
  const result = db
    .prepare('DELETE FROM messages WHERE id = ? AND user_id = ?')
    .run(messageId, userId);
  return result.changes > 0;
}

/** 批量标记已读（主动消息收件箱用） */
export function markRead(userId: string, messageIds: string[]): number {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => '?').join(',');
  const result = db
    .prepare(
      `UPDATE messages SET is_read = 1 WHERE user_id = ? AND id IN (${placeholders})`,
    )
    .run(userId, ...messageIds);
  return result.changes;
}

/** 拉取未读的主动消息（App 打开时的保底触达，见决策 15） */
export function listUnreadProactive(userId: string, limit = 20): MessageRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE user_id = ? AND is_proactive = 1 AND is_read = 0
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 100)) as MessageRow[];
  // 倒序取出后正序返回，方便 UI 直接按时间线渲染
  return rows.reverse().map(rowToMessage);
}

/** 统计某个角色的未读主动消息数 */
export function countUnreadProactive(userId: string, characterId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE user_id = ? AND character_id = ? AND is_proactive = 1 AND is_read = 0`,
    )
    .get(userId, characterId) as { n: number } | undefined;
  return row?.n ?? 0;
}
