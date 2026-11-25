(() => {
  const sdk = globalThis.__COLLAB_MCP_APP_SDK__;
  if (!sdk?.App) {
    document.body.textContent = 'MCP App runtime unavailable. Reinstall the collab-pair plugin.';
    return;
  }

  const {
    App,
    applyDocumentTheme,
    applyHostStyleVariables,
    applyHostFonts,
  } = sdk;

  const elements = {
    activeCount: document.getElementById('activeCount'),
    waitingCount: document.getElementById('waitingCount'),
    idleCount: document.getElementById('idleCount'),
    totalCount: document.getElementById('totalCount'),
    generatedAt: document.getElementById('generatedAt'),
    taskList: document.getElementById('taskList'),
    storagePath: document.getElementById('storagePath'),
    healthText: document.getElementById('healthText'),
    refreshButton: document.getElementById('refreshButton'),
    fullscreenButton: document.getElementById('fullscreenButton'),
    dispatchManager: document.getElementById('dispatchManager'),
    dispatchWorker: document.getElementById('dispatchWorker'),
    dispatchForm: document.getElementById('dispatchForm'),
    dispatchTask: document.getElementById('dispatchTask'),
    dispatchAcceptance: document.getElementById('dispatchAcceptance'),
    dispatchResult: document.getElementById('dispatchResult'),
    dispatchResultTitle: document.getElementById('dispatchResultTitle'),
    dispatchMessage: document.getElementById('dispatchMessage'),
    copyDispatch: document.getElementById('copyDispatch'),
    linkForm: document.getElementById('linkForm'),
    linkManager: document.getElementById('linkManager'),
    configForm: document.getElementById('configForm'),
    configManager: document.getElementById('configManager'),
    configProject: document.getElementById('configProject'),
    configLanguage: document.getElementById('configLanguage'),
    configRounds: document.getElementById('configRounds'),
    configNudge: document.getElementById('configNudge'),
    configAutoSend: document.getElementById('configAutoSend'),
    openNativeButton: document.getElementById('openNativeButton'),
    relayForm: document.getElementById('relayForm'),
    relaySummary: document.getElementById('relaySummary'),
    aliasForm: document.getElementById('aliasForm'),
    aliasSession: document.getElementById('aliasSession'),
    remoteLinkForm: document.getElementById('remoteLinkForm'),
    remoteManager: document.getElementById('remoteManager'),
    toast: document.getElementById('toast'),
  };

  const app = new App(
    { name: '双对话协作', version: '1.4.0' },
    {},
    { autoResize: true, strict: false },
  );

  let currentThreadId = '';
  let board = null;
  let filter = 'all';
  let toastTimer = null;
  let displayMode = 'inline';
  let refreshedOnce = false;
  const previewMode = new URLSearchParams(window.location.search).get('preview') === '1';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    elements.toast.textContent = String(message ?? '');
    elements.toast.className = `toast show${isError ? ' error' : ''}`;
    toastTimer = setTimeout(() => {
      elements.toast.className = 'toast';
    }, 4200);
  }

  function setBusy(button, busy) {
    if (button instanceof HTMLButtonElement) button.disabled = busy;
  }

  function stateOf(link) {
    if (link.status !== 'active') return { key: 'done', label: '已结束', css: 'finished' };
    if (link.pending) return { key: 'waiting', label: '等待回报', css: 'waiting' };
    return { key: 'idle', label: '空闲', css: 'idle' };
  }

  function formatWait(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return `${Math.round(seconds)} 秒`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
    return `${Math.round(seconds / 360) / 10} 小时`;
  }

  function reportText(report) {
    if (!report) return '还没有回报';
    const label = report.status === 'done'
      ? '完成'
      : report.status === 'blocked'
        ? '受阻'
        : report.status === 'partial'
          ? '部分完成'
          : '未显式汇报';
    return `${label} · ${report.summary || '无摘要'}`;
  }

  function normalizeToolValue(result) {
    if (result === null || typeof result !== 'object') return result;
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content?.find?.((item) => item?.type === 'text')?.text;
    if (typeof text === 'string' && text.trim() !== '') {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result;
  }

  async function callTool(name, args = {}) {
    const result = await app.callServerTool({ name, arguments: args });
    const value = normalizeToolValue(result);
    if (result?.isError || value?.ok === false) {
      throw new Error(value?.error || value?.message || result?.content?.find?.((item) => item?.type === 'text')?.text || `${name} 失败`);
    }
    return value;
  }

  function applyHostContext(context) {
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
    if (context?.displayMode) {
      displayMode = context.displayMode;
      document.body.classList.toggle('fullscreen', displayMode === 'fullscreen');
      elements.fullscreenButton.textContent = displayMode === 'fullscreen' ? '退出全屏' : '全屏';
    }
    const fullscreenAvailable = context?.availableDisplayModes?.includes?.('fullscreen') === true;
    elements.fullscreenButton.hidden = !fullscreenAvailable;
    if (context?.safeAreaInsets) {
      const { top, right, bottom, left } = context.safeAreaInsets;
      document.getElementById('shell').style.padding = `calc(18px + ${top}px) calc(16px + ${right}px) calc(32px + ${bottom}px) calc(16px + ${left}px)`;
    }
  }

  function captureToolValue(value) {
    if (value === null || typeof value !== 'object') return;
    if (typeof value.currentThreadId === 'string' && value.currentThreadId.trim() !== '') {
      currentThreadId = value.currentThreadId.trim();
      prefillThreadIds();
    }
    const nextBoard = value.board?.links ? value.board : value.links ? value : null;
    if (nextBoard) {
      board = nextBoard;
      renderBoard();
      applyBoardDefaults();
    }
    if (value.relay && board && !board.relay) board.relay = value.relay;
    if (value.manager?.config && board) {
      board.currentManager = value.manager;
      applyBoardDefaults();
    }
  }

  app.onhostcontextchanged = (context) => {
    applyHostContext(context);
  };

  app.ontoolresult = (result) => {
    captureToolValue(normalizeToolValue(result));
  };

  app.ontoolinput = () => {};
  app.ontoolcancelled = (params) => {
    showToast(`工具调用已取消：${params?.reason || '未知原因'}`, true);
  };
  app.onerror = (error) => {
    showToast(error instanceof Error ? error.message : String(error), true);
  };
  app.onteardown = async () => ({});

  function prefillThreadIds() {
    if (!currentThreadId) return;
    if (elements.dispatchManager.value === '') elements.dispatchManager.value = currentThreadId;
    if (elements.linkManager.value === '') elements.linkManager.value = currentThreadId;
    if (elements.configManager.value === '') elements.configManager.value = currentThreadId;
    if (elements.remoteManager.value === '') elements.remoteManager.value = currentThreadId;
    if (elements.aliasSession.value === '') elements.aliasSession.value = currentThreadId;
  }

  function applyBoardDefaults() {
    if (!board) return;
    prefillThreadIds();
    const active = board.links.filter((link) => link.status === 'active');
    const defaultManager = elements.configManager.value
      || active[0]?.managerThreadId
      || currentThreadId;
    if (defaultManager) {
      if (elements.dispatchManager.value === '') elements.dispatchManager.value = defaultManager;
      if (elements.linkManager.value === '') elements.linkManager.value = defaultManager;
      if (elements.configManager.value === '') elements.configManager.value = defaultManager;
      if (elements.remoteManager.value === '') elements.remoteManager.value = defaultManager;
    }
    const managerId = elements.dispatchManager.value || defaultManager;
    renderWorkerOptions(managerId);
    const managerStatus = board.currentManager;
    if (managerStatus?.config) {
      elements.configLanguage.value = managerStatus.config.language || 'zh';
      elements.configRounds.value = String(managerStatus.config.maxRounds ?? 0);
      elements.configNudge.value = String(managerStatus.config.nudgeAfterMinutes ?? 20);
      elements.configAutoSend.value = managerStatus.config.autoSend === false ? 'false' : 'true';
      if (!elements.configProject.value) {
        elements.configProject.value = managerStatus.projectName || '';
      }
    }
    const relay = board.relay;
    if (relay) {
      elements.relaySummary.textContent = relay.configured
        ? `设备 ${relay.deviceName} · 房间 ${relay.hubRoom} · ${relay.aliases?.length || 0} 个本机别名${relay.lastError ? ` · ${relay.lastError}` : ''}`
        : '尚未配置 hubUrl 与 hubToken';
      if (!elements.relayForm.elements.deviceName.value) {
        elements.relayForm.elements.deviceName.value = relay.deviceName || '';
      }
      if (!elements.relayForm.elements.hubRoom.value) {
        elements.relayForm.elements.hubRoom.value = relay.hubRoom || 'default';
      }
      if (!elements.relayForm.elements.hubUrl.value && relay.hubUrl) {
        elements.relayForm.elements.hubUrl.value = relay.hubUrl;
      }
    }
  }

  function renderWorkerOptions(managerId) {
    const active = (board?.links || []).filter(
      (link) => link.status === 'active' && (!managerId || link.managerThreadId === managerId),
    );
    const previous = elements.dispatchWorker.value;
    elements.dispatchWorker.innerHTML = active.length === 0
      ? '<option value="">该经理没有活动员工</option>'
      : active.map((link) => (
          `<option value="${esc(link.workerThreadId)}">${esc(link.workerTitle || link.workerThreadId)} · 第 ${Number(link.round) || 0} 轮</option>`
        )).join('');
    elements.dispatchWorker.disabled = active.length === 0;
    if (active.some((link) => link.workerThreadId === previous)) {
      elements.dispatchWorker.value = previous;
    }
  }

  function renderBoard() {
    const links = Array.isArray(board?.links) ? board.links : [];
    const active = links.filter((link) => link.status === 'active');
    const waiting = active.filter((link) => Boolean(link.pending));
    const idle = active.filter((link) => !link.pending);
    elements.activeCount.textContent = String(board?.activeCount ?? active.length);
    elements.waitingCount.textContent = String(waiting.length);
    elements.idleCount.textContent = String(idle.length);
    elements.totalCount.textContent = String(board?.totalCount ?? links.length);
    elements.generatedAt.textContent = board?.generatedAt
      ? `更新于 ${new Date(board.generatedAt).toLocaleString('zh-CN')}`
      : '暂无状态';
    elements.storagePath.textContent = board?.storage ? `状态文件：${board.storage}` : '';
    elements.healthText.textContent = '已连接 Codex';

    const visible = links.filter((link) => {
      if (filter === 'all') return true;
      if (filter === 'active') return link.status === 'active';
      return stateOf(link).key === filter;
    });

    if (visible.length === 0) {
      elements.taskList.innerHTML = `
        <div class="empty">
          <strong>${links.length === 0 ? '还没有协作任务' : '当前筛选没有任务'}</strong>
          <span>${links.length === 0 ? '在对话中关联员工，或直接使用下方表单。' : '切换筛选查看其他任务。'}</span>
        </div>`;
    } else {
      elements.taskList.innerHTML = groupedMarkup(visible);
    }
    applyBoardDefaults();
  }

  function groupedMarkup(visible) {
    const groups = new Map();
    for (const link of visible) {
      const key = `${link.managerThreadId}\u0000${link.projectName || ''}`;
      if (!groups.has(key)) {
        groups.set(key, {
          projectName: link.projectName || '未命名项目',
          managerTitle: link.managerTitle || link.managerThreadId,
          managerThreadId: link.managerThreadId,
          links: [],
        });
      }
      groups.get(key).links.push(link);
    }
    return [...groups.values()].map((group) => `
      <div class="group-head">
        <strong>${esc(group.projectName)}</strong>
        <span>经理：${esc(group.managerTitle)} · ${esc(group.managerThreadId)}</span>
      </div>
      ${group.links.map(taskMarkup).join('')}
    `).join('');
  }

  function taskMarkup(link) {
    const state = stateOf(link);
    const pending = link.pending;
    const report = link.lastReport;
    const wait = pending ? formatWait(pending.waitedSeconds) : '';
    const taskText = pending
      ? pending.task
      : link.finalSummary || '当前没有待执行任务';
    const modeText = link.mode === 'permanent' ? '永久关联' : '临时关联';
    const remoteText = link.remote
      ? ` · 远程 ${esc(link.remote.alias)}@${esc(link.remote.device)}`
      : '';
    return `
      <article class="task" data-link-id="${esc(link.linkId)}">
        <div class="task-main">
          <div class="task-title-row">
            <span class="task-title">${esc(link.workerTitle || link.workerThreadId)}</span>
            <span class="badge ${state.css}">${state.label}</span>
          </div>
          <div class="mono">${esc(link.workerThreadId)}</div>
          <div class="task-meta">${esc(link.projectName || '未命名项目')} · 第 ${Number(link.round) || 0} 轮 · ${modeText}${remoteText}${wait ? ` · 已等待 ${wait}` : ''}</div>
          <div class="task-copy">${esc(taskText)}</div>
          <div class="task-meta">最近回报：${esc(reportText(report))}${link.remote?.lastError ? ` · ${esc(link.remote.lastError)}` : ''}</div>
        </div>
        <div class="task-side">
          ${link.status === 'active' && !pending ? '<button class="button small primary" type="button" data-action="dispatch">派发</button>' : ''}
          ${link.status === 'active' ? '<button class="button small" type="button" data-action="done">收尾</button>' : ''}
          <button class="button small danger" type="button" data-action="unlink">解除</button>
        </div>
      </article>`;
  }

  async function refreshBoard({ quiet = false } = {}) {
    setBusy(elements.refreshButton, true);
    try {
      board = await callTool('collab_app_state', {});
      if (!board?.links) board = { links: [], activeCount: 0, totalCount: 0 };
      renderBoard();
      if (currentThreadId) {
        try {
          const status = await callTool('collab_status', { threadId: currentThreadId });
          if (status?.manager) board.currentManager = status.manager;
          if (status?.relay) board.relay = status.relay;
          applyBoardDefaults();
        } catch {
          // Status is optional when the app is opened from an unlinked thread.
        }
      }
      refreshedOnce = true;
      if (!quiet) showToast('任务板已刷新');
    } catch (error) {
      elements.healthText.textContent = '连接失败';
      if (!quiet) showToast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(elements.refreshButton, false);
    }
  }

  function selectedTask(button) {
    const id = button.closest('[data-link-id]')?.dataset.linkId;
    return (board?.links || []).find((link) => link.linkId === id);
  }

  elements.refreshButton.addEventListener('click', () => void refreshBoard());

  elements.fullscreenButton.addEventListener('click', async () => {
    try {
      const result = await app.requestDisplayMode({
        mode: displayMode === 'fullscreen' ? 'inline' : 'fullscreen',
      });
      displayMode = result.mode;
      elements.fullscreenButton.textContent = displayMode === 'fullscreen' ? '退出全屏' : '全屏';
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  });

  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
      renderBoard();
    });
  });

  elements.dispatchManager.addEventListener('input', () => {
    renderWorkerOptions(elements.dispatchManager.value.trim());
  });

  elements.dispatchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true);
    try {
      const data = new FormData(elements.dispatchForm);
      const result = await callTool('collab_dispatch', {
        managerThreadId: String(data.get('managerThreadId') || '').trim(),
        worker: String(data.get('worker') || '').trim(),
        task: String(data.get('task') || '').trim(),
        acceptance: String(data.get('acceptance') || '').trim(),
      });
      elements.dispatchMessage.value = result.dispatch?.messageText || '';
      elements.dispatchResultTitle.textContent = result.delivery?.sent
        ? `第 ${result.round} 轮已自动派发`
        : `第 ${result.round} 轮等待手动发送`;
      elements.dispatchResult.hidden = false;
      elements.dispatchTask.value = '';
      elements.dispatchAcceptance.value = '';
      showToast(result.delivery?.sent ? '本轮已自动派发' : '本轮已记录，请复制提示词');
      await refreshBoard({ quiet: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(button, false);
    }
  });

  elements.copyDispatch.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(elements.dispatchMessage.value);
      showToast('任务提示词已复制');
    } catch {
      elements.dispatchMessage.select();
      document.execCommand('copy');
      showToast('任务提示词已复制');
    }
  });

  elements.linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true);
    try {
      const data = new FormData(elements.linkForm);
      const result = await callTool('collab_link', {
        currentThreadId: String(data.get('currentThreadId') || '').trim(),
        peerThreadId: String(data.get('peerThreadId') || '').trim(),
        role: 'manager',
        currentTitle: String(data.get('currentTitle') || '').trim(),
        peerTitle: String(data.get('peerTitle') || '').trim(),
        projectName: String(data.get('projectName') || '').trim(),
        mode: String(data.get('mode') || 'temporary'),
        goal: String(data.get('goal') || '').trim(),
      });
      elements.linkManager.value = result.link.managerThreadId;
      elements.dispatchManager.value = result.link.managerThreadId;
      elements.configManager.value = result.link.managerThreadId;
      elements.remoteManager.value = result.link.managerThreadId;
      elements.configProject.value = result.projectName || '';
      showToast(`已关联 ${result.link.workerTitle || result.link.workerThreadId}`);
      await refreshBoard({ quiet: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(button, false);
    }
  });

  elements.configForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true);
    try {
      const data = new FormData(elements.configForm);
      const managerThreadId = String(data.get('managerThreadId') || '').trim();
      await callTool('collab_config', {
        managerThreadId,
        config: {
          language: String(data.get('language') || 'zh'),
          maxRounds: Number(data.get('maxRounds') || 0),
          nudgeAfterMinutes: Number(data.get('nudgeAfterMinutes') || 20),
          autoSend: String(data.get('autoSend')) !== 'false',
        },
      });
      const projectName = String(data.get('projectName') || '').trim();
      if (projectName) await callTool('collab_project', { managerThreadId, name: projectName });
      showToast('设置已保存');
      await refreshBoard({ quiet: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(button, false);
    }
  });

  elements.openNativeButton.addEventListener('click', async () => {
    try {
      await callTool('collab_open_window');
      showToast('原生窗口已启动');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  });

  elements.relayForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true);
    try {
      const data = new FormData(elements.relayForm);
      const result = await callTool('collab_remote', {
        action: 'configure',
        hubUrl: String(data.get('hubUrl') || '').trim(),
        hubToken: String(data.get('hubToken') || '').trim(),
        hubRoom: String(data.get('hubRoom') || 'default').trim(),
        deviceName: String(data.get('deviceName') || '').trim(),
      });
      board.relay = result.relay;
      elements.relaySummary.textContent = result.message || '中继设置已保存';
      showToast('跨设备中继设置已保存');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(button, false);
    }
  });

  elements.aliasForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true);
    try {
      const data = new FormData(elements.aliasForm);
      await callTool('collab_remote', {
        action: 'alias',
        session: String(data.get('session') || '').trim(),
        alias: String(data.get('alias') || '').trim(),
        currentThreadId: String(data.get('session') || '').trim(),
      });
      showToast('本机员工别名已注册');
      await refreshBoard({ quiet: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(button, false);
    }
  });

  elements.remoteLinkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true);
    try {
      const data = new FormData(elements.remoteLinkForm);
      const result = await callTool('collab_remote', {
        action: 'link',
        managerThreadId: String(data.get('managerThreadId') || '').trim(),
        device: String(data.get('device') || '').trim(),
        worker: String(data.get('worker') || '').trim(),
        name: String(data.get('name') || '').trim(),
        mode: String(data.get('mode') || 'temporary'),
      });
      showToast(`已关联远程员工 ${result.link?.workerTitle || ''}`);
      await refreshBoard({ quiet: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(button, false);
    }
  });

  elements.taskList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const link = selectedTask(button);
    if (!link) return;
    if (button.dataset.action === 'dispatch') {
      elements.dispatchManager.value = link.managerThreadId;
      renderWorkerOptions(link.managerThreadId);
      elements.dispatchWorker.value = link.workerThreadId;
      elements.dispatchForm.closest('details').open = true;
      elements.dispatchTask.focus();
      return;
    }
    if (button.dataset.action === 'done') {
      const summary = window.prompt('输入最终验收总结：');
      if (summary === null) return;
      if (summary.trim() === '') {
        showToast('总结不能为空', true);
        return;
      }
      setBusy(button, true);
      try {
        await callTool('collab_done', {
          managerThreadId: link.managerThreadId,
          worker: link.workerThreadId,
          summary: summary.trim(),
        });
        showToast('该员工协作已收尾');
        await refreshBoard({ quiet: true });
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), true);
        setBusy(button, false);
      }
      return;
    }
    if (button.dataset.action === 'unlink') {
      if (!window.confirm(`确定解除与 ${link.workerTitle || link.workerThreadId} 的协作关系？`)) return;
      setBusy(button, true);
      try {
        await callTool('collab_unlink', {
          threadId: link.managerThreadId,
          worker: link.workerThreadId,
        });
        showToast('关联已解除');
        await refreshBoard({ quiet: true });
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), true);
        setBusy(button, false);
      }
    }
  });

  const initialContext = app.getHostContext?.();
  if (initialContext) applyHostContext(initialContext);
  renderBoard();

  if (previewMode) {
    const now = Date.now();
    currentThreadId = 'preview-manager';
    board = {
      storage: 'C:\\Users\\preview\\.codex\\collab-pair\\state.json',
      generatedAt: new Date(now).toISOString(),
      activeCount: 2,
      totalCount: 2,
      relay: {
        configured: true,
        deviceName: 'desktop',
        hubRoom: 'collab-pair',
        aliases: [],
        lastError: null,
      },
      links: [
        {
          linkId: 'preview-a',
          managerThreadId: 'preview-manager',
          managerTitle: '发布 Codex Collab Pair',
          projectName: 'Codex Collab Pair',
          workerThreadId: 'worker-frontend',
          workerTitle: '前端与文档',
          mode: 'permanent',
          status: 'active',
          round: 2,
          pending: {
            task: '检查 MCP App 在 Codex 内嵌视图与全屏模式下的布局。',
            waitedSeconds: 95,
          },
          lastReport: null,
        },
        {
          linkId: 'preview-b',
          managerThreadId: 'preview-manager',
          managerTitle: '发布 Codex Collab Pair',
          projectName: 'Codex Collab Pair',
          workerThreadId: 'remote:laptop:test',
          workerTitle: '跨设备测试',
          mode: 'temporary',
          remote: { device: 'laptop', alias: 'test' },
          status: 'active',
          round: 1,
          pending: null,
          lastReport: {
            status: 'done',
            summary: '中继往返和远程回报已通过',
          },
        },
      ],
    };
    elements.healthText.textContent = 'MCP App 预览';
    renderBoard();
  } else {
  app.connect()
    .then(async () => {
      const context = app.getHostContext?.();
      if (context) applyHostContext(context);
      if (!refreshedOnce) await refreshBoard({ quiet: true });
    })
    .catch((error) => {
      elements.healthText.textContent = 'MCP App 连接失败';
      showToast(error instanceof Error ? error.message : String(error), true);
    });
  }
})();
