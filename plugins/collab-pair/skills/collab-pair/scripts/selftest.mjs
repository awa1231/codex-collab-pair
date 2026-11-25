#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createStore, startDashboardServer } from '../../../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '../../../server.mjs');
const temporary = mkdtempSync(join(tmpdir(), 'collab-pair-selftest-'));
const statePath = join(temporary, 'state.json');
let clock = 1_800_000_000_000;
const tick = () => {
  clock += 1000;
  return clock;
};

try {
  const queuedMessages = [];
  const store = createStore({
    statePath,
    now: tick,
    enqueueThread: async (threadId, messageText) => {
      queuedMessages.push({ threadId, messageText });
      return { ok: true };
    },
  });
  await store.handleTool('collab_init', {
    managerThreadId: 'manager-1',
    managerTitle: 'Project Alpha',
    goal: 'Ship a verified result',
    projectName: 'Atlas',
    config: { language: 'zh', maxRounds: 0 },
  });

  const first = await store.handleTool('collab_link', {
    currentThreadId: 'manager-1',
    peerThreadId: 'worker-a',
    currentTitle: 'Project Alpha',
    peerTitle: 'Worker A',
    mode: 'permanent',
  });
  assert.equal(first.role, 'manager');
  assert.equal(first.activeCount, 1);
  assert.equal(first.projectName, 'Atlas');

  const second = await store.handleTool('collab_link', {
    currentThreadId: 'manager-1',
    peerThreadId: 'worker-b',
    currentTitle: 'Project Alpha',
    peerTitle: 'Worker B',
    mode: 'temporary',
  });
  assert.equal(second.activeCount, 2);

  const dispatchA = await store.handleTool('collab_dispatch', {
    managerThreadId: 'manager-1',
    worker: 'worker-a',
    task: 'Produce part A',
    acceptance: 'A exists and is verified',
  });
  assert.equal(dispatchA.round, 1);
  assert.match(dispatchA.dispatch.messageText, /worker_thread_id：worker-a/);
  assert.equal(dispatchA.delivery.sent, true);
  assert.equal(queuedMessages.length, 1);

  await assert.rejects(
    () => store.handleTool('collab_dispatch', {
      managerThreadId: 'manager-1',
      worker: 'worker-a',
      task: 'Accidental duplicate',
    }),
    /仍在等待回报/,
  );

  await store.handleTool('collab_report', {
    workerThreadId: 'worker-a',
    round: 1,
    status: 'done',
    summary: 'Part A complete',
    details: 'Created and verified A',
    next: 'Review A',
  });
  const completeA = await store.handleTool('collab_complete_round', {
    workerThreadId: 'worker-a',
    round: 1,
    finalOutput: 'A is ready at /tmp/A',
    turnReason: 'completed',
  });
  assert.equal(completeA.status, 'done');
  assert.match(completeA.managerMessage, /Part A complete/);

  const dispatchB = await store.handleTool('collab_dispatch', {
    managerThreadId: 'manager-1',
    worker: 'worker-b',
    task: 'Check edge cases',
  });
  await store.handleTool('collab_report', {
    workerThreadId: 'worker-b',
    round: dispatchB.round,
    status: 'blocked',
    summary: 'Need a policy decision',
    details: 'Two mutually exclusive interpretations',
  });
  await store.handleTool('collab_complete_round', {
    workerThreadId: 'worker-b',
    round: dispatchB.round,
    finalOutput: 'Blocked pending user decision.',
    turnReason: 'blocked',
  });

  const board = await store.handleTool('collab_board', {});
  assert.equal(board.activeCount, 2);
  assert.equal(board.totalCount, 2);
  assert.equal(board.links.find((link) => link.workerThreadId === 'worker-b').lastReport.status, 'blocked');
  assert.equal(board.groups[0].projectName, 'Atlas');

  const managerStatus = await store.handleTool('collab_status', { threadId: 'manager-1' });
  assert.equal(managerStatus.role, 'manager');
  assert.equal(managerStatus.workers.length, 2);

  const workerStatus = await store.handleTool('collab_status', { threadId: 'worker-a' });
  assert.equal(workerStatus.role, 'worker');
  assert.equal(workerStatus.link.round, 1);

  const done = await store.handleTool('collab_done', {
    managerThreadId: 'manager-1',
    all: true,
    summary: 'Both deliverables accepted',
  });
  assert.equal(done.closed.length, 2);
  assert.equal(done.workerMessages.length, 2);

  const finalBoard = await store.handleTool('collab_board', {});
  assert.equal(finalBoard.activeCount, 0);
  assert.equal(finalBoard.totalCount, 1);
  assert.equal(finalBoard.links[0].workerThreadId, 'worker-a');
  assert.equal(finalBoard.links[0].mode, 'permanent');
  assert.equal(finalBoard.links[0].status, 'done');

  const dashboardTool = await store.handleTool('collab_dashboard', {});
  assert.equal(dashboardTool.url.endsWith(':43157/'), true);

  const dashboard = await startDashboardServer({ store, port: 0 });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /双对话协作/);
    assert.match(pageText, /项目名称/);
    assert.match(pageText, /自动派发/);
    const api = await fetch(new URL('/api/board', dashboard.url));
    assert.equal(api.status, 200);
    assert.equal((await api.json()).totalCount, 1);
  } finally {
    await dashboard.close();
  }

  await testRemoteRound({ temporary, tick });

  const rpcResult = await testMcpHandshake(serverPath, temporary);
  assert.equal(rpcResult.protocolVersion.length > 0, true);
  assert.equal(rpcResult.toolCount, store.tools.length);
  assert.equal(rpcResult.toolCallOk, true);
  assert.equal(rpcResult.mcpAppOk, true);
  process.stdout.write('collab-pair selftest: PASS\n');
} finally {
  const resolvedTemporary = resolve(temporary);
  const resolvedTmp = resolve(tmpdir());
  if (resolvedTemporary.startsWith(`${resolvedTmp}\\`) || resolvedTemporary.startsWith(`${resolvedTmp}/`)) {
    rmSync(resolvedTemporary, { recursive: true, force: true });
  }
}

