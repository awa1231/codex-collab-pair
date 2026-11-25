#!/usr/bin/env node

const threadId = process.env.CODEX_THREAD_ID?.trim() ?? '';
const payload = {
  threadId: threadId || null,
  cwd: process.cwd(),
  platform: process.platform,
  codexSessionId: process.env.CODEX_SESSION_ID?.trim() || null,
};

if (payload.threadId === null) {
  process.stderr.write('CODEX_THREAD_ID is unavailable in this shell.\n');
  process.exitCode = 1;
}

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
