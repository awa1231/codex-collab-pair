#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function findCodex() {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (configured && existsSync(configured)) return configured;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const threadId = typeof args.thread === 'string' ? args.thread.trim() : '';
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (threadId === '') throw new Error('--thread is required');
  if (message === '') throw new Error('--message is required');

  const result = spawnSync(
    findCodex(),
    ['queue', '--thread', threadId, '--message', message],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: process.env,
      timeout: 30000,
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `codex queue exited with ${result.status}`);
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!/queued message/i.test(output)) {
    throw new Error(output || 'Codex did not confirm that the message was queued');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    threadId,
    output,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
