-- ============================================================
-- 需恋 SQLite Schema v1
-- 约定：
--   * 所有时间列为 ISO 8601 UTC 字符串（2026-09-04T12:34:56.789Z）
--   * 所有 JSON 列用 TEXT 存，读写时 JSON.stringify / parse
--   * day 列为「用户时区 YYYY-MM-DD」
--   * 布尔用 INTEGER 0/1
-- 本文件用 db.exec() 一次性执行，全部带 IF NOT EXISTS，可重复执行（幂等）
-- ============================================================

-- 0. schema 版本（迁移用）
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 1. 用户 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  display_name           TEXT NOT NULL DEFAULT '',
  avatar                 TEXT,
  timezone               TEXT NOT NULL DEFAULT 'Asia/Taipei',
  locale                 TEXT NOT NULL DEFAULT 'zh-TW',
  settings               TEXT NOT NULL DEFAULT '{}',   -- JSON UserSettings
  notification_settings  TEXT NOT NULL DEFAULT '{}',   -- JSON {pushEnabled, soundEnabled}
  privacy_settings       TEXT NOT NULL DEFAULT '{}',   -- JSON {longTermMemoryEnabled, saveChatHistory, analyticsEnabled}
  last_seen_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- 2. AI 角色 -------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_characters (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  avatar              TEXT NOT NULL DEFAULT '{}',      -- JSON AvatarSpec
  personality         TEXT NOT NULL DEFAULT '',
  personality_tags    TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  speaking_style      TEXT NOT NULL DEFAULT '',
  interests           TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  liked_topics        TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  disliked_topics     TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  relationship_type   TEXT NOT NULL DEFAULT 'friend',
  user_nickname       TEXT NOT NULL DEFAULT '',
  ai_self_name        TEXT NOT NULL DEFAULT '',
  reply_length        TEXT NOT NULL DEFAULT 'medium',  -- short|medium|long
  emotion_sensitivity REAL NOT NULL DEFAULT 0.5,       -- 0..1
  initial_emotion     TEXT NOT NULL DEFAULT 'calm',
  initial_stage       TEXT NOT NULL DEFAULT 'stranger',
  proactivity_level   REAL NOT NULL DEFAULT 0.5,       -- 0..1
  proactive_enabled   INTEGER NOT NULL DEFAULT 1,
  proactive_settings  TEXT NOT NULL DEFAULT '{}',      -- JSON ProactiveSettings
  slider_playfulness  REAL NOT NULL DEFAULT 0.5,
  slider_humor        REAL NOT NULL DEFAULT 0.5,
  slider_verbosity    REAL NOT NULL DEFAULT 0.5,
  slider_proactivity  REAL NOT NULL DEFAULT 0.5,
  slider_rationality REAL NOT NULL DEFAULT 0.5,
  slider_listening    REAL NOT NULL DEFAULT 0.5,
  custom_description  TEXT NOT NULL DEFAULT '',
  is_default          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_user ON ai_characters(user_id, updated_at DESC);

-- 3. 会话 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT '',
  summary           TEXT NOT NULL DEFAULT '',      -- 滚动摘要（短期记忆压缩）
  summary_updated_to TEXT,                         -- 摘要覆盖到的最后 message_id
  message_count     INTEGER NOT NULL DEFAULT 0,
  last_message_at   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user_char ON conversations(user_id, character_id, updated_at DESC);

-- 4. 消息 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id         TEXT REFERENCES ai_characters(id) ON DELETE SET NULL,
  role                 TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content              TEXT NOT NULL,
  ai_emotion           TEXT,                        -- assistant：生成时的 AI 情绪
  ai_emotion_intensity REAL,
  strategy             TEXT,                        -- assistant：使用的策略
  user_emotion         TEXT,                        -- assistant：对应的用户情绪判定
  is_proactive         INTEGER NOT NULL DEFAULT 0,
  is_read              INTEGER NOT NULL DEFAULT 1,  -- 主动消息：用户是否已读
  error_code           TEXT,
  meta                 TEXT NOT NULL DEFAULT '{}',  -- JSON {usage, memoryRefs[], safetyFlags[], intent}
  created_at           TEXT NOT NULL,
  client_message_id    TEXT                        -- 前端幂等去重用的客户端消息 id（L0 安全/幂等）
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_created   ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_user_proactive ON messages(user_id, is_proactive, is_read, created_at DESC);

-- 5. 长期记忆 ------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  content           TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL,                  -- sha1(category + normalize(content)[0:24])
  importance        REAL NOT NULL DEFAULT 0.5,      -- 0..1
  is_sensitive      INTEGER NOT NULL DEFAULT 0,
  source_message_id TEXT,
  hit_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (user_id, character_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_mem_user_char     ON memories(user_id, character_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_mem_user_category ON memories(user_id, character_id, category);

-- 6. AI 情绪状态 ---------------------------------------------
CREATE TABLE IF NOT EXISTS emotion_states (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  current_emotion TEXT NOT NULL DEFAULT 'calm',
  intensity       REAL NOT NULL DEFAULT 0.30,
  valence         REAL NOT NULL DEFAULT 0.0,
  arousal         REAL NOT NULL DEFAULT 0.20,
  emotion_reason  TEXT NOT NULL DEFAULT '',
  last_decay_at   TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, character_id)
);

-- 7. 用户情绪分析 --------------------------------------------
CREATE TABLE IF NOT EXISTS user_emotion_analyses (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id       TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id         TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emotion            TEXT NOT NULL,
  valence            REAL NOT NULL DEFAULT 0,
  intensity          REAL NOT NULL DEFAULT 0,
  confidence         REAL NOT NULL DEFAULT 0,
  trend              TEXT NOT NULL DEFAULT 'stable',       -- improving|stable|worsening
  intent             TEXT NOT NULL DEFAULT 'chitchat',
  needs_comfort      INTEGER NOT NULL DEFAULT 0,
  crisis_signal      TEXT NOT NULL DEFAULT 'none',         -- none|mild|severe
  suggested_strategy TEXT,
  share_depth        REAL NOT NULL DEFAULT 0,
  reasons            TEXT NOT NULL DEFAULT '[]',           -- JSON string[]
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uea_user_char_time ON user_emotion_analyses(user_id, character_id, created_at DESC);

-- 8. 关系状态 ------------------------------------------------
CREATE TABLE IF NOT EXISTS relationship_states (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id         TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL DEFAULT 'stranger',
  interaction_level    REAL NOT NULL DEFAULT 0,
  message_score        REAL NOT NULL DEFAULT 0,
  active_day_score     REAL NOT NULL DEFAULT 0,
  memory_score         REAL NOT NULL DEFAULT 0,
  share_depth_score    REAL NOT NULL DEFAULT 0,
  total_user_messages  INTEGER NOT NULL DEFAULT 0,
  distinct_active_days INTEGER NOT NULL DEFAULT 0,
  floor_stage          TEXT NOT NULL DEFAULT 'stranger',   -- 用户设定的永不下限
  last_interaction_at  TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (user_id, character_id)
);

-- 8b. 独立活跃天（用于 active_day_score，只增不减）
CREATE TABLE IF NOT EXISTS active_days (
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  day          TEXT NOT NULL,                 -- 用户时区 YYYY-MM-DD
  PRIMARY KEY (user_id, character_id, day)
);

-- 9. 主动消息任务 --------------------------------------------
CREATE TABLE IF NOT EXISTS proactive_message_tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
                -- pending|scheduled|sending|sent|failed|skipped|expired
  decision      TEXT NOT NULL DEFAULT 'skip',     -- skip|delay|send
  score         REAL NOT NULL DEFAULT 0,
  reason_code   TEXT NOT NULL DEFAULT '',
  reason_detail TEXT NOT NULL DEFAULT '{}',       -- JSON DecisionDetail
  scheduled_at  TEXT,
  message_id    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pmt_user_status ON proactive_message_tasks(user_id, character_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_pmt_due         ON proactive_message_tasks(status, scheduled_at);

-- 10. 幂等运行锁（Scheduler）---------------------------------
CREATE TABLE IF NOT EXISTS proactive_runs (
  id           TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  window_key   TEXT NOT NULL,                     -- 'YYYY-MM-DDTHH:M'（10 分钟粒度）
  status       TEXT NOT NULL DEFAULT 'running',   -- running|done|failed
  created_at   TEXT NOT NULL,
  UNIQUE (character_id, window_key)
);

-- 11. 每日发送计数（频控）------------------------------------
CREATE TABLE IF NOT EXISTS proactive_daily_counters (
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  day          TEXT NOT NULL,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, character_id, day)
);

-- 12. 推送订阅 -----------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- 13. 安全日志 -----------------------------------------------
CREATE TABLE IF NOT EXISTS safety_logs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  character_id TEXT,
  direction    TEXT NOT NULL,                   -- incoming|outgoing|proactive
  rule         TEXT NOT NULL,
  action       TEXT NOT NULL,                   -- blocked|rewritten|flagged|crisis
  severity     TEXT NOT NULL DEFAULT 'info',    -- info|warn|block
  excerpt      TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safety_time ON safety_logs(created_at DESC);

-- ============================================================
-- 以下为 V2 新增表（设计文档 §2.2）
-- 迁移约定：新表用 CREATE TABLE IF NOT EXISTS 直接写在本文件（每次启动幂等执行），
--           现有表的 ALTER 一律写进 migrations.ts 的 version 2，用 addColumnIfMissing 包裹。
-- ============================================================

-- 14. 认证凭据 -----------------------------------------------
-- 与 users 严格 1:1。注册时复用当前匿名 users 行 → 老用户零数据迁移。
CREATE TABLE IF NOT EXISTS user_auth (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email               TEXT NOT NULL UNIQUE,
  email_normalized    TEXT NOT NULL UNIQUE,        -- lower(trim(email))，防大小写重复注册
  phone               TEXT,                        -- 预留：P3 手机号登录，当前恒为 NULL
  password_hash       TEXT NOT NULL,               -- 自描述格式 'scrypt$N$r$p$saltB64$hashB64'
  password_algo       TEXT NOT NULL DEFAULT 'scrypt-16384-8-1',  -- 未来可调参数而不必重算全库
  password_updated_at TEXT NOT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,                        -- 暴力破解保护：连续失败 10 次锁 15 分钟
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_userauth_locked ON user_auth(locked_until);

-- 15. 会话 ---------------------------------------------------
-- token = base64url(payload) + "." + base64url(HMAC_SHA256(payload, SESSION_SECRET))
-- 这里只存 sha256(token)，绝不存明文（无状态验签 + 有状态吊销，双保险）。
CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,               -- sha256(token)
  user_agent   TEXT,
  ip_prefix    TEXT,                               -- 仅存前 3 段（脱敏），不存完整 IP
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,                      -- 滑动续期：活跃则后延，上限 30 天
  revoked_at   TEXT,                               -- 登出 / 改密码 / 封禁时置位
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sess_user    ON user_sessions(user_id, revoked_at, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_sess_expires ON user_sessions(expires_at);

-- 16. 我们的故事（V2-2）--------------------------------------
CREATE TABLE IF NOT EXISTS stories (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id       TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,
                     -- first_chat | user_shared | shared_milestone
                     -- | user_saved | habit_learned | special_interaction
  title              TEXT NOT NULL,               -- 当前生效标题
  summary            TEXT NOT NULL,               -- 当前生效摘要（≤200 字）
  auto_title         TEXT NOT NULL DEFAULT '',    -- 自动生成原文，用户改过后可「还原」
  auto_summary       TEXT NOT NULL DEFAULT '',
  is_user_edited     INTEGER NOT NULL DEFAULT 0,
  is_user_created    INTEGER NOT NULL DEFAULT 0,  -- 用户手动创建（type=user_saved）
  importance         REAL NOT NULL DEFAULT 0.5,   -- 0..1，超上限时按此归档
  source_type        TEXT NOT NULL DEFAULT 'auto',-- auto(rule) | llm | user | habit
  source_message_ids TEXT NOT NULL DEFAULT '[]',  -- JSON string[]，★V2-2「必须可追溯来源」
  source_memory_id   TEXT,
  source_habit_id    TEXT,
  happened_at        TEXT NOT NULL,               -- 故事发生的时刻（≠ 创建时刻）
  pinned             INTEGER NOT NULL DEFAULT 0,
  deleted_at         TEXT,                        -- 软删除（云端同步预留）
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_time  ON stories(user_id, character_id, deleted_at, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_type  ON stories(user_id, character_id, type, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_rank  ON stories(user_id, deleted_at, pinned DESC, importance DESC);

-- 17. AI 了解的你（V2-3）-------------------------------------
CREATE TABLE IF NOT EXISTS user_insights (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ★ 避坑 D5：SQLite 的 UNIQUE 对 NULL 不去重，必须用 '' 而非 NULL 表示「全域」
  character_scope   TEXT NOT NULL DEFAULT '',   -- '' = 全域偏好；否则 = 某个 character_id
  dimension         TEXT NOT NULL,              -- 白名单，见 shared/constants.ts
  value             TEXT NOT NULL,              -- 枚举值（受控）
  value_label       TEXT NOT NULL,              -- 展示用繁中标签
  confidence        REAL NOT NULL DEFAULT 0,    -- 0..1，≥0.6 才 active
  observation_count INTEGER NOT NULL DEFAULT 0, -- ≥3 才 active
  evidence          TEXT NOT NULL DEFAULT '[]', -- JSON [{messageId,quote,at}]，可溯源
  source            TEXT NOT NULL DEFAULT 'auto', -- auto | user | imported
  is_user_edited    INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'candidate', -- candidate | active | rejected
  deleted_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (user_id, character_scope, dimension)   -- 一个维度一条，更新而非堆叠
);
CREATE INDEX IF NOT EXISTS idx_insights_live ON user_insights(user_id, character_scope, status, confidence DESC);

-- 18. AI 后天形成的交流习惯（V2-4）---------------------------
CREATE TABLE IF NOT EXISTS ai_habits (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id       TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  dimension          TEXT NOT NULL,              -- 白名单 5 维，见 shared/constants.ts
  value              TEXT NOT NULL,              -- 受控值（枚举 或 已验证短语）
  value_label        TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 0,
  observation_count  INTEGER NOT NULL DEFAULT 0, -- ≥3 且 confidence ≥0.6 才进 Prompt
  miss_count         INTEGER NOT NULL DEFAULT 0, -- 连续未复现次数，≥5 自动降级
  evidence           TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'candidate', -- candidate | active | archived
  user_confirmed     INTEGER NOT NULL DEFAULT 0, -- 用户手动确认 → 直接 active 且不被自动降级
  persona_check      TEXT NOT NULL DEFAULT 'pending',   -- pending|passed|rejected（★ 闸门 C）
  persona_check_note TEXT NOT NULL DEFAULT '',
  story_id           TEXT,                       -- 关联的「AI 学会的交流习惯」故事
  deleted_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (user_id, character_id, dimension, value)
);
CREATE INDEX IF NOT EXISTS idx_habits_live ON ai_habits(user_id, character_id, status, confidence DESC);

-- 19. 用户反馈与举报（V2-14）---------------------------------
CREATE TABLE IF NOT EXISTS message_feedback (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id    TEXT REFERENCES ai_characters(id) ON DELETE SET NULL,
  conversation_id TEXT,
  -- message_id 故意不加 FK：消息被删后反馈仍需留存做安全分析
  message_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
                  -- not_interesting | inappropriate | incorrect | unsafe | report
  reason          TEXT NOT NULL DEFAULT '',      -- 用户补充文字（report 时必填）
  handled         INTEGER NOT NULL DEFAULT 0,
  handled_at      TEXT,
  handled_note    TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  UNIQUE (user_id, message_id, kind)             -- 同一条消息同一类型只能反馈一次
);
CREATE INDEX IF NOT EXISTS idx_fb_message ON message_feedback(message_id, kind);
CREATE INDEX IF NOT EXISTS idx_fb_open    ON message_feedback(handled, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fb_user    ON message_feedback(user_id, created_at DESC);

-- 20. 情绪趋势日快照（V2-7）----------------------------------
-- 只存原始聚合值，不存任何「分数」「指数」「诊断」；
-- 定性描述在读时由纯函数派生，禁止出现百分比（T09 实现）。
CREATE TABLE IF NOT EXISTS emotion_trend_snapshots (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id       TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  day                TEXT NOT NULL,              -- 用户时区 YYYY-MM-DD
  message_count      INTEGER NOT NULL DEFAULT 0, -- 「聊天频率变化」
  session_count      INTEGER NOT NULL DEFAULT 0,
  avg_user_msg_chars REAL NOT NULL DEFAULT 0,    -- 「最近回复明显变短」
  avg_valence        REAL NOT NULL DEFAULT 0,    -- 「表达积极/消极程度变化」
  avg_intensity      REAL NOT NULL DEFAULT 0,
  negative_ratio     REAL NOT NULL DEFAULT 0,
  dominant_emotion   TEXT,                       -- 「语气发生变化」
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (user_id, character_id, day)
);
CREATE INDEX IF NOT EXISTS idx_trend_day ON emotion_trend_snapshots(user_id, character_id, day DESC);
