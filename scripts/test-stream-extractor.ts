/**
 * 流式回复提取器测试
 *
 * 覆盖：完整 JSON、data: 前缀、按单字符切分的分块 JSON、纯文本、
 *      content/text 字段、中文、换行转义、不完整 JSON、\uXXXX、围栏。
 *
 * 运行：npx tsx scripts/test-stream-extractor.ts
 */

import {
  createStreamReplyExtractor,
  parseStructuredReply,
} from '../server/services/streamReplyExtractor.js';

interface Case {
  name: string;
  chunks: string[];
  expected: string;
}

/** 按固定大小切块 */
function chunkify(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** 按单字符切块 */
function byChar(s: string): string[] {
  return s.split('');
}

/** 跑完整条流，返回拼接后的展示文本 */
function run(chunks: string[]): string {
  const ex = createStreamReplyExtractor();
  let out = '';
  for (const c of chunks) out += ex.push(c);
  out += ex.finish();
  return out;
}

const CASES: Case[] = [
  {
    name: '完整 JSON（一次性到达）',
    chunks: ['{"reply":"你好呀，今天过得怎么样？","favorability_change":2,"emotion":"warm"}'],
    expected: '你好呀，今天过得怎么样？',
  },
  {
    name: 'data: 前缀',
    chunks: ['data: {"reply":"听起来很棒呀～","favorability_change":3,"emotion":"sweet"}'],
    expected: '听起来很棒呀～',
  },
  {
    name: '按单字符切分的 JSON（跨 chunk 边界）',
    chunks: byChar('{"reply":"你好，今天过得如何？","favorability_change":1,"emotion":"warm"}'),
    expected: '你好，今天过得如何？',
  },
  {
    name: '纯文本透传（模型没按格式输出）',
    chunks: ['今天', '天气', '不错呢'],
    expected: '今天天气不错呢',
  },
  {
    name: 'content 字段',
    chunks: ['{"content":"用 content 字段也行","favorability_change":0,"emotion":"normal"}'],
    expected: '用 content 字段也行',
  },
  {
    name: 'text 字段',
    chunks: ['{"text":"用 text 字段也行","emotion":"sad"}'],
    expected: '用 text 字段也行',
  },
  {
    name: '中文 + 换行/引号转义',
    chunks: ['{"reply":"他说：\\"早安～\\"\\n然后就出门了","favorability_change":1,"emotion":"warm"}'],
    expected: '他说："早安～"\n然后就出门了',
  },
  {
    name: 'markdown 围栏包裹',
    chunks: ['```json\n{"reply":"围栏也能剥掉","emotion":"warm"}\n```'],
    expected: '围栏也能剥掉',
  },
  {
    name: '不完整 JSON（尾部截断）',
    chunks: ['{"reply":"你好，今天过得怎样？","favorability_chan'],
    expected: '你好，今天过得怎样？',
  },
  {
    name: '不完整 JSON（字符串未闭合）',
    chunks: ['{"reply":"你', '好，说到一半'],
    expected: '你好，说到一半',
  },
  {
    name: '随机切块（每 3 字符）',
    chunks: chunkify('{"reply":"随机切分也不能漏字","favorability_change":2,"emotion":"sweet"}', 3),
    expected: '随机切分也不能漏字',
  },
  {
    name: 'favorability 排在 reply 之前',
    chunks: ['{"favorability_change":-3,"emotion":"angry","reply":"你怎么现在才回我"}'],
    expected: '你怎么现在才回我',
  },
  {
    name: '\\uXXXX 转义（中文码点）',
    chunks: ['{"reply":"\\u4f60\\u597d","emotion":"warm"}'],
    expected: '你好',
  },
  {
    name: '\\uXXXX 被 chunk 切断',
    chunks: byChar('{"reply":"\\u4f60\\u597d呀","emotion":"warm"}'),
    expected: '你好呀',
  },
  {
    name: '非目标字符串字段在前（不该被当成正文）',
    chunks: ['{"note":"这不是正文","reply":"这才是正文","emotion":"normal"}'],
    expected: '这才是正文',
  },
];

// ---------------- 主流程 ----------------

let failed = 0;

console.log('='.repeat(72));
console.log('流式回复提取器测试');
console.log('='.repeat(72));

for (const c of CASES) {
  const actual = run(c.chunks);
  const ok = actual === c.expected;
  const clean = !actual.includes('{') && !actual.includes('"reply"');

  if (!ok || !clean) failed++;

  console.log(`\n[${ok && clean ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`  输入块数: ${c.chunks.length}`);
  console.log(`  期望: ${JSON.stringify(c.expected)}`);
  console.log(`  实际: ${JSON.stringify(actual)}`);
  if (!clean) console.log('  ⚠ 输出里残留 JSON 外壳（{ 或 "reply"）');
}

// ---------------- 真正流式验证 ----------------

console.log('\n' + '-'.repeat(72));
console.log('流式增量验证（必须逐字吐出，不能等 JSON 完成后一次性给）');
console.log('-'.repeat(72));

const source = '{"reply":"逐字增长测试","favorability_change":2,"emotion":"sweet"}';
const ex = createStreamReplyExtractor();
const growth: string[] = [];
let acc = '';
for (const ch of source) {
  const inc = ex.push(ch);
  if (inc) {
    acc += inc;
    growth.push(acc);
  }
}

console.log(`  逐字喂入 ${source.length} 个字符，共吐出 ${growth.length} 次增量`);
console.log(`  增量轨迹: ${growth.map((g) => JSON.stringify(g)).join(' → ')}`);

const incrementalOk = growth.length >= 5 && growth[0] === '逐';
if (!incrementalOk) failed++;
console.log(`  [${incrementalOk ? 'PASS' : 'FAIL'}] 增量轨迹逐字增长`);

// ---------------- 元数据解析验证 ----------------

console.log('\n' + '-'.repeat(72));
console.log('元数据解析（favorability_change / emotion）');
console.log('-'.repeat(72));

const meta = parseStructuredReply(
  '{"reply":"你好","favorability_change":-2,"emotion":"angry"}',
);
console.log(`  解析结果: ${JSON.stringify(meta)}`);
const metaOk = meta?.change === -2 && meta?.emotion === 'angry' && meta?.reply === '你好';
if (!metaOk) failed++;
console.log(`  [${metaOk ? 'PASS' : 'FAIL'}] 元数据解析`);

const notJson = parseStructuredReply('我就是一句普通的话');
console.log(`  纯文本输入解析: ${JSON.stringify(notJson)}（应为 null）`);
const nullOk = notJson === null;
if (!nullOk) failed++;
console.log(`  [${nullOk ? 'PASS' : 'FAIL'}] 非 JSON 返回 null`);

// ---------------- 汇总 ----------------

console.log('\n' + '='.repeat(72));
console.log(failed === 0 ? `全部通过（${CASES.length + 4} 项断言）` : `失败 ${failed} 项`);
console.log('='.repeat(72));

process.exit(failed === 0 ? 0 : 1);