async function testRemoteRound({ temporary, tick }) {
  const port = await freePort();
  const token = 'selftest-relay-token';
  const hubPath = resolve(here, '../../../hub.mjs');
  const hub = spawn(process.execPath, [
    hubPath,
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
    '--token',
    token,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = createInterface({ input: hub.stdout, crlfDelay: Infinity });
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      hub.kill();
      rejectPromise(new Error('relay hub did not start'));
    }, 5000);
    output.on('line', (line) => {
      if (!line.includes('COLLAB_HUB_PORT=')) return;
      clearTimeout(timer);
      hub.removeAllListeners('exit');
      resolvePromise();
    });
    hub.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    hub.once('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`relay hub exited early: ${code}`));
    });
  });

  try {
    const managerStore = createStore({
      statePath: join(temporary, 'remote-manager.json'),
      now: tick,
      enqueueThread: async () => ({ ok: true }),
    });
    const workerStore = createStore({
      statePath: join(temporary, 'remote-worker.json'),
      now: tick,
      enqueueThread: async () => ({ ok: true }),
    });
    const relayUrl = `http://127.0.0.1:${port}`;
    const relay = {
      hubUrl: relayUrl,
      hubToken: token,
      hubRoom: 'selftest-room',
    };
    await managerStore.handleTool('collab_remote', {
      action: 'configure',
      ...relay,
      deviceName: 'manager-dev',
    });
    await workerStore.handleTool('collab_remote', {
      action: 'configure',
      ...relay,
      deviceName: 'worker-dev',
    });
    await workerStore.handleTool('collab_remote', {
      action: 'alias',
      alias: 'frontend',
      session: 'remote-worker-1',
      currentTitle: 'Remote Frontend Worker',
    });
    const linked = await managerStore.handleTool('collab_remote', {
      action: 'link',
      managerThreadId: 'remote-manager-1',
      currentTitle: 'Remote Manager',
      device: 'worker-dev',
      worker: 'frontend',
      name: 'Remote Frontend',
      mode: 'temporary',
    });
    assert.equal(linked.link.remote.alias, 'frontend');

    const dispatched = await managerStore.handleTool('collab_dispatch', {
      managerThreadId: 'remote-manager-1',
      worker: linked.link.workerThreadId,
      task: 'Build the remote page',
      acceptance: 'Page renders and exposes a health endpoint',
    });
    assert.equal(dispatched.delivery.kind, 'relay');
    assert.equal(dispatched.delivery.sent, true);

    const workerMessages = await relayFetch({
      relayUrl,
      token,
      path: `/v1/poll?room=${relay.hubRoom}&device=worker-dev&since=0`,
    });
    const dispatchMessage = workerMessages.messages.find((message) => message.type === 'dispatch');
    assert.ok(dispatchMessage);
    const workerOutcome = workerStore.handleRemoteMessage(dispatchMessage);
    assert.equal(workerOutcome.notification.threadId, 'remote-worker-1');
    assert.match(workerOutcome.notification.messageText, /Build the remote page/);

    const reported = await workerStore.handleTool('collab_report', {
      workerThreadId: 'remote-worker-1',
      round: 1,
      status: 'done',
      summary: 'Remote page complete',
      details: 'Render and health endpoint verified',
      next: 'Manager review',
    });
    assert.equal(reported.remote, true);
    assert.equal(reported.delivery.sent, true);

    const managerMessages = await relayFetch({
      relayUrl,
      token,
      path: `/v1/poll?room=${relay.hubRoom}&device=manager-dev&since=0`,
    });
    const reportMessage = managerMessages.messages.find((message) => message.type === 'report');
    assert.ok(reportMessage);
    const managerOutcome = managerStore.handleRemoteMessage(reportMessage);
    assert.equal(managerOutcome.notification.threadId, 'remote-manager-1');
    assert.match(managerOutcome.notification.messageText, /Remote page complete/);
    const managerBoard = await managerStore.handleTool('collab_board', {});
    assert.equal(managerBoard.links[0].pending, null);
    assert.equal(managerBoard.links[0].lastReport.status, 'done');

    await managerStore.handleTool('collab_done', {
      managerThreadId: 'remote-manager-1',
      worker: linked.link.workerThreadId,
      summary: 'Remote delivery accepted',
    });
    const workerLifecycle = await relayFetch({
      relayUrl,
      token,
      path: `/v1/poll?room=${relay.hubRoom}&device=worker-dev&since=${dispatchMessage.id}`,
    });
    const doneMessage = workerLifecycle.messages.find((message) => message.type === 'done');
    assert.ok(doneMessage);
    const doneOutcome = workerStore.handleRemoteMessage(doneMessage);
    assert.equal(doneOutcome.notification.kind, 'remote-done');
  } finally {
    hub.kill();
  }
}

