#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'collab_pair';
const SERVER_VERSION = '1.4.0';
const PROTOCOL_VERSION = '2025-06-18';
const DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_PORT = 43157;
const DASHBOARD_URL = `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/`;
const NATIVE_WINDOW_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'native_window.py');
const APP_RESOURCE_URI = 'ui://collab-pair/dashboard.html';
const APP_RESOURCE_MIME = 'text/html;profile=mcp-app';
const APP_RESOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'dist', 'mcp-app.html');
const ACTIVE = 'active';
const DONE = 'done';
const REPORT_STATUSES = new Set(['done', 'partial', 'blocked']);

const DEFAULT_CONFIG = Object.freeze({
  maxRounds: 0,
  maxRelayChars: 12000,
  maxHistory: 20,
  notifyWorkerOnDone: true,
  autoRelay: true,
  autoSend: true,
  language: 'zh',
  autoNudge: true,
  nudgeAfterMinutes: 20,
  maxNudges: 3,
  addPrefix: true,
  prefixManager: '【项目经理】',
  prefixWorker: '【员工】',
});

class CollabError extends Error {}

function clampInt(candidate, min, max, fallback) {
  const number = typeof candidate === 'number' ? candidate : Number(candidate);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function prefixText(candidate, fallback) {
  if (typeof candidate !== 'string') return fallback;
  const value = candidate.trim();
  if (value === '') return fallback;
  return value.length > 24 ? value.slice(0, 24) : value;
}

function normalizeConfig(value, base = DEFAULT_CONFIG) {
  const raw = value !== null && typeof value === 'object' ? value : {};
  const merged = { ...base, ...raw };
  return {
    maxRounds: clampInt(merged.maxRounds, 0, 200, 0),
    maxRelayChars: clampInt(merged.maxRelayChars, 500, 100000, 12000),
    maxHistory: clampInt(merged.maxHistory, 1, 100, 20),
    notifyWorkerOnDone: merged.notifyWorkerOnDone !== false,
    autoRelay: merged.autoRelay !== false,
    autoSend: merged.autoSend !== false,
    language: merged.language === 'en' ? 'en' : 'zh',
    autoNudge: merged.autoNudge !== false,
    nudgeAfterMinutes: clampInt(merged.nudgeAfterMinutes, 5, 1440, 20),
    maxNudges: clampInt(merged.maxNudges, 1, 20, 3),
    addPrefix: merged.addPrefix !== false,
    prefixManager: prefixText(merged.prefixManager, '【项目经理】'),
    prefixWorker: prefixText(merged.prefixWorker, '【员工】'),
  };
}

function safeDeviceName(candidate, fallback = hostname()) {
  const value = typeof candidate === 'string' ? candidate.trim() : '';
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized.slice(0, 64) || fallback.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'codex-device';
}

function safeAlias(candidate) {
  const value = typeof candidate === 'string' ? candidate.trim() : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '';
}

function normalizeHubUrl(candidate) {
  const value = typeof candidate === 'string' ? candidate.trim().replace(/\/+$/, '') : '';
  if (value === '') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

function relayReady(relay) {
  return relay.hubUrl !== '' && relay.hubToken !== '';
}

function defaultRelay() {
  return {
    hubUrl: normalizeHubUrl(process.env.COLLAB_HUB_URL),
    hubToken: typeof process.env.COLLAB_HUB_TOKEN === 'string'
      ? process.env.COLLAB_HUB_TOKEN.trim()
      : '',
    hubRoom: /^[A-Za-z0-9_-]{1,64}$/.test(process.env.COLLAB_HUB_ROOM ?? '')
      ? process.env.COLLAB_HUB_ROOM
      : 'default',
    deviceName: safeDeviceName(process.env.COLLAB_DEVICE_NAME),
    cursor: 0,
    lastPollAt: 0,
    lastError: null,
  };
}

function clip(text, limit) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 40))}\n…（已截断，共 ${value.length} 字符）`;
}

function isoTime(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function defaultStatePath() {
  const codexHome = process.env.CODEX_HOME?.trim();
  const root = codexHome && codexHome !== '' ? codexHome : join(homedir(), '.codex');
  return join(root, 'collab-pair', 'state.json');
}

function emptyState() {
  return {
    version: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    managers: {},
    links: {},
    relay: defaultRelay(),
    aliases: {},
    remoteInbound: {},
  };
}

function normalizeManager(value, threadId) {
  const raw = value !== null && typeof value === 'object' ? value : {};
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : threadId;
  const config = normalizeConfig(raw.config);
  const projectName = typeof raw.projectName === 'string' && raw.projectName.trim() !== ''
    ? raw.projectName.trim().slice(0, 120)
    : stripKnownPrefix(title, config) || title;
  return {
    threadId,
    title,
    projectName,
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    config,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function normalizeReport(value) {
  if (value === null || typeof value !== 'object') return null;
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (summary === '') return null;
  return {
    summary,
    status: REPORT_STATUSES.has(value.status) ? value.status : 'partial',
    details: typeof value.details === 'string' ? value.details.trim() : '',
    next: typeof value.next === 'string' ? value.next.trim() : '',
    reportedAt: Number.isFinite(value.reportedAt) ? value.reportedAt : Date.now(),
  };
}

function normalizePending(value) {
  if (value === null || typeof value !== 'object') return null;
  if (!Number.isSafeInteger(value.round) || value.round < 1) return null;
  if (typeof value.task !== 'string' || value.task.trim() === '') return null;
  return {
    round: value.round,
    task: value.task,
    acceptance: typeof value.acceptance === 'string' ? value.acceptance : '',
    dispatchedAt: Number.isFinite(value.dispatchedAt) ? value.dispatchedAt : Date.now(),
    report: normalizeReport(value.report),
  };
}

function normalizeLink(value, id) {
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.manager !== 'string' || typeof value.worker !== 'string') return null;
  if (value.manager === value.worker) return null;
  const remote = value.remote !== null && typeof value.remote === 'object'
    && typeof value.remote.device === 'string'
    && typeof value.remote.alias === 'string'
    ? {
        device: safeDeviceName(value.remote.device),
        alias: safeAlias(value.remote.alias),
        label: typeof value.remote.label === 'string' && value.remote.label.trim() !== ''
          ? value.remote.label.trim().slice(0, 120)
          : `${value.remote.alias}@${value.remote.device}`,
        lastError: typeof value.remote.lastError === 'string' ? value.remote.lastError : null,
      }
    : null;
  return {
    id,
    manager: value.manager,
    worker: value.worker,
    managerTitle: typeof value.managerTitle === 'string' ? value.managerTitle : value.manager,
    workerTitle: typeof value.workerTitle === 'string' ? value.workerTitle : value.worker,
    goal: typeof value.goal === 'string' ? value.goal : '',
    mode: value.mode === 'permanent' ? 'permanent' : 'temporary',
    remote: remote !== null && remote.alias !== '' ? remote : null,
    status: value.status === DONE ? DONE : ACTIVE,
    round: Number.isSafeInteger(value.round) && value.round >= 0 ? value.round : 0,
    pending: normalizePending(value.pending),
    lastReport: normalizeReport(value.lastReport),
    history: Array.isArray(value.history) ? value.history : [],
    nudges: Number.isSafeInteger(value.nudges) && value.nudges >= 0 ? value.nudges : 0,
    lastNudgeAt: Number.isFinite(value.lastNudgeAt) ? value.lastNudgeAt : undefined,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    closedAt: Number.isFinite(value.closedAt) ? value.closedAt : undefined,
    finalSummary: typeof value.finalSummary === 'string' ? value.finalSummary : undefined,
  };
}

function normalizeAlias(value, alias) {
  if (value === null || typeof value !== 'object') return null;
  const safe = safeAlias(alias);
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  if (safe === '' || sessionId === '') return null;
  return {
    alias: safe,
    sessionId,
    title: typeof value.title === 'string' && value.title.trim() !== '' ? value.title.trim() : sessionId,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}

function normalizeInbound(value, key) {
  if (value === null || typeof value !== 'object') return null;
  const linkId = typeof value.linkId === 'string' ? value.linkId : '';
  const managerDevice = safeDeviceName(value.managerDevice);
  const alias = safeAlias(value.alias);
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : key;
  if (linkId === '' || alias === '' || sessionId === '') return null;
  return {
    sessionId,
    alias,
    managerDevice,
    managerThreadId: typeof value.managerThreadId === 'string' ? value.managerThreadId : '',
    linkId,
    round: Number.isSafeInteger(value.round) && value.round > 0 ? value.round : 1,
    task: typeof value.task === 'string' ? value.task : '',
    acceptance: typeof value.acceptance === 'string' ? value.acceptance : '',
    projectName: typeof value.projectName === 'string' ? value.projectName : '',
    goal: typeof value.goal === 'string' ? value.goal : '',
    managerTitle: typeof value.managerTitle === 'string' ? value.managerTitle : managerDevice,
    language: value.language === 'en' ? 'en' : 'zh',
    dispatchedAt: Number.isFinite(value.dispatchedAt) ? value.dispatchedAt : Date.now(),
    reportedAt: Number.isFinite(value.reportedAt) ? value.reportedAt : undefined,
  };
}

function normalizeRelay(value) {
  const fallback = defaultRelay();
  const raw = value !== null && typeof value === 'object' ? value : {};
  return {
    hubUrl: normalizeHubUrl(raw.hubUrl) || fallback.hubUrl,
    hubToken: typeof raw.hubToken === 'string' && raw.hubToken.trim() !== ''
      ? raw.hubToken.trim()
      : fallback.hubToken,
    hubRoom: /^[A-Za-z0-9_-]{1,64}$/.test(raw.hubRoom ?? '')
      ? raw.hubRoom
      : fallback.hubRoom,
    deviceName: safeDeviceName(raw.deviceName, fallback.deviceName),
    cursor: Number.isSafeInteger(raw.cursor) && raw.cursor >= 0 ? raw.cursor : 0,
    lastPollAt: Number.isFinite(raw.lastPollAt) ? raw.lastPollAt : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
  };
}

function normalizeState(value) {
  if (value === null || typeof value !== 'object') throw new CollabError('state root must be an object');
  const state = emptyState();
  state.version = 2;
  state.createdAt = Number.isFinite(value.createdAt) ? value.createdAt : state.createdAt;
  state.updatedAt = Number.isFinite(value.updatedAt) ? value.updatedAt : state.updatedAt;
  if (value.managers !== null && typeof value.managers === 'object' && !Array.isArray(value.managers)) {
    for (const [threadId, manager] of Object.entries(value.managers)) {
      if (typeof threadId === 'string' && threadId !== '') {
        state.managers[threadId] = normalizeManager(manager, threadId);
      }
    }
  }
  if (value.links !== null && typeof value.links === 'object' && !Array.isArray(value.links)) {
    for (const [linkId, link] of Object.entries(value.links)) {
      if (typeof linkId === 'string' && linkId !== '') {
        const normalized = normalizeLink(link, linkId);
        if (normalized !== null) state.links[linkId] = normalized;
      }
    }
  }
  state.relay = normalizeRelay(value.relay);
  if (value.aliases !== null && typeof value.aliases === 'object' && !Array.isArray(value.aliases)) {
    for (const [alias, record] of Object.entries(value.aliases)) {
      const normalized = normalizeAlias(record, alias);
      if (normalized !== null) state.aliases[alias] = normalized;
    }
  }
  if (
    value.remoteInbound !== null
    && typeof value.remoteInbound === 'object'
    && !Array.isArray(value.remoteInbound)
  ) {
    for (const [sessionId, record] of Object.entries(value.remoteInbound)) {
      const normalized = normalizeInbound(record, sessionId);
      if (normalized !== null) state.remoteInbound[sessionId] = normalized;
    }
  }
  return state;
}

function stripKnownPrefix(title, config) {
  const value = typeof title === 'string' ? title.trim() : '';
  for (const prefix of new Set([config.prefixManager, config.prefixWorker])) {
    if (prefix !== '' && value.startsWith(prefix)) {
      return value.slice(prefix.length).trimStart();
    }
  }
  return value;
}

function statusText(status, language) {
  if (language === 'en') {
    if (status === 'done') return 'done';
    if (status === 'partial') return 'partially done';
    if (status === 'blocked') return 'blocked, needs a decision';
    if (status === 'unreported') return 'no explicit report';
    return 'unknown';
  }
  if (status === 'done') return '完成';
  if (status === 'partial') return '部分完成';
  if (status === 'blocked') return '受阻，需要决策';
  if (status === 'unreported') return '未显式汇报';
  return '未知';
}

function dispatchText(manager, link, pending) {
  const english = manager.config.language === 'en';
  const goal = link.goal || manager.goal;
  if (english) {
    const lines = [
      `[Collaboration task · Round ${pending.round}]`,
      '',
      `worker_thread_id: ${link.worker}`,
      'Use $collab-pair in worker role.',
      '',
    ];
    if (goal) lines.push(`Project goal: ${goal}`, '');
    lines.push(
      '— Task —',
      pending.task,
      '',
      '— Acceptance criteria —',
      pending.acceptance || '(not specified; check completeness against the task)',
      '',
      '— Delivery —',
      '1. Execute this round directly; do not change direction or expand scope.',
      `2. Before ending, call collab_report with worker_thread_id="${link.worker}", round=${pending.round}, status (done/partial/blocked), summary, details, and next.`,
      '3. Make the final response a concise deliverable or verification summary. The manager will collect it after this turn ends.',
      `[[collab-pair:${link.id}:r${pending.round}:dispatch]]`,
    );
    return lines.join('\n');
  }
  const lines = [
    `【协作任务 · 第 ${pending.round} 轮】`,
    '',
    `worker_thread_id：${link.worker}`,
    '请使用 $collab-pair 的员工模式。',
    '',
  ];
  if (goal) lines.push(`项目目标：${goal}`, '');
  lines.push(
    '—— 本轮任务 ——',
    pending.task,
    '',
    '—— 验收标准 ——',
    pending.acceptance || '（未指定；按任务目标自行检查交付完整性）',
    '',
    '—— 交付要求 ——',
    '1. 直接执行本轮任务，不要改变项目大方向，也不要扩大到任务之外。',
    `2. 结束前调用 collab_report：worker_thread_id="${link.worker}"、round=${pending.round}、status（done/partial/blocked）、summary、details、next。`,
    '3. 最终回复写成简洁的交付说明或验证结论；本轮结束后项目经理会读取并记录它。',
    `[[collab-pair:${link.id}:r${pending.round}:dispatch]]`,
  );
  return lines.join('\n');
}

function managerReportText(manager, link, completed, finalOutput, turnReason) {
  const english = manager.config.language === 'en';
  const report = completed.report;
  const label = statusText(report?.status ?? 'unreported', manager.config.language);
  if (english) {
    const lines = [
      `[Collaboration report · Round ${completed.round}]`,
      `Worker: ${link.workerTitle || link.worker} (${link.worker})`,
      `Status: ${label}`,
      `Turn ended: ${turnReason || 'completed'}`,
      '',
    ];
    if (report) {
      lines.push('— Worker report —', report.summary);
      if (report.details) lines.push('', 'Details:', report.details);
      if (report.next) lines.push('', `Worker suggestion: ${report.next}`);
      lines.push('');
    } else {
      lines.push('— Worker report —', '(no explicit collab_report was recorded)', '');
    }
    lines.push(
      '— Final output —',
      finalOutput || '(no readable final text output)',
      '',
      '— Manager decision —',
      `Review against the acceptance criteria. Continue with round ${completed.round + 1}, or close this worker with collab_done.`,
      `[[collab-pair:${link.id}:r${completed.round}:report]]`,
    );
    return lines.join('\n');
  }
  const lines = [
    `【协作回报 · 第 ${completed.round} 轮】`,
    `来自员工：${link.workerTitle || link.worker}（${link.worker}）`,
    `本轮状态：${label}`,
    `结束原因：${turnReason || '正常结束'}`,
    '',
  ];
  if (report) {
    lines.push('—— 员工汇报 ——', report.summary);
    if (report.details) lines.push('', '细节：', report.details);
    if (report.next) lines.push('', `员工建议：${report.next}`);
    lines.push('');
  } else {
    lines.push('—— 员工汇报 ——', '（员工未调用 collab_report）', '');
  }
  lines.push(
    '—— 员工最终产出 ——',
    finalOutput || '（没有可读取的最终文字产出）',
    '',
    '—— 下一步 ——',
    `按验收标准审阅。继续则派发第 ${completed.round + 1} 轮；完成则调用 collab_done 收尾。`,
    `[[collab-pair:${link.id}:r${completed.round}:report]]`,
  );
  return lines.join('\n');
}

function doneText(summary, language) {
  if (language === 'en') {
    return [
      '[Collaboration finished]',
      'The project manager confirmed this worker is complete.',
      '',
      `Project summary: ${summary || '(none)'}`,
      '',
      'Do not start new rounds or call collaboration tools. If work remains unfinished, stop and state the current status.',
    ].join('\n');
  }
  return [
    '【协作结束】',
    '项目经理已确认该员工的协作完成。',
    '',
    `项目总结：${summary || '（无）'}`,
    '',
    '不要再执行新的轮次，也不要再调用协作工具；如仍有未完成工作，请停止并说明当前状态。',
  ].join('\n');
}

function unlinkText(reason, actor, language) {
  const zh = actor === 'worker'
    ? ['【协作结束】', '员工已退出本次协作。']
    : ['【协作结束】', '项目经理已解除本次协作。'];
  const en = actor === 'worker'
    ? ['[Collaboration finished]', 'The worker left this collaboration.']
    : ['[Collaboration finished]', 'The project manager removed this collaboration link.'];
  const lines = language === 'en' ? en : zh;
  if (typeof reason === 'string' && reason.trim() !== '') {
    lines.push('', `${language === 'en' ? 'Reason' : '原因'}：${reason.trim()}`);
  }
  return lines.join('\n');
}

function titleUpdatesFor(manager, workerId, workerTitle) {
  const config = manager.config;
  if (!config.addPrefix) return [];
  const managerBase = stripKnownPrefix(manager.title, config) || manager.title;
  const workerBase = stripKnownPrefix(workerTitle, config) || workerTitle;
  return [
    {
      threadId: manager.threadId,
      currentTitle: manager.title,
      nextTitle: `${config.prefixManager}${managerBase}`,
    },
    {
      threadId: workerId,
      currentTitle: workerTitle,
      nextTitle: `${config.prefixWorker}${workerBase}`,
    },
  ];
}

function titleCleanupFor(manager, link, removeManagerPrefix) {
  const config = manager.config;
  if (!config.addPrefix) return [];
  const updates = [];
  if (removeManagerPrefix && manager.title.startsWith(config.prefixManager)) {
    updates.push({
      threadId: manager.threadId,
      currentTitle: manager.title,
      nextTitle: stripKnownPrefix(manager.title, config) || manager.threadId,
    });
  }
  if ((link.workerTitle || '').startsWith(config.prefixWorker)) {
    updates.push({
      threadId: link.worker,
      currentTitle: link.workerTitle,
      nextTitle: stripKnownPrefix(link.workerTitle, config) || link.worker,
    });
  }
  return updates;
}

function remoteDispatchText(inbound) {
  const english = inbound.language === 'en';
  const title = english ? '[Remote collaboration task]' : '【远程协作任务】';
  const lines = [
    `${title} · ${english ? `Round ${inbound.round}` : `第 ${inbound.round} 轮`}`,
    '',
    `worker_thread_id: ${inbound.sessionId}`,
    english ? 'Use $collab-pair in remote-worker role.' : '请使用 $collab-pair 的远程员工模式。',
    '',
    `${english ? 'Manager device' : '经理设备'}：${inbound.managerDevice}`,
    `${english ? 'Remote alias' : '远程别名'}：${inbound.alias}`,
    '',
  ];
  if (inbound.projectName) lines.push(`${english ? 'Project' : '项目'}：${inbound.projectName}`, '');
  if (inbound.goal) lines.push(`${english ? 'Project goal' : '项目目标'}：${inbound.goal}`, '');
  lines.push(
    english ? '— Task —' : '—— 本轮任务 ——',
    inbound.task,
    '',
    english ? '— Acceptance criteria —' : '—— 验收标准 ——',
    inbound.acceptance || (english ? '(not specified)' : '（未指定）'),
    '',
    english ? '— Delivery —' : '—— 交付要求 ——',
    english
      ? `Before ending, call collab_report with worker_thread_id="${inbound.sessionId}", round=${inbound.round}, status, summary, details, and next.`
      : `结束前调用 collab_report：worker_thread_id="${inbound.sessionId}"、round=${inbound.round}、status（done/partial/blocked）、summary、details、next。`,
    `[[collab-pair:${inbound.linkId}:r${inbound.round}:remote-dispatch]]`,
  );
  return lines.join('\n');
}

function remoteManagerNotice(manager, link, managerMessage) {
  return {
    threadId: manager.threadId,
    messageText: managerMessage,
    kind: 'remote-report',
    linkId: link.id,
    round: link.round,
  };
}

function summarizeLink(link, manager, now) {
  return {
    linkId: link.id,
    managerThreadId: link.manager,
    managerTitle: manager?.title ?? link.managerTitle,
    projectName: manager?.projectName ?? '',
    workerThreadId: link.worker,
    workerTitle: link.workerTitle || link.worker,
    mode: link.mode,
    remote: link.remote,
    status: link.status,
    round: link.round,
    goal: link.goal || manager?.goal || '',
    pending: link.pending === null
      ? null
      : {
          round: link.pending.round,
          task: clip(link.pending.task, 1200),
          acceptance: link.pending.acceptance || null,
          dispatchedAt: isoTime(link.pending.dispatchedAt),
          waitedSeconds: Math.max(0, Math.round((now - link.pending.dispatchedAt) / 1000)),
          reported: link.pending.report !== null,
          report: link.pending.report,
        },
    lastReport: link.lastReport,
    history: link.history,
    nudges: link.nudges,
    createdAt: isoTime(link.createdAt),
    updatedAt: isoTime(link.updatedAt),
    closedAt: isoTime(link.closedAt),
    finalSummary: link.finalSummary ?? null,
  };
}

const toolDefinitions = [
  {
    name: 'collab_init',
    title: 'Initialize collaboration manager',
    description: 'Register or update one Codex thread as a project-manager collaboration state.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string', description: 'Exact manager thread id.' },
        managerTitle: { type: 'string', description: 'Current manager thread title.' },
        goal: { type: 'string', description: 'Project goal owned by the manager.' },
        projectName: { type: 'string', description: 'Project name shared by all workers of this manager.' },
        config: {
          type: 'object',
          description: 'Optional collaboration settings.',
          properties: {
            maxRounds: {
              type: 'integer',
              minimum: 0,
              maximum: 200,
              description: 'Maximum rounds per worker. 0 means unlimited.',
            },
            maxRelayChars: { type: 'integer', minimum: 500, maximum: 100000 },
            maxHistory: { type: 'integer', minimum: 1, maximum: 100 },
            notifyWorkerOnDone: { type: 'boolean' },
            autoRelay: { type: 'boolean' },
            autoSend: { type: 'boolean', description: 'Queue dispatch prompts to local Codex threads automatically.' },
            language: { type: 'string', enum: ['zh', 'en'] },
            autoNudge: { type: 'boolean' },
            nudgeAfterMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
            maxNudges: { type: 'integer', minimum: 1, maximum: 20 },
            addPrefix: { type: 'boolean' },
            prefixManager: { type: 'string' },
            prefixWorker: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      required: ['managerThreadId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_link',
    title: 'Link manager and worker threads',
    description: 'Create a persistent manager-worker link. A manager can link many workers; a worker can only belong to one active manager.',
    inputSchema: {
      type: 'object',
      properties: {
        currentThreadId: { type: 'string', description: 'Exact id of the thread issuing the link.' },
        peerThreadId: { type: 'string', description: 'Exact id of the other thread.' },
        role: { type: 'string', enum: ['manager', 'worker'], description: 'Role of currentThreadId. Defaults to manager.' },
        currentTitle: { type: 'string', description: 'Current title of currentThreadId.' },
        peerTitle: { type: 'string', description: 'Current title of peerThreadId.' },
        goal: { type: 'string', description: 'Optional project goal.' },
        projectName: { type: 'string', description: 'Optional project name. Defaults to the manager title.' },
        mode: {
          type: 'string',
          enum: ['temporary', 'permanent'],
          description: 'Temporary links unbind on done; permanent links stay until unlinked.',
        },
      },
      required: ['currentThreadId', 'peerThreadId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_dispatch',
    title: 'Dispatch a collaboration round',
    description: 'Record one new round and return the exact worker prompt to send with send_message_to_thread.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string', description: 'Exact manager thread id.' },
        managerTitle: { type: 'string', description: 'Optional current manager title.' },
        worker: { type: 'string', description: 'Worker thread id, link id, or unique title fragment. Optional for a single worker.' },
        task: { type: 'string', description: 'Task for this round.' },
        acceptance: { type: 'string', description: 'Optional acceptance criteria.' },
        send: {
          type: 'boolean',
          description: 'Queue the dispatch prompt automatically. Defaults to the manager autoSend setting.',
        },
        force: { type: 'boolean', description: 'Replace an unreported pending round deliberately.' },
      },
      required: ['managerThreadId', 'task'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_report',
    title: 'Record a worker report',
    description: 'Record the structured result of the latest dispatched round. Call before ending the worker turn.',
    inputSchema: {
      type: 'object',
      properties: {
        workerThreadId: { type: 'string', description: 'Exact worker thread id from the dispatch message.' },
        round: { type: 'integer', minimum: 1, description: 'Optional round number; must match the pending round.' },
        status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
        summary: { type: 'string', description: 'Deliverable or conclusion summary.' },
        details: { type: 'string', description: 'Changes, evidence, and verification results.' },
        next: { type: 'string', description: 'Suggested next step or required decision.' },
      },
      required: ['workerThreadId', 'status', 'summary'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_complete_round',
    title: 'Complete and collect a worker round',
    description: 'After a worker turn ends, record its final output, clear the pending round, and return the manager-facing collaboration report.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string', description: 'Optional manager thread id when completing from manager role.' },
        workerThreadId: { type: 'string', description: 'Exact worker thread id.' },
        worker: { type: 'string', description: 'Optional worker selector when managerThreadId is provided.' },
        round: { type: 'integer', minimum: 1 },
        finalOutput: { type: 'string', description: 'Worker final assistant text read from the completed thread.' },
        turnReason: { type: 'string', description: 'Completion reason such as completed, blocked, interrupted, or error.' },
        report: {
          type: 'object',
          description: 'Fallback report when the worker did not call collab_report.',
          properties: {
            status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
            summary: { type: 'string' },
            details: { type: 'string' },
            next: { type: 'string' },
          },
          required: ['status', 'summary'],
          additionalProperties: false,
        },
      },
      required: ['finalOutput'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_status',
    title: 'Inspect current collaboration role',
    description: 'Return manager or worker details for one exact Codex thread id.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Exact current thread id.' },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_board',
    title: 'Show the collaboration task board',
    description: 'Return every collaboration task, active first, with round, state, wait time, task, and latest report.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string', description: 'Optional manager id used to filter the board.' },
        includeClosed: { type: 'boolean', description: 'Include done links. Defaults to true.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_project',
    title: 'Rename the collaboration project',
    description: 'Set the project name shared by every worker managed by one project-manager thread.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string', description: 'Exact manager thread id.' },
        name: { type: 'string', description: 'New project name.' },
      },
      required: ['managerThreadId', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_remote',
    title: 'Configure cross-device collaboration',
    description: 'Configure the relay, register a local worker alias, link a remote worker, or inspect relay state.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['configure', 'status', 'alias', 'aliases', 'remove-alias', 'link'],
        },
        hubUrl: { type: 'string', description: 'Relay base URL, for example https://hub.example.com.' },
        hubToken: { type: 'string', description: 'Shared relay token.' },
        hubRoom: { type: 'string', description: 'Relay room name: letters, digits, underscore, or hyphen.' },
        deviceName: { type: 'string', description: 'Unique device name in the relay room.' },
        managerThreadId: { type: 'string', description: 'Manager thread id for link/project operations.' },
        currentThreadId: { type: 'string', description: 'Current thread id when registering an alias.' },
        currentTitle: { type: 'string' },
        session: { type: 'string', description: 'Local worker session id for alias; defaults to currentThreadId.' },
        alias: { type: 'string', description: 'Local worker alias or alias to remove.' },
        device: { type: 'string', description: 'Remote device name for link.' },
        worker: { type: 'string', description: 'Remote worker alias for link.' },
        name: { type: 'string', description: 'Display name for the remote worker.' },
        mode: { type: 'string', enum: ['temporary', 'permanent'] },
        projectName: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'collab_app_state',
    title: 'Refresh the collaboration app',
    description: 'App-only helper that returns the latest collaboration board without adding a visible model tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string' },
        includeClosed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: {
        resourceUri: APP_RESOURCE_URI,
        visibility: ['app'],
      },
    },
  },
  {
    name: 'collab_dashboard',
    title: 'Open the collaboration task board',
    description: 'Open the interactive collaboration task board inside Codex. It shows projects, tasks, statuses, links, relay state, and actions.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: {
        resourceUri: APP_RESOURCE_URI,
        visibility: ['model', 'app'],
      },
    },
  },
  {
    name: 'collab_open_window',
    title: 'Open the native collaboration window',
    description: 'Open the native Windows desktop dashboard for collab-pair. This is a real desktop window, not an in-app webpage.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_config',
    title: 'Configure a manager collaboration',
    description: 'Update round limits, relay size, language, title prefixes, or unattended reminder settings for one manager.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string' },
        config: {
          type: 'object',
          properties: {
            maxRounds: {
              type: 'integer',
              minimum: 0,
              maximum: 200,
              description: 'Maximum rounds. 0 means unlimited.',
            },
            maxRelayChars: { type: 'integer', minimum: 500, maximum: 100000 },
            maxHistory: { type: 'integer', minimum: 1, maximum: 100 },
            notifyWorkerOnDone: { type: 'boolean' },
            autoRelay: { type: 'boolean' },
            autoSend: { type: 'boolean' },
            language: { type: 'string', enum: ['zh', 'en'] },
            autoNudge: { type: 'boolean' },
            nudgeAfterMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
            maxNudges: { type: 'integer', minimum: 1, maximum: 20 },
            addPrefix: { type: 'boolean' },
            prefixManager: { type: 'string' },
            prefixWorker: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      required: ['managerThreadId', 'config'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_done',
    title: 'Close completed worker collaborations',
    description: 'Mark one or all active workers done, record the final summary, and return optional worker notification text.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string' },
        worker: { type: 'string', description: 'Optional worker selector.' },
        all: { type: 'boolean', description: 'Close all active workers.' },
        summary: { type: 'string', description: 'Verified final project summary.' },
      },
      required: ['managerThreadId', 'summary'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'collab_unlink',
    title: 'Unlink a collaboration',
    description: 'Delete one or all links. A worker call removes its own link; a manager call removes selected workers.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Exact current thread id.' },
        worker: { type: 'string', description: 'Optional manager-side worker selector.' },
        all: { type: 'boolean', description: 'Remove all active manager links or the current worker link.' },
        reason: { type: 'string' },
        notify: { type: 'boolean', description: 'Return notification text for the peer thread.' },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'collab_due',
    title: 'List stalled collaboration rounds due for attention',
    description: 'Return pending rounds that have exceeded the manager reminder interval without a report.',
    inputSchema: {
      type: 'object',
      properties: {
        managerThreadId: { type: 'string' },
        mark: { type: 'boolean', description: 'Increment reminder counters and set lastNudgeAt.' },
      },
      required: ['managerThreadId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

const toolByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

function codexExecutable() {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (configured) return configured;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function enqueueCodexThread(threadId, messageText) {
  return new Promise((resolvePromise) => {
    const executable = codexExecutable();
    if (
      process.platform === 'win32'
      && /\.(cmd|bat)$/i.test(executable)
    ) {
      resolvePromise({
        ok: false,
        error: 'CODEX_CLI_PATH 指向批处理文件；请改为指向 codex.exe，或设置 autoSend=false 后使用 send_message_to_thread。',
      });
      return;
    }
    const args = ['queue', '--thread', threadId, '--message', messageText, '--resume'];
    let child;
    try {
      child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: 'codex queue 超时（15 秒）。' });
    }, 15000);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 8000) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += String(chunk);
    });
    child.once('error', (error) => {
      finish({ ok: false, error: error.message });
    });
    child.once('exit', (code, signal) => {
      finish({
        ok: code === 0,
        code,
        signal,
        output: clip(stdout.trim(), 4000),
        error: code === 0 ? null : clip(stderr.trim() || `codex queue exited with ${code ?? signal}`, 2000),
      });
    });
  });
}

async function hubRequest(relay, path, options = {}) {
  const normalized = normalizeRelay(relay);
  if (!relayReady(normalized)) {
    throw new CollabError('跨设备中继尚未配置：请设置 hubUrl 与 hubToken。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);
  try {
    const response = await fetch(`${normalized.hubUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${normalized.hubToken}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) {
      throw new CollabError(body?.error ?? `relay HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function sendHubMessage(relay, to, type, payload) {
  const normalized = normalizeRelay(relay);
  const target = typeof to === 'string' ? to.trim() : '';
  if (target === '' || target.length > 64) throw new CollabError('远程设备名无效。');
  return hubRequest(normalized, '/v1/send', {
    method: 'POST',
    body: {
      room: normalized.hubRoom,
      from: normalized.deviceName,
      to: target,
      type,
      payload,
    },
  });
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function startBackgroundServices(store, options = {}) {
  const enqueueThread = typeof options.enqueueThread === 'function'
    ? options.enqueueThread
    : enqueueCodexThread;
  let stopped = false;

  async function relayLoop() {
    let lastKnownCursor = -1;
    while (!stopped) {
      const relay = store.getRelay();
      if (!relayReady(relay)) {
        await delay(3000);
        continue;
      }
      try {
        let cursor = relay.cursor;
        if (cursor === 0 || lastKnownCursor === -1) {
          const head = await hubRequest(relay, `/v1/head?room=${encodeURIComponent(relay.hubRoom)}`);
          cursor = Number.isSafeInteger(head.cursor) ? head.cursor : 0;
          store.markRelayRuntime({ cursor, lastPollAt: Date.now(), lastError: null });
        }
        lastKnownCursor = cursor;
        const poll = await hubRequest(
          relay,
          `/v1/poll?room=${encodeURIComponent(relay.hubRoom)}&device=${encodeURIComponent(relay.deviceName)}&since=${cursor}`,
          { timeoutMs: 25000 },
        );
        const messages = Array.isArray(poll.messages) ? poll.messages : [];
        for (const message of messages) {
          if (!Number.isSafeInteger(message?.id) || message.id <= cursor) continue;
          const outcome = store.handleRemoteMessage(message);
          if (outcome?.notification) {
            try {
              const queued = await enqueueThread(
                outcome.notification.threadId,
                outcome.notification.messageText,
              );
              if (queued.ok !== true) {
                store.markRelayRuntime({
                  lastError: `消息已收到，但写入 Codex 线程失败：${queued.error ?? 'unknown error'}`,
                });
                if (outcome.reply) {
                  await sendHub(relay, outcome.reply.to, 'error', {
                    linkId: outcome.reply.linkId,
                    alias: outcome.reply.alias,
                    round: outcome.reply.round,
                    code: 'queue-failed',
                    message: `远程设备 ${relay.deviceName} 无法写入 Codex 线程：${queued.error ?? 'unknown error'}`,
                  }).catch(() => undefined);
                }
              }
            } catch (error) {
              store.markRelayRuntime({
                lastError: `消息已收到，但写入 Codex 线程失败：${error instanceof Error ? error.message : String(error)}`,
              });
              if (outcome.reply) {
                await sendHub(relay, outcome.reply.to, 'error', {
                  linkId: outcome.reply.linkId,
                  alias: outcome.reply.alias,
                  round: outcome.reply.round,
                  code: 'queue-failed',
                  message: `远程设备 ${relay.deviceName} 无法写入 Codex 线程：${error instanceof Error ? error.message : String(error)}`,
                }).catch(() => undefined);
              }
            }
          }
          cursor = message.id;
          store.markRelayRuntime({ cursor, lastPollAt: Date.now(), lastError: null });
        }
        if (messages.length === 0) {
          store.markRelayRuntime({ cursor, lastPollAt: Date.now(), lastError: null });
        }
      } catch (error) {
        store.markRelayRuntime({
          lastError: error instanceof Error ? error.message : String(error),
        });
        await delay(5000);
      }
    }
  }

  async function nudgeLoop() {
    while (!stopped) {
      await delay(60000);
      if (stopped) break;
      try {
        const messages = store.dueReminders();
        for (const message of messages) {
          await enqueueThread(message.threadId, message.messageText);
        }
      } catch {
        // A background reminder must not terminate the MCP server.
      }
    }
  }

  void relayLoop();
  void nudgeLoop();
  return {
    stop() {
      stopped = true;
    },
  };
}

export function createStore(options = {}) {
  const statePath = options.statePath ? resolve(options.statePath) : defaultStatePath();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const enqueueThread = typeof options.enqueueThread === 'function'
    ? options.enqueueThread
    : enqueueCodexThread;
  const sendHub = typeof options.sendHub === 'function' ? options.sendHub : sendHubMessage;

  function loadState() {
    mkdirSync(dirname(statePath), { recursive: true });
    if (!existsSync(statePath)) return emptyState();
    try {
      return normalizeState(JSON.parse(readFileSync(statePath, 'utf8')));
    } catch (error) {
      const backup = `${statePath}.corrupt-${now()}`;
      copyFileSync(statePath, backup);
      const fresh = emptyState();
      fresh.corruptBackup = backup;
      return fresh;
    }
  }

  function saveState(state) {
    mkdirSync(dirname(statePath), { recursive: true });
    state.updatedAt = now();
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, statePath);
  }

  function mutate(handler) {
    const state = loadState();
    const result = handler(state);
    saveState(state);
    return result;
  }

  function ensureManager(state, threadId, title, goal, configPatch, projectName) {
    if (typeof threadId !== 'string' || threadId.trim() === '') {
      throw new CollabError('managerThreadId 不能为空。');
    }
    const previous = normalizeManager(state.managers[threadId], threadId);
    const manager = {
      ...previous,
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : previous.title,
      goal: typeof goal === 'string' ? goal.trim() : previous.goal,
      projectName: typeof projectName === 'string' && projectName.trim() !== ''
        ? projectName.trim().slice(0, 120)
        : previous.projectName,
      config: normalizeConfig(configPatch, previous.config),
      updatedAt: now(),
    };
    state.managers[threadId] = manager;
    return manager;
  }

  function activeManagerLinks(state, managerId) {
    return Object.values(state.links)
      .filter((link) => link.manager === managerId && link.status === ACTIVE)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  function managerLinks(state, managerId) {
    return Object.values(state.links)
      .filter((link) => link.manager === managerId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  function workerLink(state, workerId, activeOnly = true) {
    return Object.values(state.links).find(
      (link) => link.worker === workerId && (!activeOnly || link.status === ACTIVE),
    );
  }

  function resolveWorkerLink(state, managerId, selector) {
    const active = activeManagerLinks(state, managerId);
    if (active.length === 0) {
      throw new CollabError('当前项目经理线程没有进行中的员工协作；先调用 collab_link。');
    }
    const text = typeof selector === 'string' ? selector.trim() : '';
    if (text === '') {
      if (active.length === 1) return active[0];
      throw new CollabError(`当前有 ${active.length} 个员工，请用 worker 参数指定。`);
    }
    const exact = active.find(
      (link) => link.worker === text || link.id === text,
    );
    if (exact !== undefined) return exact;
    const needle = text.toLowerCase();
    const matches = active.filter(
      (link) =>
        link.workerTitle.toLowerCase().includes(needle) ||
        link.worker.toLowerCase().includes(needle),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new CollabError(
        `“${text}”匹配到多个员工，请改用精确的 worker thread id：${matches.map((link) => link.worker).join(', ')}`,
      );
    }
    throw new CollabError(
      `没有找到员工“${text}”。当前员工：${active.map((link) => `${link.workerTitle} (${link.worker})`).join(', ')}`,
    );
  }

  function resolveManagerLink(state, managerId, selector) {
    const links = managerLinks(state, managerId);
    if (links.length === 0) throw new CollabError('当前项目经理线程没有员工协作。');
    const text = typeof selector === 'string' ? selector.trim() : '';
    if (text === '') {
      if (links.length === 1) return links[0];
      throw new CollabError(`当前有 ${links.length} 个员工，请用 worker 参数指定。`);
    }
    const exact = links.find((link) => link.worker === text || link.id === text);
    if (exact !== undefined) return exact;
    const needle = text.toLowerCase();
    const matches = links.filter(
      (link) => link.workerTitle.toLowerCase().includes(needle) || link.worker.toLowerCase().includes(needle),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new CollabError(`“${text}”匹配到多个员工，请改用精确的 worker thread id。`);
    }
    throw new CollabError(`没有找到员工“${text}”。`);
  }

  function completeLinkRound(state, manager, link, options) {
    if (link.pending === null) throw new CollabError('该员工当前没有待完成轮次。');
    if (
      options.round !== undefined
      && (!Number.isSafeInteger(options.round) || options.round !== link.pending.round)
    ) {
      throw new CollabError(
        `轮次不匹配：当前待完成为第 ${link.pending.round} 轮，收到 ${String(options.round)}。`,
      );
    }
    const report = link.pending.report ?? normalizeReport(options.report);
    const finalOutput = clip(options.finalOutput, manager.config.maxRelayChars);
    const turnReason = typeof options.turnReason === 'string' && options.turnReason.trim() !== ''
      ? options.turnReason.trim()
      : 'completed';
    const completed = {
      round: link.pending.round,
      task: clip(link.pending.task, 300),
      acceptance: link.pending.acceptance,
      dispatchedAt: link.pending.dispatchedAt,
      completedAt: now(),
      report,
    };
    const status = report?.status ?? 'unreported';
    link.lastReport = report === null
      ? null
      : { ...report, round: completed.round, finalOutput, turnReason };
    link.history = [
      ...link.history,
      {
        round: completed.round,
        task: completed.task,
        acceptance: completed.acceptance,
        status,
        summary: clip(report?.summary ?? '', 500),
        finalOutput: clip(finalOutput, 2000),
        turnReason,
        completedAt: completed.completedAt,
      },
    ].slice(-manager.config.maxHistory);
    link.pending = null;
    link.nudges = 0;
    delete link.lastNudgeAt;
    link.updatedAt = now();
    manager.updatedAt = now();
    return {
      completed,
      status,
      managerMessage: managerReportText(manager, link, completed, finalOutput, turnReason),
      link: summarizeLink(link, manager, now()),
    };
  }

  function applyRelayConfig(state, input) {
    const previous = normalizeRelay(state.relay);
    let hubUrl = previous.hubUrl;
    if (input.hubUrl !== undefined) {
      hubUrl = normalizeHubUrl(input.hubUrl);
      if (typeof input.hubUrl === 'string' && input.hubUrl.trim() !== '' && hubUrl === '') {
        throw new CollabError('hubUrl 必须是有效的 http:// 或 https:// 地址。');
      }
    }
    let hubRoom = previous.hubRoom;
    if (input.hubRoom !== undefined) {
      hubRoom = typeof input.hubRoom === 'string' ? input.hubRoom.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(hubRoom)) {
        throw new CollabError('hubRoom 只能包含字母、数字、下划线或连字符，长度 1-64。');
      }
    }
    const hubToken = input.hubToken !== undefined
      ? (typeof input.hubToken === 'string' ? input.hubToken.trim() : '')
      : previous.hubToken;
    const deviceName = safeDeviceName(input.deviceName, previous.deviceName);
    state.relay = {
      ...previous,
      hubUrl,
      hubToken,
      hubRoom,
      deviceName,
      lastError: null,
    };
    return state.relay;
  }

  function relayView(relay, state) {
    return {
      hubUrl: relay.hubUrl,
      hubRoom: relay.hubRoom,
      deviceName: relay.deviceName,
      tokenConfigured: relay.hubToken !== '',
      configured: relayReady(relay),
      cursor: relay.cursor,
      lastPollAt: isoTime(relay.lastPollAt),
      lastError: relay.lastError,
      aliases: Object.values(state.aliases).sort((left, right) => left.alias.localeCompare(right.alias)),
      remoteLinks: Object.values(state.links)
        .filter((link) => link.remote !== null)
        .map((link) => ({
          linkId: link.id,
          managerThreadId: link.manager,
          workerThreadId: link.worker,
          workerTitle: link.workerTitle,
          device: link.remote.device,
          alias: link.remote.alias,
          mode: link.mode,
          status: link.status,
          round: link.round,
          lastError: link.remote.lastError,
        })),
    };
  }

  function handleRemoteMessage(message) {
    if (message === null || typeof message !== 'object') return null;
    return mutate((state) => {
      const relay = normalizeRelay(state.relay);
      if (message.from === relay.deviceName) return null;
      if (message.to !== relay.deviceName && message.to !== '*') return null;
      const type = typeof message.type === 'string' ? message.type : '';
      const payload = message.payload !== null && typeof message.payload === 'object'
        ? message.payload
        : {};

      if (type === 'dispatch') {
        const alias = safeAlias(payload.alias);
        const record = alias === '' ? undefined : state.aliases[alias];
        if (record === undefined) {
          const link = typeof payload.linkId === 'string' ? state.links[payload.linkId] : undefined;
          if (link?.remote) {
            link.remote.lastError = `本机没有员工别名“${payload.alias ?? ''}”`;
            link.updatedAt = now();
            const manager = ensureManager(state, link.manager, link.managerTitle, undefined, undefined);
            return manager.config.autoRelay
              ? {
                  notification: remoteManagerNotice(
                    manager,
                    link,
                    `【远程派发失败】\n设备 ${link.remote.device} 上没有员工别名“${payload.alias ?? ''}”。`,
                  ),
                }
              : null;
          }
          return null;
        }
        const inbound = normalizeInbound({
          sessionId: record.sessionId,
          alias,
          managerDevice: message.from,
          managerThreadId: payload.managerThreadId,
          linkId: payload.linkId,
          round: payload.round,
          task: payload.task,
          acceptance: payload.acceptance,
          projectName: payload.projectName,
          goal: payload.goal,
          managerTitle: payload.managerTitle,
          language: payload.language,
          dispatchedAt: now(),
        }, record.sessionId);
        if (inbound === null) return null;
        state.remoteInbound[record.sessionId] = inbound;
        state.aliases[alias].updatedAt = now();
        return {
          notification: {
            threadId: record.sessionId,
            messageText: payload.messageText || remoteDispatchText(inbound),
            kind: 'remote-dispatch',
            linkId: inbound.linkId,
            round: inbound.round,
          },
          reply: {
            to: message.from,
            linkId: inbound.linkId,
            alias: inbound.alias,
            round: inbound.round,
          },
        };
      }

      if (type === 'report') {
        const link = typeof payload.linkId === 'string' ? state.links[payload.linkId] : undefined;
        if (link === undefined || link.remote === null) return null;
        if (
          link.remote.device !== message.from
          || link.remote.alias !== safeAlias(payload.alias)
        ) {
          link.remote.lastError = '远程回报的设备或别名不匹配。';
          link.updatedAt = now();
          return null;
        }
        if (link.pending === null) return null;
        if (Number.isSafeInteger(payload.round) && payload.round !== link.pending.round) return null;
        const report = normalizeReport({
          summary: payload.summary,
          status: payload.status,
          details: payload.details,
          next: payload.next,
          reportedAt: Number.isFinite(payload.reportedAt) ? payload.reportedAt : now(),
        });
        if (report === null) return null;
        link.pending.report = report;
        const manager = ensureManager(state, link.manager, link.managerTitle, undefined, undefined);
        const finalOutput = [
          report.summary,
          report.details ? `\n\n${report.details}` : '',
        ].join('').trim();
        const completed = completeLinkRound(state, manager, link, {
          round: payload.round,
          finalOutput: finalOutput || report.summary,
          turnReason: 'remote-report',
        });
        link.remote.lastError = null;
        return manager.config.autoRelay
          ? { notification: remoteManagerNotice(manager, link, completed.managerMessage) }
          : null;
      }

      if (type === 'done' || type === 'unlink') {
        const alias = safeAlias(payload.alias);
        const record = alias === '' ? undefined : state.aliases[alias];
        const sessionId = record?.sessionId
          ?? Object.keys(state.remoteInbound).find((key) => state.remoteInbound[key].linkId === payload.linkId);
        if (sessionId === undefined) return null;
        const inbound = state.remoteInbound[sessionId];
        if (inbound === undefined) return null;
        delete state.remoteInbound[sessionId];
        return {
          notification: {
            threadId: sessionId,
            kind: type === 'done' ? 'remote-done' : 'remote-unlink',
            messageText: type === 'done'
              ? doneText(payload.summary, inbound.language)
              : unlinkText(payload.reason, 'manager', inbound.language),
          },
        };
      }
      if (type === 'error') {
        const link = typeof payload.linkId === 'string' ? state.links[payload.linkId] : undefined;
        if (link === undefined) return null;
        const messageText = typeof payload.message === 'string' && payload.message.trim() !== ''
          ? payload.message.trim()
          : '远程设备返回了未知错误。';
        if (link.remote !== null) {
          link.remote.lastError = messageText.slice(0, 500);
          link.updatedAt = now();
        }
        const manager = ensureManager(state, link.manager, link.managerTitle, undefined, undefined);
        return manager.config.autoRelay
          ? {
              notification: remoteManagerNotice(
                manager,
                link,
                manager.config.language === 'en'
                  ? `[Remote collaboration error]\n${messageText}`
                  : `【远程协作错误】\n${messageText}`,
              ),
            }
          : null;
      }
      return null;
    });
  }

  function markRelayRuntime(patch) {
    return mutate((state) => {
      const relay = normalizeRelay(state.relay);
      if (patch.cursor !== undefined && Number.isSafeInteger(patch.cursor)) relay.cursor = patch.cursor;
      if (patch.lastPollAt !== undefined && Number.isFinite(patch.lastPollAt)) {
        relay.lastPollAt = patch.lastPollAt;
      }
      if (patch.lastError !== undefined) {
        relay.lastError = patch.lastError === null ? null : String(patch.lastError).slice(0, 500);
      }
      state.relay = relay;
      return { ...relay };
    });
  }

  function dueReminders() {
    const state = loadState();
    const timestamp = now();
    const messages = [];
    let changed = false;
    for (const manager of Object.values(state.managers)) {
      if (!manager.config.autoNudge) continue;
      for (const link of activeManagerLinks(state, manager.threadId)) {
        if (link.pending === null || link.nudges >= manager.config.maxNudges) continue;
        const since = link.lastNudgeAt ?? link.pending.dispatchedAt;
        if (timestamp - since < manager.config.nudgeAfterMinutes * 60000) continue;
        link.nudges += 1;
        link.lastNudgeAt = timestamp;
        link.updatedAt = timestamp;
        changed = true;
        messages.push({
          threadId: manager.threadId,
          kind: 'nudge',
          linkId: link.id,
          round: link.pending.round,
          messageText: manager.config.language === 'en'
            ? `[Collaboration reminder] ${link.workerTitle} has not reported round ${link.pending.round} yet. Check the worker or replace the round if needed.`
            : `【协作提醒】${link.workerTitle} 的第 ${link.pending.round} 轮仍未回报，请检查员工状态；必要时可覆盖本轮。`,
        });
      }
    }
    if (changed) saveState(state);
    return messages;
  }

  async function handleTool(name, args = {}) {
    if (!toolByName.has(name)) throw new CollabError(`未知协作工具：${name}`);
    const input = args !== null && typeof args === 'object' ? args : {};

    if (name === 'collab_init') {
      return mutate((state) => {
        const manager = ensureManager(
          state,
          input.managerThreadId,
          input.managerTitle,
          input.goal,
          input.config,
          input.projectName,
        );
        const managerPrefix = `${manager.config.prefixManager}${stripKnownPrefix(manager.title, manager.config) || manager.title}`;
        return {
          ok: true,
          storage: statePath,
          manager,
          activeCount: activeManagerLinks(state, manager.threadId).length,
          titleUpdates: manager.config.addPrefix ? [{
            threadId: manager.threadId,
            currentTitle: manager.title,
            nextTitle: manager.title.startsWith(manager.config.prefixManager)
              ? manager.title
              : managerPrefix,
          }] : [],
        };
      });
    }

    if (name === 'collab_link') {
      return mutate((state) => {
        const currentThreadId = typeof input.currentThreadId === 'string' ? input.currentThreadId.trim() : '';
        const peerThreadId = typeof input.peerThreadId === 'string' ? input.peerThreadId.trim() : '';
        if (currentThreadId === '' || peerThreadId === '') {
          throw new CollabError('currentThreadId 和 peerThreadId 都必须提供。');
        }
        if (currentThreadId === peerThreadId) throw new CollabError('不能把线程与它自己关联。');
        const role = input.role === 'worker' ? 'worker' : 'manager';
        const managerThreadId = role === 'manager' ? currentThreadId : peerThreadId;
        const workerThreadId = role === 'manager' ? peerThreadId : currentThreadId;
        const managerTitleRaw = role === 'manager' ? input.currentTitle : input.peerTitle;
        const workerTitleRaw = role === 'manager' ? input.peerTitle : input.currentTitle;

        const currentAsWorker = workerLink(state, currentThreadId);
        if (currentAsWorker !== undefined) {
          throw new CollabError(`当前线程已经是员工（manager=${currentAsWorker.manager}），请先 collab_unlink。`);
        }
        if (role === 'worker' && activeManagerLinks(state, currentThreadId).length > 0) {
          throw new CollabError('当前线程正在管理员工，不能同时成为别人的员工。');
        }
        if (workerLink(state, managerThreadId) !== undefined) {
          throw new CollabError('项目经理线程本身已经是另一场协作的员工。');
        }
        if (activeManagerLinks(state, workerThreadId).length > 0) {
          throw new CollabError('目标员工线程正在管理其他员工，不能同时成为员工。');
        }

        const existingWorkerLink = workerLink(state, workerThreadId, false);
        if (existingWorkerLink !== undefined && existingWorkerLink.manager !== managerThreadId) {
          throw new CollabError(`目标线程已经是另一场协作的员工：${existingWorkerLink.manager}。`);
        }

        const manager = ensureManager(
          state,
          managerThreadId,
          typeof managerTitleRaw === 'string' ? managerTitleRaw : undefined,
          input.goal,
          undefined,
          input.projectName,
        );
        const workerTitle =
          typeof workerTitleRaw === 'string' && workerTitleRaw.trim() !== ''
            ? workerTitleRaw.trim()
            : workerThreadId;

        let link = existingWorkerLink;
        let created = false;
        if (link === undefined) {
          const id = `cp-${randomUUID().slice(0, 8)}`;
          link = {
            id,
            manager: managerThreadId,
            worker: workerThreadId,
            managerTitle: manager.title,
            workerTitle,
            goal: typeof input.goal === 'string' && input.goal.trim() !== '' ? input.goal.trim() : manager.goal,
            mode: input.mode === 'permanent' ? 'permanent' : 'temporary',
            remote: null,
            status: ACTIVE,
            round: 0,
            pending: null,
            lastReport: null,
            history: [],
            nudges: 0,
            createdAt: now(),
            updatedAt: now(),
          };
          state.links[id] = link;
          created = true;
        } else {
          link.managerTitle = manager.title;
          link.workerTitle = workerTitle;
          if (typeof input.goal === 'string' && input.goal.trim() !== '') link.goal = input.goal.trim();
          if (input.mode === 'temporary' || input.mode === 'permanent') link.mode = input.mode;
          if (link.status === DONE) {
            link.status = ACTIVE;
            link.pending = null;
            delete link.closedAt;
            delete link.finalSummary;
          }
          link.updatedAt = now();
        }
        manager.updatedAt = now();
        return {
          ok: true,
          created,
          role,
          projectName: manager.projectName,
          link: summarizeLink(link, manager, now()),
          activeCount: activeManagerLinks(state, managerThreadId).length,
          titleUpdates: titleUpdatesFor(manager, workerThreadId, workerTitle),
          next: 'Call collab_dispatch, then send the returned dispatch.messageText to the worker thread.',
        };
      });
    }

    if (name === 'collab_project') {
      return mutate((state) => {
        const managerThreadId = typeof input.managerThreadId === 'string'
          ? input.managerThreadId.trim()
          : '';
        const projectName = typeof input.name === 'string' ? input.name.trim() : '';
        if (managerThreadId === '') throw new CollabError('managerThreadId 不能为空。');
        if (projectName === '') throw new CollabError('项目名称不能为空。');
        const manager = ensureManager(
          state,
          managerThreadId,
          undefined,
          undefined,
          undefined,
          projectName,
        );
        manager.projectName = projectName.slice(0, 120);
        manager.updatedAt = now();
        for (const link of managerLinks(state, managerThreadId)) link.updatedAt = now();
        return {
          ok: true,
          projectName: manager.projectName,
          manager: summarizeManager(manager, state, now()),
          message: `项目名称已改为“${manager.projectName}”。`,
        };
      });
    }

    if (name === 'collab_remote') {
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'configure') {
        return mutate((state) => {
          const relay = applyRelayConfig(state, input);
          return {
            ok: true,
            action,
            relay: relayView(relay, state),
            message: relayReady(relay)
              ? `跨设备中继已配置：设备 ${relay.deviceName}，房间 ${relay.hubRoom}。`
              : '中继设置已保存；还需要同时设置 hubUrl 与 hubToken 才会开始连接。',
          };
        });
      }
      if (action === 'status' || action === 'aliases') {
        const state = loadState();
        const relay = normalizeRelay(state.relay);
        const view = relayView(relay, state);
        return {
          ok: true,
          action,
          relay: view,
          ...(action === 'aliases' ? { aliases: view.aliases } : {}),
        };
      }
      if (action === 'alias') {
        return mutate((state) => {
          const relay = normalizeRelay(state.relay);
          if (!relayReady(relay)) {
            throw new CollabError('先调用 collab_remote 的 configure 设置 hubUrl 与 hubToken。');
          }
          const alias = safeAlias(input.alias);
          if (alias === '') {
            throw new CollabError('alias 只能包含字母、数字、下划线或连字符，长度 1-64。');
          }
          const sessionId = typeof input.session === 'string' && input.session.trim() !== ''
            ? input.session.trim()
            : (typeof input.currentThreadId === 'string' ? input.currentThreadId.trim() : '');
          if (sessionId === '') throw new CollabError('alias 需要 session 或 currentThreadId。');
          const title = typeof input.currentTitle === 'string' && input.currentTitle.trim() !== ''
            ? input.currentTitle.trim()
            : sessionId;
          state.aliases[alias] = {
            alias,
            sessionId,
            title,
            updatedAt: now(),
          };
          return {
            ok: true,
            action,
            alias,
            sessionId,
            device: relay.deviceName,
            relay: relayView(relay, state),
            message: `已把本机线程 ${sessionId} 注册为远程员工别名“${alias}”。`,
          };
        });
      }
      if (action === 'remove-alias') {
        return mutate((state) => {
          const alias = safeAlias(input.alias);
          if (alias === '') throw new CollabError('alias 不能为空。');
          const existed = state.aliases[alias] !== undefined;
          delete state.aliases[alias];
          for (const [sessionId, inbound] of Object.entries(state.remoteInbound)) {
            if (inbound.alias === alias) delete state.remoteInbound[sessionId];
          }
          return {
            ok: true,
            action,
            alias,
            removed: existed,
            message: existed ? `已移除别名“${alias}”。` : `别名“${alias}”不存在。`,
          };
        });
      }
      if (action === 'link') {
        return mutate((state) => {
          const relay = normalizeRelay(state.relay);
          if (!relayReady(relay)) {
            throw new CollabError('先调用 collab_remote 的 configure 设置 hubUrl 与 hubToken。');
          }
          const managerThreadId = typeof input.managerThreadId === 'string'
            ? input.managerThreadId.trim()
            : (typeof input.currentThreadId === 'string' ? input.currentThreadId.trim() : '');
          const deviceRaw = typeof input.device === 'string' ? input.device.trim() : '';
          const device = /^[A-Za-z0-9_-]{1,64}$/.test(deviceRaw) ? deviceRaw : '';
          const alias = safeAlias(input.worker);
          if (managerThreadId === '') throw new CollabError('managerThreadId 不能为空。');
          if (device === '' || alias === '') throw new CollabError('device 和 worker 别名都需要提供。');
          if (workerLink(state, managerThreadId) !== undefined) {
            throw new CollabError('项目经理线程本身已经是另一场协作的员工。');
          }
          const manager = ensureManager(
            state,
            managerThreadId,
            input.currentTitle,
            undefined,
            undefined,
            input.projectName,
          );
          const worker = `remote:${device}:${alias}`;
          const name = typeof input.name === 'string' && input.name.trim() !== ''
            ? input.name.trim().slice(0, 120)
            : `${alias}@${device}`;
          let link = workerLink(state, worker, false);
          let created = false;
          if (link !== undefined && link.manager !== managerThreadId) {
            throw new CollabError(`远程员工 ${name} 已关联到另一个项目经理。`);
          }
          if (link === undefined) {
            link = {
              id: `cp-${randomUUID().slice(0, 8)}`,
              manager: managerThreadId,
              worker,
              managerTitle: manager.title,
              workerTitle: name,
              goal: manager.goal,
              mode: input.mode === 'permanent' ? 'permanent' : 'temporary',
              remote: { device, alias, label: name, lastError: null },
              status: ACTIVE,
              round: 0,
              pending: null,
              lastReport: null,
              history: [],
              nudges: 0,
              createdAt: now(),
              updatedAt: now(),
            };
            state.links[link.id] = link;
            created = true;
          } else {
            link.managerTitle = manager.title;
            link.workerTitle = name;
            link.remote = { device, alias, label: name, lastError: null };
            if (input.mode === 'temporary' || input.mode === 'permanent') link.mode = input.mode;
            if (link.status === DONE) {
              link.status = ACTIVE;
              link.pending = null;
              delete link.closedAt;
              delete link.finalSummary;
            }
            link.updatedAt = now();
          }
          manager.updatedAt = now();
          return {
            ok: true,
            action,
            created,
            projectName: manager.projectName,
            link: summarizeLink(link, manager, now()),
            titleUpdates: manager.config.addPrefix && !manager.title.startsWith(manager.config.prefixManager)
              ? [{
                  threadId: manager.threadId,
                  currentTitle: manager.title,
                  nextTitle: `${manager.config.prefixManager}${stripKnownPrefix(manager.title, manager.config) || manager.title}`,
                }]
              : [],
            message: `已关联远程员工 ${name}（${alias}@${device}）。`,
          };
        });
      }
      throw new CollabError(`未知的 collab_remote action：${action}`);
    }

    if (name === 'collab_dispatch') {
      const prepared = mutate((state) => {
        const managerThreadId = typeof input.managerThreadId === 'string' ? input.managerThreadId.trim() : '';
        if (managerThreadId === '') throw new CollabError('managerThreadId 不能为空。');
        const task = typeof input.task === 'string' ? input.task.trim() : '';
        if (task === '') throw new CollabError('task 不能为空。');
        const manager = ensureManager(state, managerThreadId, input.managerTitle, undefined, undefined);
        const link = resolveWorkerLink(state, managerThreadId, input.worker);
        if (link.status !== ACTIVE) throw new CollabError('该员工协作已结束，不能继续派发。');
        if (link.pending !== null && input.force !== true) {
          throw new CollabError(
            `第 ${link.pending.round} 轮仍在等待回报；不要重复派发。需要覆盖请传 force=true。`,
          );
        }
        if (manager.config.maxRounds > 0 && link.round >= manager.config.maxRounds) {
          throw new CollabError(
            `已达到最大轮次 ${manager.config.maxRounds}；请验收并调用 collab_done。`,
          );
        }
        const round = link.round + 1;
        const pending = {
          round,
          task,
          acceptance: typeof input.acceptance === 'string' ? input.acceptance.trim() : '',
          dispatchedAt: now(),
          report: null,
        };
        link.round = round;
        link.pending = pending;
        link.nudges = 0;
        delete link.lastNudgeAt;
        link.updatedAt = now();
        const messageText = dispatchText(manager, link, pending);
        const shouldSend = typeof input.send === 'boolean' ? input.send : manager.config.autoSend;
        return {
          ok: true,
          round,
          worker: link.worker,
          linkId: link.id,
          managerThreadId,
          managerTitle: manager.title,
          projectName: manager.projectName,
          remote: link.remote,
          relay: link.remote === null ? null : { ...state.relay },
          shouldSend,
          messageLanguage: manager.config.language,
          messageGoal: link.goal || manager.goal,
          acceptance: pending.acceptance,
          dispatch: {
            threadId: link.worker,
            messageText,
          },
          next: link.remote === null
            ? 'The plugin queues this prompt to the local worker when autoSend is enabled.'
            : 'The plugin sends this round through the configured cross-device relay.',
        };
      });
      let delivery = { attempted: false, sent: false, kind: 'manual' };
      if (prepared.shouldSend) {
        if (prepared.remote !== null) {
          if (!relayReady(prepared.relay)) {
            delivery = {
              attempted: true,
              sent: false,
              kind: 'relay',
              error: '跨设备中继尚未配置 hubUrl 与 hubToken。',
            };
          } else {
            try {
              const sent = await sendHub(prepared.relay, prepared.remote.device, 'dispatch', {
                managerThreadId: prepared.managerThreadId,
                managerDevice: prepared.relay.deviceName,
                managerTitle: prepared.managerTitle,
                linkId: prepared.linkId,
                alias: prepared.remote.alias,
                round: prepared.round,
                task: input.task,
                acceptance: prepared.acceptance,
                projectName: prepared.projectName,
                goal: prepared.messageGoal,
                language: prepared.messageLanguage,
                messageText: prepared.dispatch.messageText,
              });
              delivery = { attempted: true, sent: true, kind: 'relay', id: sent.id ?? null };
            } catch (error) {
              delivery = {
                attempted: true,
                sent: false,
                kind: 'relay',
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        } else {
          try {
            const queued = await enqueueThread(prepared.worker, prepared.dispatch.messageText);
            delivery = {
              attempted: true,
              sent: queued.ok === true,
              kind: 'queue',
              error: queued.error ?? null,
            };
          } catch (error) {
            delivery = {
              attempted: true,
              sent: false,
              kind: 'queue',
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
      const { shouldSend: _shouldSend, relay: _relay, messageLanguage: _language, messageGoal: _goal, ...result } = prepared;
      return {
        ...result,
        delivery,
        next: delivery.sent
          ? 'Wait for the worker turn to finish, then read its final output and call collab_complete_round.'
          : 'Automatic delivery did not succeed. Send dispatch.messageText with send_message_to_thread.',
      };
    }

    if (name === 'collab_report') {
      const recorded = mutate((state) => {
        const workerThreadId = typeof input.workerThreadId === 'string' ? input.workerThreadId.trim() : '';
        if (workerThreadId === '') throw new CollabError('workerThreadId 不能为空。');
        const link = workerLink(state, workerThreadId);
        const report = normalizeReport({
          summary: input.summary,
          status: input.status,
          details: input.details,
          next: input.next,
          reportedAt: now(),
        });
        if (report === null) throw new CollabError('summary 不能为空。');
        if (link !== undefined) {
          if (link.pending === null) throw new CollabError('当前没有等待回报的任务。');
          if (
            input.round !== undefined &&
            (!Number.isSafeInteger(input.round) || input.round !== link.pending.round)
          ) {
            throw new CollabError(
              `轮次不匹配：当前待汇报为第 ${link.pending.round} 轮，收到 ${String(input.round)}。`,
            );
          }
          link.pending.report = report;
          link.updatedAt = now();
          return {
            kind: 'local',
            round: link.pending.round,
            status: report.status,
            report,
          };
        }
        const inbound = state.remoteInbound[workerThreadId];
        if (inbound === undefined) throw new CollabError('该线程没有进行中的本地或远程协作任务。');
        if (
          input.round !== undefined
          && (!Number.isSafeInteger(input.round) || input.round !== inbound.round)
        ) {
          throw new CollabError(
            `轮次不匹配：当前待汇报为第 ${inbound.round} 轮，收到 ${String(input.round)}。`,
          );
        }
        inbound.reportedAt = now();
        return {
          kind: 'remote',
          round: inbound.round,
          status: report.status,
          report,
          inbound: { ...inbound },
          relay: { ...state.relay },
        };
      });
      if (recorded.kind === 'local') {
        return {
          ok: true,
          round: recorded.round,
          status: recorded.status,
          message: '汇报已记录。请结束本轮回复；项目经理会在读取最终产出后完成本轮。',
        };
      }
      if (!relayReady(recorded.relay)) {
        throw new CollabError('远程任务已记录汇报，但本机未配置跨设备中继，无法回传经理设备。');
      }
      try {
        const sent = await sendHub(recorded.relay, recorded.inbound.managerDevice, 'report', {
          managerThreadId: recorded.inbound.managerThreadId,
          managerDevice: recorded.inbound.managerDevice,
          linkId: recorded.inbound.linkId,
          round: recorded.round,
          alias: recorded.inbound.alias,
          status: recorded.report.status,
          summary: recorded.report.summary,
          details: recorded.report.details,
          next: recorded.report.next,
          reportedAt: recorded.report.reportedAt,
        });
        return {
          ok: true,
          round: recorded.round,
          status: recorded.status,
          remote: true,
          delivery: { attempted: true, sent: true, kind: 'relay', id: sent.id ?? null },
          message: '远程汇报已发送给项目经理设备。请结束本轮回复。',
        };
      } catch (error) {
        throw new CollabError(
          `远程汇报写入失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (name === 'collab_complete_round') {
      return mutate((state) => {
        let manager;
        let link;
        if (typeof input.managerThreadId === 'string' && input.managerThreadId.trim() !== '') {
          manager = ensureManager(state, input.managerThreadId, undefined, undefined, undefined);
          link = resolveWorkerLink(state, manager.threadId, input.worker ?? input.workerThreadId);
        } else {
          const workerThreadId =
            typeof input.workerThreadId === 'string' ? input.workerThreadId.trim() : '';
          if (workerThreadId === '') {
            throw new CollabError('需要提供 workerThreadId，或同时提供 managerThreadId 和 worker。');
          }
          link = workerLink(state, workerThreadId);
          if (link === undefined) throw new CollabError('没有找到该员工的活动协作。');
          manager = ensureManager(state, link.manager, link.managerTitle, undefined, undefined);
        }
        const completed = completeLinkRound(state, manager, link, {
          round: input.round,
          report: input.report,
          finalOutput: input.finalOutput,
          turnReason: input.turnReason,
        });
        return {
          ok: true,
          round: completed.completed.round,
          status: completed.status,
          managerMessage: completed.managerMessage,
          link: completed.link,
        };
      });
    }

    if (name === 'collab_status') {
      const state = loadState();
      const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
      if (threadId === '') throw new CollabError('threadId 不能为空。');
      const managedAll = managerLinks(state, threadId);
      if (state.managers[threadId] !== undefined || managedAll.length > 0) {
        const manager = ensureManager(state, threadId, undefined, undefined, undefined);
        const managed = activeManagerLinks(state, threadId);
        return {
          ok: true,
          linked: managed.length > 0,
          storage: statePath,
          role: 'manager',
          manager: summarizeManager(manager, state, now()),
          workers: managed.map((link) => summarizeLink(link, manager, now())),
          allWorkers: managedAll.map((link) => summarizeLink(link, manager, now())),
          activeCount: managed.length,
          totalCount: managedAll.length,
          relay: relayView(normalizeRelay(state.relay), state),
        };
      }
      const ownLink = workerLink(state, threadId, false);
      if (ownLink !== undefined) {
        const manager = ensureManager(state, ownLink.manager, ownLink.managerTitle, undefined, undefined);
        return {
          ok: true,
          linked: ownLink.status === ACTIVE,
          storage: statePath,
          role: 'worker',
          manager: {
            threadId: manager.threadId,
            title: manager.title,
            goal: manager.goal,
            projectName: manager.projectName,
          },
          link: summarizeLink(ownLink, manager, now()),
        };
      }
      const inbound = state.remoteInbound[threadId];
      const aliases = Object.values(state.aliases).filter((record) => record.sessionId === threadId);
      if (inbound !== undefined || aliases.length > 0) {
        return {
          ok: true,
          linked: inbound !== undefined,
          storage: statePath,
          role: 'remote-worker',
          link: inbound === undefined ? null : {
            linkId: inbound.linkId,
            managerThreadId: inbound.managerThreadId,
            managerTitle: inbound.managerTitle,
            managerDevice: inbound.managerDevice,
            projectName: inbound.projectName,
            round: inbound.round,
            task: inbound.task,
            acceptance: inbound.acceptance,
            reportedAt: isoTime(inbound.reportedAt),
          },
          aliases,
          relay: relayView(normalizeRelay(state.relay), state),
        };
      }
      const relay = normalizeRelay(state.relay);
      return {
        ok: true,
        linked: false,
        storage: statePath,
        role: null,
        hint: '调用 collab_init 开始一个经理协作，或由另一个经理线程通过 collab_link 把当前线程关联为员工。',
        relay: {
          configured: relayReady(relay),
          deviceName: relay.deviceName,
          hubRoom: relay.hubRoom,
          aliases: Object.keys(state.aliases).length,
        },
      };
    }

    if (name === 'collab_app_state') {
      return handleTool('collab_board', input);
    }

    if (name === 'collab_board') {
      const state = loadState();
      const filtered = input.managerThreadId
        ? Object.values(state.links).filter((link) => link.manager === input.managerThreadId)
        : Object.values(state.links);
      const includeClosed = input.includeClosed !== false;
      const rows = filtered
        .filter((link) => includeClosed || link.status === ACTIVE)
        .sort((left, right) => {
          const activeDelta = Number(right.status === ACTIVE) - Number(left.status === ACTIVE);
          return activeDelta !== 0 ? activeDelta : right.updatedAt - left.updatedAt;
        });
      const managers = new Map();
      for (const link of rows) {
        if (!managers.has(link.manager)) {
          managers.set(
            link.manager,
            ensureManager(state, link.manager, link.managerTitle, undefined, undefined),
          );
        }
      }
      const links = rows.map((link) => summarizeLink(link, managers.get(link.manager), now()));
      const grouped = new Map();
      for (const link of links) {
        const key = `${link.managerThreadId}\u0000${link.projectName}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            managerThreadId: link.managerThreadId,
            managerTitle: link.managerTitle,
            projectName: link.projectName,
            links: [],
          });
        }
        grouped.get(key).links.push(link);
      }
      return {
        ok: true,
        storage: statePath,
        generatedAt: isoTime(now()),
        activeCount: rows.filter((link) => link.status === ACTIVE).length,
        totalCount: rows.length,
        links,
        groups: [...grouped.values()],
        relay: relayView(normalizeRelay(state.relay), {
          ...state,
          aliases: state.aliases,
        }),
      };
    }

    if (name === 'collab_dashboard') {
      const state = loadState();
      const board = await handleTool('collab_board', {});
      return {
        ok: true,
        url: DASHBOARD_URL,
        appResourceUri: APP_RESOURCE_URI,
        board,
        storage: statePath,
        activeCount: Object.values(state.links).filter((link) => link.status === ACTIVE).length,
        totalCount: Object.keys(state.links).length,
        hint: 'Codex 会把该工具渲染为内嵌 MCP App；不支持 MCP Apps 的客户端仍可打开 url。',
      };
    }

    if (name === 'collab_open_window') {
      const executable = findPythonWindowExecutable();
      const child = spawn(executable, [NATIVE_WINDOW_SCRIPT], {
        cwd: dirname(NATIVE_WINDOW_SCRIPT),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return {
        ok: true,
        opened: true,
        pid: child.pid ?? null,
        kind: 'native-window',
        executable,
        script: NATIVE_WINDOW_SCRIPT,
        message: '原生双对话协作窗口已启动。',
      };
    }

    if (name === 'collab_config') {
      return mutate((state) => {
        const managerThreadId =
          typeof input.managerThreadId === 'string' ? input.managerThreadId.trim() : '';
        if (managerThreadId === '') throw new CollabError('managerThreadId 不能为空。');
        const manager = ensureManager(state, managerThreadId, undefined, undefined, input.config);
        return { ok: true, manager: summarizeManager(manager, state, now()) };
      });
    }

    if (name === 'collab_done') {
      const outcome = mutate((state) => {
        const managerThreadId =
          typeof input.managerThreadId === 'string' ? input.managerThreadId.trim() : '';
        if (managerThreadId === '') throw new CollabError('managerThreadId 不能为空。');
        const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
        if (summary === '') throw new CollabError('summary 不能为空。');
        const manager = ensureManager(state, managerThreadId, undefined, undefined, undefined);
        const active = activeManagerLinks(state, managerThreadId);
        let targets;
        if (input.all === true) {
          targets = active;
        } else if (typeof input.worker === 'string' && input.worker.trim() !== '') {
          targets = [resolveWorkerLink(state, managerThreadId, input.worker)];
        } else if (active.length === 1) {
          targets = [active[0]];
        } else if (active.length === 0) {
          throw new CollabError('没有进行中的员工协作。');
        } else {
          throw new CollabError(`当前有 ${active.length} 个员工，请用 worker 指定或传 all=true。`);
        }
        const workerMessages = [];
        const remoteMessages = [];
        const titleUpdates = [];
        const closed = [];
        for (const link of targets) {
          link.status = DONE;
          link.pending = null;
          link.finalSummary = clip(summary, 4000);
          link.closedAt = now();
          link.updatedAt = now();
          closed.push({
            linkId: link.id,
            workerThreadId: link.worker,
            workerTitle: link.workerTitle,
            mode: link.mode,
            remote: link.remote,
            unlinked: link.mode === 'temporary',
          });
          titleUpdates.push(...titleCleanupFor(manager, link, false));
          if (manager.config.notifyWorkerOnDone) {
            if (link.remote === null) {
              workerMessages.push({
                threadId: link.worker,
                linkId: link.id,
                messageText: doneText(summary, manager.config.language),
              });
            } else {
              remoteMessages.push({
                device: link.remote.device,
                alias: link.remote.alias,
                linkId: link.id,
              });
            }
          }
          if (link.mode === 'temporary') delete state.links[link.id];
        }
        if (
          activeManagerLinks(state, managerThreadId).length === 0
          && manager.config.addPrefix
          && manager.title.startsWith(manager.config.prefixManager)
        ) {
          titleUpdates.push({
            threadId: manager.threadId,
            currentTitle: manager.title,
            nextTitle: stripKnownPrefix(manager.title, manager.config) || manager.threadId,
          });
        }
        return {
          ok: true,
          closed,
          workerMessages,
          remoteMessages,
          titleUpdates,
          relay: { ...state.relay },
          message: `已结束 ${closed.length} 个员工协作；临时关联已解绑，永久关联保留历史。`,
        };
      });
      const remoteDelivery = [];
      for (const message of outcome.remoteMessages) {
        if (!relayReady(outcome.relay)) {
          remoteDelivery.push({
            device: message.device,
            alias: message.alias,
            sent: false,
            error: '跨设备中继尚未配置。',
          });
          continue;
        }
        try {
          await sendHub(outcome.relay, message.device, 'done', {
            linkId: message.linkId,
            alias: message.alias,
            summary: input.summary,
          });
          remoteDelivery.push({ device: message.device, alias: message.alias, sent: true });
        } catch (error) {
          remoteDelivery.push({
            device: message.device,
            alias: message.alias,
            sent: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const localDelivery = [];
      for (const message of outcome.workerMessages) {
        try {
          const queued = await enqueueThread(message.threadId, message.messageText);
          localDelivery.push({
            threadId: message.threadId,
            sent: queued.ok === true,
            error: queued.error ?? null,
          });
        } catch (error) {
          localDelivery.push({
            threadId: message.threadId,
            sent: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const {
        workerMessages,
        remoteMessages,
        relay: _relay,
        ...result
      } = outcome;
      return {
        ...result,
        workerMessages,
        remoteDelivery,
        localDelivery,
      };
    }

    if (name === 'collab_unlink') {
      const outcome = mutate((state) => {
        const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
        if (threadId === '') throw new CollabError('threadId 不能为空。');
        const ownLink = workerLink(state, threadId, false);
        if (ownLink !== undefined) {
          const manager = ensureManager(state, ownLink.manager, ownLink.managerTitle, undefined, undefined);
          delete state.links[ownLink.id];
          return {
            ok: true,
            role: 'worker',
            remoteMessages: [],
            removed: [{
              linkId: ownLink.id,
              managerThreadId: ownLink.manager,
              workerThreadId: ownLink.worker,
              remote: ownLink.remote,
              mode: ownLink.mode,
            }],
            titleUpdates: titleCleanupFor(manager, ownLink, false),
            peerMessages: input.notify === true ? [{
              threadId: ownLink.manager,
              messageText: unlinkText(input.reason, 'worker', manager.config.language),
            }] : [],
            relay: { ...state.relay },
          };
        }
        const allLinks = managerLinks(state, threadId);
        if (allLinks.length === 0) throw new CollabError('当前线程没有可解除的协作。');
        const manager = ensureManager(state, threadId, undefined, undefined, undefined);
        let targets;
        if (input.all === true) {
          targets = allLinks;
        } else if (typeof input.worker === 'string' && input.worker.trim() !== '') {
          targets = [resolveManagerLink(state, threadId, input.worker)];
        } else if (allLinks.length === 1) {
          targets = [allLinks[0]];
        } else {
          throw new CollabError(`当前有 ${allLinks.length} 个员工，请用 worker 指定或传 all=true。`);
        }
        const removed = [];
        const peerMessages = [];
        const remoteMessages = [];
        const titleUpdates = [];
        for (const link of targets) {
          removed.push({
            linkId: link.id,
            managerThreadId: link.manager,
            workerThreadId: link.worker,
            remote: link.remote,
            mode: link.mode,
          });
          titleUpdates.push(...titleCleanupFor(manager, link, false));
          if (link.remote !== null) {
            remoteMessages.push({
              device: link.remote.device,
              alias: link.remote.alias,
              linkId: link.id,
            });
          } else if (input.notify === true) {
            peerMessages.push({
              threadId: link.worker,
              messageText: unlinkText(input.reason, 'manager', manager.config.language),
            });
          }
          delete state.links[link.id];
        }
        if (
          activeManagerLinks(state, threadId).length === 0
          && manager.config.addPrefix
          && manager.title.startsWith(manager.config.prefixManager)
        ) {
          titleUpdates.push({
            threadId: manager.threadId,
            currentTitle: manager.title,
            nextTitle: stripKnownPrefix(manager.title, manager.config) || manager.threadId,
          });
        }
        return {
          ok: true,
          role: 'manager',
          removed,
          peerMessages,
          remoteMessages,
          titleUpdates,
          relay: { ...state.relay },
        };
      });
      const peerDelivery = [];
      for (const message of outcome.peerMessages ?? []) {
        try {
          const queued = await enqueueThread(message.threadId, message.messageText);
          peerDelivery.push({ threadId: message.threadId, sent: queued.ok === true, error: queued.error ?? null });
        } catch (error) {
          peerDelivery.push({
            threadId: message.threadId,
            sent: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const remoteDelivery = [];
      for (const message of outcome.remoteMessages ?? []) {
        if (!relayReady(outcome.relay)) {
          remoteDelivery.push({
            device: message.device,
            alias: message.alias,
            sent: false,
            error: '跨设备中继尚未配置。',
          });
          continue;
        }
        try {
          await sendHub(outcome.relay, message.device, 'unlink', {
            linkId: message.linkId,
            alias: message.alias,
            reason: input.reason ?? '',
          });
          remoteDelivery.push({ device: message.device, alias: message.alias, sent: true });
        } catch (error) {
          remoteDelivery.push({
            device: message.device,
            alias: message.alias,
            sent: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const { remoteMessages: _remoteMessages, relay: _relay, ...result } = outcome;
      return {
        ...result,
        remoteDelivery,
        peerDelivery,
      };
    }

    if (name === 'collab_due') {
      return mutate((state) => {
        const managerThreadId =
          typeof input.managerThreadId === 'string' ? input.managerThreadId.trim() : '';
        if (managerThreadId === '') throw new CollabError('managerThreadId 不能为空。');
        const manager = ensureManager(state, managerThreadId, undefined, undefined, undefined);
        if (!manager.config.autoNudge) return { ok: true, due: [] };
        const timestamp = now();
        const due = [];
        for (const link of activeManagerLinks(state, managerThreadId)) {
          if (link.pending === null || link.nudges >= manager.config.maxNudges) continue;
          const since = link.lastNudgeAt ?? link.pending.dispatchedAt;
          if (timestamp - since < manager.config.nudgeAfterMinutes * 60000) continue;
          const attempt = link.nudges + 1;
          if (input.mark === true) {
            link.nudges = attempt;
            link.lastNudgeAt = timestamp;
            link.updatedAt = timestamp;
          }
          due.push({
            linkId: link.id,
            workerThreadId: link.worker,
            workerTitle: link.workerTitle,
            idleMinutes: Math.max(1, Math.round((timestamp - since) / 60000)),
            attempt,
            maxNudges: manager.config.maxNudges,
          });
        }
        return {
          ok: true,
          due,
          message: due.length === 0
            ? '没有需要提醒的停滞轮次。'
            : '对应员工本轮长时间未回报，请检查员工状态；必要时可覆盖本轮。',
        };
      });
    }

    throw new CollabError(`工具尚未实现：${name}`);
  }

  function summarizeManager(manager, state, timestamp) {
    const links = Object.values(state.links).filter((link) => link.manager === manager.threadId);
    return {
      threadId: manager.threadId,
      title: manager.title,
      projectName: manager.projectName,
      goal: manager.goal,
      config: manager.config,
      activeCount: links.filter((link) => link.status === ACTIVE).length,
      totalCount: links.length,
      createdAt: isoTime(manager.createdAt),
      updatedAt: isoTime(manager.updatedAt),
      generatedAt: isoTime(timestamp),
    };
  }

  return {
    statePath,
    handleTool,
    handleRemoteMessage,
    dueReminders,
    markRelayRuntime,
    getRelay() {
      return normalizeRelay(loadState().relay);
    },
    tools: toolDefinitions,
    loadState,
  };
}

function findPythonWindowExecutable() {
  const names = process.platform === 'win32'
    ? ['pythonw.exe', 'python.exe']
    : ['python3', 'python'];
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of names) {
    if (name.includes('.') || name.includes('/')) {
      if (existsSync(name)) return name;
    }
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return names[0];
}

const DASHBOARD_ACTIONS = new Set([
  'collab_init',
  'collab_link',
  'collab_project',
  'collab_dispatch',
  'collab_config',
  'collab_remote',
  'collab_done',
  'collab_unlink',
]);

function sendJson(response, statusCode, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function sendText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

function readJsonBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        rejectPromise(new CollabError('请求体超过 1 MB。'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise(text === '' ? {} : JSON.parse(text));
      } catch {
        rejectPromise(new CollabError('请求 JSON 无法解析。'));
      }
    });
    request.on('error', rejectPromise);
  });
}

export function startDashboardServer(options = {}) {
  const store = options.store ?? createStore();
  const host = options.host ?? DASHBOARD_HOST;
  const port = options.port ?? DASHBOARD_PORT;
  const dashboardPath = options.dashboardPath ?? join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);
    try {
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'collab-pair-dashboard', version: SERVER_VERSION });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/board') {
        sendJson(response, 200, await store.handleTool('collab_board', {}));
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        const threadId = requestUrl.searchParams.get('threadId') ?? '';
        sendJson(response, 200, await store.handleTool('collab_status', { threadId }));
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/action') {
        const body = await readJsonBody(request);
        const name = typeof body.name === 'string' ? body.name : '';
        if (!DASHBOARD_ACTIONS.has(name)) {
          sendJson(response, 403, { ok: false, error: `该操作不允许从看板执行：${name}` });
          return;
        }
        const args = body.arguments !== null && typeof body.arguments === 'object'
          ? body.arguments
          : {};
        sendJson(response, 200, await store.handleTool(name, args));
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/assets/icon.svg') {
        const iconPath = join(dirname(dashboardPath), 'assets', 'icon.svg');
        sendText(response, 200, readFileSync(iconPath, 'utf8'), 'image/svg+xml; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
        sendText(response, 200, readFileSync(dashboardPath, 'utf8'), 'text/html; charset=utf-8');
        return;
      }
      sendJson(response, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { ok: false, error: message });
    }
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        resolvePromise({ existing: true, host, port, url: `http://${host}:${port}/`, close: async () => {} });
        return;
      }
      rejectPromise(error);
    });
    server.listen(port, host, () => {
      const actualPort = server.address()?.port ?? port;
      resolvePromise({
        existing: false,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}/`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

async function runStdioServer() {
  const store = createStore();
  const dashboard = await startDashboardServer({ store });
  const background = startBackgroundServices(store);
  process.stderr.write(
    `collab-pair dashboard ${dashboard.existing ? 'already available' : 'listening'} at ${dashboard.url}\n`,
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  async function dispatch(message) {
    if (message === null || typeof message !== 'object') {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;
    if (typeof method !== 'string') {
      if (id !== undefined) return jsonRpcError(id, -32600, 'Invalid Request');
      return undefined;
    }
    try {
      if (method === 'initialize') {
        const requested = typeof params?.protocolVersion === 'string'
          ? params.protocolVersion
          : PROTOCOL_VERSION;
        return jsonRpcResponse(id, {
          protocolVersion: requested,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            title: '双对话协作',
          },
          instructions: 'Use collab_init/link/dispatch, then Codex thread tools to send and wait. Workers call collab_report before ending.',
        });
      }
      if (method === 'ping') return jsonRpcResponse(id, {});
      if (method === 'tools/list') {
        return jsonRpcResponse(id, { tools: toolDefinitions });
      }
      if (method === 'tools/call') {
        const name = typeof params?.name === 'string' ? params.name : '';
        if (!toolByName.has(name)) {
          return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
        }
        try {
          let value = await store.handleTool(name, params?.arguments);
          if (name === 'collab_dashboard') {
            const metadata = params?._meta ?? {};
            const turnMetadataRaw = metadata['x-codex-turn-metadata'];
            let turnMetadata = null;
            if (typeof turnMetadataRaw === 'string') {
              try {
                turnMetadata = JSON.parse(turnMetadataRaw);
              } catch {
                turnMetadata = null;
              }
            } else if (turnMetadataRaw !== null && typeof turnMetadataRaw === 'object') {
              turnMetadata = turnMetadataRaw;
            }
            const currentThreadId = [
              metadata['openai/threadId'],
              metadata['openai/thread_id'],
              metadata.codexThreadId,
              metadata.codex_thread_id,
              metadata.threadId,
              metadata.thread_id,
              turnMetadata?.thread_id,
            ].find((candidate) => typeof candidate === 'string' && candidate.trim() !== '') ?? null;
            value = { ...value, currentThreadId };
          }
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
            isError: false,
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text }],
            isError: true,
          });
        }
      }
      if (method === 'resources/list') {
        return jsonRpcResponse(id, {
          resources: [{
            uri: APP_RESOURCE_URI,
            name: 'collab-pair-dashboard',
            title: '双对话协作任务板',
            description: 'Interactive collaboration board rendered inside Codex.',
            mimeType: APP_RESOURCE_MIME,
          }],
        });
      }
      if (method === 'resources/read') {
        const uri = typeof params?.uri === 'string' ? params.uri : '';
        if (uri !== APP_RESOURCE_URI) {
          return jsonRpcError(id, -32002, `Resource not found: ${uri}`);
        }
        if (!existsSync(APP_RESOURCE_FILE)) {
          return jsonRpcError(id, -32603, 'MCP App bundle is missing. Reinstall the plugin.');
        }
        return jsonRpcResponse(id, {
          contents: [{
            uri: APP_RESOURCE_URI,
            mimeType: APP_RESOURCE_MIME,
            text: readFileSync(APP_RESOURCE_FILE, 'utf8'),
            _meta: {
              ui: {
                prefersBorder: true,
              },
            },
          }],
        });
      }
      if (method === 'resourceTemplates/list' || method === 'resources/templates/list') {
        return jsonRpcResponse(id, { resourceTemplates: [] });
      }
      if (method === 'prompts/list') return jsonRpcResponse(id, { prompts: [] });
      if (method === 'roots/list') return jsonRpcResponse(id, { roots: [] });
      if (method === 'logging/setLevel') return jsonRpcResponse(id, {});
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
      if (id === undefined) return undefined;
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      return jsonRpcError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  input.on('line', (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    void Promise.all(messages.map((item) => dispatch(item))).then((responses) => {
      for (const response of responses) if (response !== undefined) write(response);
    });
  });
  input.on('close', () => {
    background.stop();
    void dashboard.close();
  });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  const start = process.argv.includes('--dashboard-only')
    ? startDashboardServer({ store: createStore() })
    : runStdioServer();
  start.catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
