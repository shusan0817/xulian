#!/usr/bin/env node
/**
 * 生成 Web Push 需要的 VAPID 密钥对，并写回 .env
 *
 * 用法：
 *   npm run push:keys            生成并写入 .env
 *   npm run push:keys -- --print 只打印，不写文件
 *
 * 说明：VAPID 公钥会下发给前端（用于浏览器订阅），私钥只留在服务端，绝不进前端。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');

const printOnly = process.argv.includes('--print');

/**
 * 把键值对写进 .env（已存在则替换，不存在则追加）。
 * 保留文件中原有的注释与其它配置，避免把用户手写的内容冲掉。
 */
function upsertEnvFile(content: string, updates: Record<string, string>): string {
  const lines = content.split(/\r?\n/);
  const remaining = { ...updates };

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/i);
    if (!match) return line;
    const key = match[1] as string;
    if (!(key in remaining)) return line;
    const value = remaining[key as keyof typeof remaining] as string;
    delete remaining[key as keyof typeof remaining];
    return `${key}=${value}`;
  });

  // 没命中已有行的键，统一追加到文件末尾
  const appended = Object.entries(remaining).map(([key, value]) => `${key}=${value}`);
  return [...nextLines, ...appended].join('\n').replace(/\n{3,}$/, '\n\n');
}

/** 保证 .env 存在：没有就从 .env.example 复制一份 */
function ensureEnvFile(): string {
  if (fs.existsSync(ENV_PATH)) {
    return fs.readFileSync(ENV_PATH, 'utf8');
  }
  if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    return fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  }
  return '';
}

function main(): void {
  const keys = webpush.generateVAPIDKeys();

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Web Push VAPID 金鑰對');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log('');
  console.log('提醒：公鑰會下發給瀏覽器；私鑰只留在伺服器，請勿提交到 Git。');

  if (printOnly) {
    console.log('');
    console.log('（--print 模式：未寫入 .env）');
    return;
  }

  const before = ensureEnvFile();
  const after = upsertEnvFile(before, {
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_MAILTO: process.env.VAPID_MAILTO ?? 'mailto:your@email.com',
  });
  fs.writeFileSync(ENV_PATH, /\n$/.test(after) ? after : `${after}\n`, 'utf8');
  console.log('');
  console.log(`✓ 已寫入 ${ENV_PATH}`);
  console.log('  若 .env 是新建立的，請確認 .gitignore 已忽略它（本專案已配置）。');
}

main();