async function relayFetch({ relayUrl, token, path }) {
  const response = await fetch(`${relayUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const value = await response.json();
  assert.equal(response.ok, true);
  assert.equal(value.ok, true);
  return value;
}

function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createTcpServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

function testMcpHandshake(serverFile, codexHome) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [serverFile], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error('MCP handshake timed out'));
    }, 5000);
    let initialized;
    let listed;
    let called;
    let resources;
    let appResource;
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    stdout.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) initialized = message.result;
      if (message.id === 2) listed = message.result;
      if (message.id === 3) called = message.result;
      if (message.id === 4) resources = message.result;
      if (message.id === 5) appResource = message.result;
      if (
        initialized !== undefined
        && listed !== undefined
        && called !== undefined
        && resources !== undefined
        && appResource !== undefined
      ) {
        clearTimeout(timer);
        child.kill();
        resolvePromise({
          protocolVersion: initialized.protocolVersion,
          toolCount: Array.isArray(listed.tools) ? listed.tools.length : -1,
          toolCallOk: called?.isError === false && called?.structuredContent?.ok === true,
          mcpAppOk:
            listed?.tools?.find?.((tool) => tool.name === 'collab_dashboard')?._meta?.ui?.resourceUri
              === 'ui://collab-pair/dashboard.html'
            &&
            resources?.resources?.some?.((resource) => resource.uri === 'ui://collab-pair/dashboard.html')
            && appResource?.contents?.[0]?.mimeType === 'text/html;profile=mcp-app'
            && typeof appResource?.contents?.[0]?.text === 'string'
            && appResource.contents[0].text.includes('双对话协作'),
        });
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('exit', (code) => {
      if (
        initialized === undefined
        || listed === undefined
        || called === undefined
        || resources === undefined
        || appResource === undefined
      ) {
        clearTimeout(timer);
        rejectPromise(new Error(`MCP server exited early (${code}): ${stderr.join('')}`));
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'selftest', version: '1.0.0' },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'collab_board', arguments: {} },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/list',
      params: {},
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'ui://collab-pair/dashboard.html' },
    })}\n`);
  });
}
