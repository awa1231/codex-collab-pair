#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function defaultStatePath() {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(codexHome, 'collab-pair', 'todos.json');
}

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

function emptyState() {
  return { version: 1, threads: {} };
}

function loadState(path) {
  if (!existsSync(path)) return emptyState();
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyState();
    return {
      version: 1,
      threads: value.threads !== null && typeof value.threads === 'object' ? value.threads : {},
    };
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      writeFileSync(backup, readFileSync(path));
    } catch {
      // Continue with a fresh state even if the backup cannot be written.
    }
    return emptyState();
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function threadBucket(state, threadId) {
  const existing = state.threads[threadId];
  if (existing !== null && typeof existing === 'object' && Array.isArray(existing.items)) {
    return existing;
  }
  const bucket = { items: [], updatedAt: Date.now() };
  state.threads[threadId] = bucket;
  return bucket;
}

function cleanItem(item) {
  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    status: item.status,
    createdAt: item.createdAt,
    startedAt: item.startedAt ?? null,
    doneAt: item.doneAt ?? null,
  };
}

function summary(items) {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    running: items.filter((item) => item.status === 'running').length,
    done: items.filter((item) => item.status === 'done').length,
  };
}

function requireThread(args) {
  const threadId = typeof args.thread === 'string' ? args.thread.trim() : '';
  if (threadId === '') throw new Error('--thread is required');
  return threadId;
}

function requireText(value, name, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new Error(`--${name} is required`);
  return text.slice(0, maxLength);
}

function run(args) {
  const statePath = process.env.COLLAB_PAIR_TODO_PATH?.trim() || defaultStatePath();
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'list';
  const threadId = requireThread(args);
  const state = loadState(statePath);
  const bucket = threadBucket(state, threadId);

  if (action === 'add') {
    const item = {
      id: `todo-${randomUUID().slice(0, 8)}`,
      title: requireText(args.title, 'title', 200),
      prompt: requireText(args.prompt, 'prompt', 10000),
      status: 'pending',
      createdAt: Date.now(),
    };
    bucket.items.push(item);
    bucket.updatedAt = Date.now();
    saveState(statePath, state);
    return { ok: true, action, statePath, item: cleanItem(item), summary: summary(bucket.items) };
  }

  if (action === 'list') {
    return {
      ok: true,
      action,
      statePath,
      threadId,
      items: bucket.items.map(cleanItem),
      summary: summary(bucket.items),
    };
  }

  if (action === 'next') {
    let item = bucket.items.find((candidate) => candidate.status === 'running');
    if (item === undefined) {
      item = bucket.items.find((candidate) => candidate.status === 'pending');
      if (item !== undefined) {
        item.status = 'running';
        item.startedAt = Date.now();
      }
    }
    bucket.updatedAt = Date.now();
    saveState(statePath, state);
    return {
      ok: true,
      action,
      statePath,
      item: item === undefined ? null : cleanItem(item),
      summary: summary(bucket.items),
      message: item === undefined ? 'No pending todo items.' : 'Execute this todo now.',
    };
  }

  if (action === 'done') {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const item = id !== ''
      ? bucket.items.find((candidate) => candidate.id === id)
      : bucket.items.findLast((candidate) => candidate.status === 'running');
    if (item === undefined) throw new Error('No running todo item found');
    item.status = 'done';
    item.doneAt = Date.now();
    bucket.updatedAt = Date.now();
    saveState(statePath, state);
    return { ok: true, action, statePath, item: cleanItem(item), summary: summary(bucket.items) };
  }

  if (action === 'remove') {
    const id = requireText(args.id, 'id', 100);
    const before = bucket.items.length;
    bucket.items = bucket.items.filter((item) => item.id !== id);
    if (bucket.items.length === before) throw new Error(`Todo item not found: ${id}`);
    bucket.updatedAt = Date.now();
    saveState(statePath, state);
    return { ok: true, action, statePath, removed: id, summary: summary(bucket.items) };
  }

  if (action === 'clear') {
    const scope = typeof args.scope === 'string' ? args.scope : 'pending';
    if (!['pending', 'done', 'all'].includes(scope)) {
      throw new Error('--scope must be pending, done, or all');
    }
    bucket.items = scope === 'all'
      ? []
      : bucket.items.filter((item) => (
          scope === 'pending'
            ? item.status !== 'pending'
            : item.status !== 'done'
        ));
    bucket.updatedAt = Date.now();
    saveState(statePath, state);
    return { ok: true, action, statePath, scope, summary: summary(bucket.items) };
  }

  throw new Error(`Unknown action: ${action}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = run(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
