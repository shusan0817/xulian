/**
 * 真实流式联调验证
 *
 * 直接调用真实的 streamText（Ollama / qwen2.5:3b）生成回复，
 * 用 StreamReplyExtractor 逐 chunk 处理，验证：
 *   1. 推给前端的文本是自然语言，不含 JSON 外壳
 *   2. 文本是**逐字增量**吐出的（不是等 JSON 完成后一次性给）
 *   3. 结束后能解析出 favorability_change / emotion 元数据
 *
 * 运行：npx tsx scripts/test-live-stream.ts
 */

import 'dotenv/config';
import { streamText } from '../server/agent/sdkClient.js';
import {
  createStreamReplyExtractor,
  parseStructuredReply,
} from '../server/services/streamReplyExtractor.js';

const SYSTEM_PROMPT = `你是「小需」，一個溫柔的 AI 陪伴者。用繁體中文說話，語氣自然口語，一到兩句話。

【輸出格式約束】你必須嚴格輸出 JSON 格式（不要包含 markdown 代碼塊標識），結構如下：
{
  "reply": "你對用戶說的回覆文本",
  "favorability_change": 2, // -10 到 +10 的整數，表示本次對話好感度增減
  "emotion": "sweet" // 選項：sweet(甜美/心動), warm(溫暖/日常), sad(低落/自責), angry(吃醋/生悶氣), normal(平淡)
}`;

const USER_PROMPT = '今天工作超累，但終於把拖了很久的專案做完了，超開心的！';

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('真实流式联调：streamText(Ollama) → StreamReplyExtractor');
  console.log('='.repeat(72));
  console.log(`用户说: ${USER_PROMPT}\n`);

  const extractor = createStreamReplyExtractor();
  let raw = '';
  let display = '';
  let chunks = 0;
  const trace: string[] = [];

  try {
    const iterator = streamText({
      prompt: USER_PROMPT,
      systemPrompt: SYSTEM_PROMPT,
      label: 'chat',
    });

    let next = await iterator.next();
    while (!next.done) {
      const delta = next.value.delta;
      if (delta) {
        raw += delta;
        chunks++;
        const inc = extractor.push(delta);
        if (inc) {
          display += inc;
          trace.push(inc);
        }
      }
      next = await iterator.next();
    }
    display += extractor.finish();
  } catch (err) {
    console.error('生成失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`收到 delta 块数: ${chunks}`);
  console.log(`吐出增量次数:   ${trace.length}`);
  console.log(`\n--- 模型原始输出 ---`);
  console.log(JSON.stringify(raw));
  console.log(`\n--- 推送给前端的增量轨迹（前 12 段）---`);
  console.log(trace.slice(0, 12).map((t) => JSON.stringify(t)).join(' | '));
  console.log(`\n--- 用户最终看到的文本 ---`);
  console.log(display);

  const meta = parseStructuredReply(raw);
  console.log(`\n--- done 事件里的元数据 ---`);
  console.log(JSON.stringify(meta));

  // 断言
  const clean = !display.includes('{') && !display.includes('"reply"') && !display.includes('\\"reply');
  const incremental = trace.length >= 3;
  const nonEmpty = display.trim().length > 0;

  console.log(`\n${'-'.repeat(72)}`);
  console.log(`[${clean ? 'PASS' : 'FAIL'}] 展示文本不含 JSON 外壳`);
  console.log(`[${incremental ? 'PASS' : 'FAIL'}] 增量式吐出（${trace.length} 段，>=3）`);
  console.log(`[${nonEmpty ? 'PASS' : 'FAIL'}] 展示文本非空`);
  console.log('-'.repeat(72));

  process.exit(clean && incremental && nonEmpty ? 0 : 1);
}

void main();
