#!/usr/bin/env node

const sessionId = process.env.CODEX_SESSION_ID?.trim() || '';
const threadId = process.env.CODEX_THREAD_ID?.trim() || sessionId;
const payload = {
  threadId: threadId || null,
  codexSessionId: sessionId || null,
};

if (payload.threadId === null) {
  process.stderr.write('CODEX_THREAD_ID is unavailable in this shell.\n');
  process.exitCode = 1;
}

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
