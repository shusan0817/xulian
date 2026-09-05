/**
 * 需恋 · 端到端验证脚本（Ollama 自建 AI 运行时）
 *
 * 覆盖用户要求的 9 项检查：
 *   Ollama 连接 / 真实 AI 回复 / 聊天保存 / 记忆 / 多人隔离 /
 *   IDOR 越权 / 未登录保护 / 限流 / 服务器健康
 *
 * 运行：node scripts/e2e-verify.mjs   （需 xulian 服务在 :3000 且 Ollama 在 :11434）
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const rand = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = {
  ollama: false,
  ai: false,
  chatSaved: false,
  memory: false,
  isolation: false,
  idor: false,
  unauth: false,
  ratelimit: false,
  server: false,
};

function pass(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
}

/** 统一请求封装（成功包 {ok,data} 或不包，都能取出 payload） */
async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const payload = json && json.data !== undefined ? json.data : json;
  return { status: res.status, json, payload };
}

const pl = (r) => r.payload;

/** 流式聊天：返回 { status, meta, text, error, done } */
async function streamChat(token, text, characterId) {
  const clientMessageId = `c_${Date.now()}_${rand()}`;
  const res = await fetch(BASE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, characterId, clientMessageId }),
  });
  const status = res.status;
  let meta = null, full = '', error = null, done = false;
  if (status === 200) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done: rd, value } = await reader.read();
      if (rd) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.trim();
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        let ev; try { ev = JSON.parse(p); } catch { continue; }
        if (ev.type === 'meta') meta = ev;
        else if (ev.type === 'text') full += ev.content;
        else if (ev.type === 'replace') full = ev.content;
        else if (ev.type === 'error') error = ev;
        else if (ev.type === 'done') done = true;
      }
    }
  }
  return { status, meta, full, error, done };
}

/** 仅取 /stream 的状态码（不读 body，便于立即 cancel 以触发服务端 abort） */
async function streamStatusOnly(token, text) {
  const clientMessageId = `rl_${Date.now()}_${rand()}`;
  return fetch(BASE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, clientMessageId }),
  });
}

async function main() {
  console.log(`\n🌐 目标: ${BASE}  · Ollama: ${OLLAMA}\n`);

  // ---------- 0. 服务器健康 ----------
  console.log('— 0. 服务器健康 —');
  const health = await api('GET', '/api/health');
  const dbOk = health.payload?.database === true || health.json?.database === true;
  results.server = health.status === 200 && dbOk;
  pass('服务器健康', results.server, `status=${health.status} database=${dbOk}`);

  // ---------- 1. Ollama 连接 + 模型 ----------
  console.log('\n— 1. Ollama 连接 / 模型 —');
  let ollamaOk = false, modelPresent = false;
  try {
    const r = await fetch(OLLAMA + '/api/tags');
    const j = await r.json().catch(() => ({}));
    ollamaOk = r.status === 200;
    const models = (j.models || []).map((m) => m.name);
    modelPresent = models.includes('qwen2.5:3b');
    console.log('  Ollama 状态:', r.status, '| 模型:', models.join(', ') || '(无)');
  } catch (e) {
    console.log('  Ollama 连接失败:', e.message);
  }
  results.ollama = ollamaOk && modelPresent;
  pass('Ollama 连接 + qwen2.5:3b', results.ollama);

  // ---------- 2. 注册用户 A / B ----------
  console.log('\n— 2. 注册用户 A / B —');
  const emailA = `e2e_a_${rand()}@test.local`;
  const emailB = `e2e_b_${rand()}@test.local`;
  const pw = 'Test1234!';
  const regA = await api('POST', '/api/auth/register', { body: { email: emailA, password: pw, displayName: 'E2E_A' } });
  const regB = await api('POST', '/api/auth/register', { body: { email: emailB, password: pw, displayName: 'E2E_B' } });
  const tokenA = pl(regA).token;
  const tokenB = pl(regB).token;
  pass('注册 A', regA.status === 201 && !!tokenA, `status=${regA.status}`);
  pass('注册 B', regB.status === 201 && !!tokenB, `status=${regB.status}`);
  if (!tokenA || !tokenB) { finish(); return; }

  // ---------- 3. 真实 AI 回复（A 说"你好，我叫小明"） ----------
  console.log('\n— 3. 真实 AI 回复 —');
  const chatA = await streamChat(tokenA, '你好，我叫小明');
  results.ai = chatA.status === 200 && chatA.done && !!chatA.full.trim() && !chatA.error;
  pass('AI 真实回复', results.ai,
    `status=${chatA.status} done=${chatA.done} len=${chatA.full.trim().length}` +
    (chatA.error ? ` err=${chatA.error.code}` : ''));
  if (chatA.meta) console.log('  meta:', JSON.stringify(chatA.meta));
  if (chatA.full) console.log('  AI 回复片段:', chatA.full.slice(0, 60).replace(/\n/g, ' '));
  const convA = chatA.meta?.conversationId;
  const charA = chatA.meta?.characterId;

  // ---------- 4. 聊天保存（持久化） ----------
  console.log('\n— 4. 聊天保存 —');
  let saved = false;
  if (convA) {
    const convs = await api('GET', '/api/chat/conversations', { token: tokenA });
    const ids = (pl(convs).conversations || []).map((c) => c.id);
    const has = ids.includes(convA);
    const msgs = await api('GET', `/api/chat/conversations/${convA}/messages`, { token: tokenA });
    const list = pl(msgs).messages || [];
    const userSaid = list.some((m) => m.role === 'user' && m.content.includes('小明'));
    const aiSaid = list.some((m) => m.role === 'assistant' && m.content && m.content.trim().length > 0);
    saved = has && userSaid && aiSaid;
    console.log(`  会话数=${ids.length} 含本会话=${has} 用户消息=${userSaid} 助手消息=${aiSaid}`);
  }
  results.chatSaved = saved;
  pass('聊天保存', results.chatSaved);

  // ---------- 5. 记忆正常 ----------
  console.log('\n— 5. 记忆 —');
  let memOk = false;
  if (charA) {
    const add = await api('POST', '/api/memories', { token: tokenA, body: { content: '记住：用户小明喜欢喝美式咖啡', characterId: charA } });
    const memId = pl(add).memory?.id;
    const status = await api('GET', '/api/memories/status', { token: tokenA });
    const list = await api('GET', '/api/memories', { token: tokenA });
    const total = pl(status).total ?? pl(list).total ?? 0;
    const found = (pl(list).items || []).some((m) => m.content.includes('美式咖啡'));
    memOk = add.status === 201 && total >= 1 && found;
    console.log(`  新增=${add.status} total=${total} 命中=${found} memId=${memId || '-'}`);
    // 顺手测删除
    if (memId) {
      const del = await api('DELETE', `/api/memories/${memId}`, { token: tokenA });
      console.log('  删除记忆:', del.status);
    }
  }
  results.memory = memOk;
  pass('记忆正常', results.memory);

  // ---------- 6. 用户 B 聊天，拿到 B 的会话 id ----------
  console.log('\n— 6. 用户 B 聊天（用于隔离 / IDOR 测试） —');
  const chatB = await streamChat(tokenB, '你好，我是另一个用户');
  const convB = chatB.meta?.conversationId;
  console.log(`  B 会话 id=${convB || '-'} done=${chatB.done}`);

  // ---------- 7. 多人隔离 ----------
  console.log('\n— 7. 多人隔离 —');
  const convsA = await api('GET', '/api/chat/conversations', { token: tokenA });
  const idsA = (pl(convsA).conversations || []).map((c) => c.id);
  const isolated = !!convB && !idsA.includes(convB);
  results.isolation = isolated;
  pass('多人隔离（A 看不到 B 的会话）', results.isolation, `A会话=${idsA.length} 含B=${idsA.includes(convB)}`);

  // ---------- 8. IDOR 越权 ----------
  console.log('\n— 8. IDOR 越权 —');
  const idorMsgs = await api('GET', `/api/chat/conversations/${convB}/messages`, { token: tokenA });
  // 记忆 IDOR：B 建一条记忆，A 去改
  let memBId = null;
  if (charA) {
    const addB = await api('POST', '/api/memories', { token: tokenB, body: { content: 'B的秘密记忆请勿泄露', characterId: charA } });
    memBId = pl(addB).memory?.id;
  }
  const idorMem = memBId
    ? await api('PATCH', `/api/memories/${memBId}`, { token: tokenA, body: { content: 'hacked' } })
    : { status: 0 };
  const idorPass = [403, 404].includes(idorMsgs.status) && [403, 404].includes(idorMem.status);
  results.idor = idorPass;
  pass('IDOR：跨用户读消息', [403, 404].includes(idorMsgs.status), `status=${idorMsgs.status}`);
  pass('IDOR：跨用户改记忆', [403, 404].includes(idorMem.status), `status=${idorMem.status}`);

  // ---------- 9. 未登录保护 ----------
  console.log('\n— 9. 未登录保护 —');
  const noAuthStream = await api('POST', '/api/chat/stream', { body: { text: 'hi' } });
  const noAuthConv = await api('GET', '/api/chat/conversations');
  const unauthPass = noAuthStream.status === 401 && noAuthConv.status === 401;
  results.unauth = unauthPass;
  pass('未登录 /api/chat/stream', noAuthStream.status === 401, `status=${noAuthStream.status}`);
  pass('未登录 /api/chat/conversations', noAuthConv.status === 401, `status=${noAuthConv.status}`);

  // ---------- 10. 限流 ----------
  console.log('\n— 10. 限流（并发打 /stream，期望出现 429） —');
  const N = 14;
  const reqs = [];
  for (let i = 0; i < N; i++) reqs.push(streamStatusOnly(tokenA, '限流测试'));
  const resps = await Promise.all(reqs);
  let codes = [];
  for (const r of resps) {
    codes.push(r.status);
    try { await r.body.cancel(); } catch {}
  }
  const got429 = codes.filter((c) => c === 429).length;
  const got200 = codes.filter((c) => c === 200).length;
  results.ratelimit = got429 >= 1;
  console.log(`  状态码分布: 200×${got200} 429×${got429} 其他×${codes.length - got200 - got429}`);
  pass('限流（出现 429）', results.ratelimit);

  // ---------- 收尾 ----------
  finish();
}

function finish() {
  console.log('\n════════════════════════════════════════');
  console.log('【Ollama】是否成功连接：' + (results.ollama ? '是' : '否'));
  console.log('【AI】是否真实回复：' + (results.ai ? '是' : '否'));
  console.log('【聊天】是否保存：' + (results.chatSaved ? '是' : '否'));
  console.log('【记忆】是否正常：' + (results.memory ? '是' : '否'));
  console.log('【多人隔离】是否通过：' + (results.isolation ? '是' : '否'));
  console.log('【越权测试】是否通过：' + (results.idor ? '是' : '否'));
  console.log('【未登录保护】是否通过：' + (results.unauth ? '是' : '否'));
  console.log('【限流】是否通过：' + (results.ratelimit ? '是' : '否'));
  console.log('【服务器】是否正常运行：' + (results.server ? '是' : '否'));
  console.log('════════════════════════════════════════');
  const allPass = Object.values(results).every(Boolean);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
