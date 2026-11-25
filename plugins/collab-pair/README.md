# 双对话协作 · Codex Collab Pair

把 DSH 插件 [`awa1231/dsh-collab-pair`](https://github.com/awa1231/dsh-collab-pair) 的经理—员工线程协作能力移植到 Codex。

一个项目经理线程可以管理多个员工线程，按轮次派发任务、收集结构化汇报、按项目查看进度，并继续下一轮或收尾。插件的主界面是 Codex 内嵌 MCP App，同时保留可选的独立 Windows 原生窗口。

## 功能

- 项目经理管理多个员工，每个员工维护独立轮次、任务、汇报和历史。
- 临时关联在 `collab_done` 后自动解绑；永久关联保留关联与历史，直到手动解除。
- 项目按经理线程分组，可重命名并显示全部任务。
- `collab_dispatch` 默认通过 `codex queue` 自动写入本地员工线程；失败时可回退到 `send_message_to_thread`。
- 员工用 `collab_report` 提交 `done / partial / blocked` 结构化结果。
- 跨设备中继：经理和员工可位于不同 Codex 实例，通过带 Bearer Token 的小型 HTTP hub 通信。
- 标题前缀、自动提醒、轮次上限、消息语言和历史长度可配置。
- Codex 内嵌 MCP App：任务板直接显示在对话或任务侧边面板，不需要打开外部网页。
- 可选的原生 Windows Tkinter 窗口；旧版本地网页只作为不支持 MCP Apps 客户端的兼容入口。

## 安装

把本仓库作为 Codex marketplace 添加后安装插件：

```bash
codex plugin marketplace add awa1231/codex-collab-pair
codex plugin add collab-pair@codex-collab
```

本地开发时也可以直接添加源码目录：

```bash
codex plugin marketplace add D:\插件\collab-pair-marketplace
codex plugin add collab-pair
```

安装或升级后新建一个 Codex 对话，让插件和 MCP 服务重新加载。

## 快速开始

在项目经理对话中说：

```text
用 $collab-pair 把当前项目拆给员工线程。
先关联现有员工；如果用户明确要求新建，再创建员工对话。
```

典型流程：

1. 经理线程调用 `collab_init`，设置目标、项目名和配置。
2. 用 Codex 的 `list_threads` 找员工；仅在用户明确要求时用 `create_thread`。
3. 调用 `collab_link`，选择 `temporary` 或 `permanent`。
4. 调用 `collab_dispatch`。本地员工通过 `codex queue` 自动接收任务。
5. 员工完成并调用 `collab_report`。
6. 经理等待本地员工回合结束、读取最终输出并调用 `collab_complete_round`。
7. 验收后派发下一轮或调用 `collab_done`。

查看完整线程流程：[skills/collab-pair/SKILL.md](skills/collab-pair/SKILL.md) 和 [thread-workflow.md](skills/collab-pair/references/thread-workflow.md)。

## 工具

| 工具 | 用途 |
| --- | --- |
| `collab_init` | 初始化或更新经理线程、目标、项目和配置 |
| `collab_link` | 关联经理与员工，支持临时/永久模式 |
| `collab_project` | 重命名经理线程所属项目 |
| `collab_dispatch` | 记录并自动派发一轮任务 |
| `collab_report` | 员工提交结构化汇报；远程员工会自动回传 |
| `collab_complete_round` | 经理收集本地员工最终产出并完成本轮 |
| `collab_status` | 查看当前线程的经理/员工/远程员工角色与状态 |
| `collab_board` | 查看全部任务与项目分组 |
| `collab_config` | 修改语言、轮次、自动派发、提醒和标题前缀 |
| `collab_done` | 验收并结束一个或全部员工协作 |
| `collab_unlink` | 解除关联 |
| `collab_due` | 查看停滞且需要提醒的轮次 |
| `collab_remote` | 配置中继、注册别名、关联远端员工、查看中继状态 |
| `collab_open_window` | 启动可选的独立 Windows 任务窗口 |
| `collab_dashboard` | 在 Codex 内打开交互式 MCP App 任务板 |

## 跨设备

在一台机器或小 VPS 启动 hub：

```bash
node hub.mjs --port 8787 --token <足够长的随机密钥>
```

跨不可信网络时，用 Cloudflare Tunnel、Tailscale、frp 或反向代理加 HTTPS。

两台设备配置同一个 `hubUrl / hubToken / hubRoom`，使用不同 `deviceName`：

```text
collab_remote({
  action: "configure",
  hubUrl: "https://hub.example.com",
  hubToken: "<共享密钥>",
  hubRoom: "my-project",
  deviceName: "desktop"
})
```

员工设备把本地线程注册成别名：

```text
collab_remote({
  action: "alias",
  alias: "frontend",
  session: "<员工线程 ID>",
  currentTitle: "<员工线程标题>"
})
```

经理设备关联该别名：

```text
collab_remote({
  action: "link",
  managerThreadId: "<经理线程 ID>",
  device: "laptop",
  worker: "frontend",
  name: "前端",
  mode: "temporary"
})
```

hub 只在内存中保留最近 15 分钟、每个房间最多 1000 条消息。持有 token 的设备可以向同房间设备投递提示词，请使用专用房间、强随机 token 和 HTTPS。

## 配置

`collab_config` 支持：

```text
maxRounds: 0              # 0 = 不限制
maxRelayChars: 12000
maxHistory: 20
notifyWorkerOnDone: true
autoRelay: true
autoSend: true            # 使用 codex queue 自动派发
language: zh | en
autoNudge: true
nudgeAfterMinutes: 20
maxNudges: 3
addPrefix: true
prefixManager: 【项目经理】
prefixWorker: 【员工】
```

状态文件：

```text
$CODEX_HOME/collab-pair/state.json
```

未设置 `CODEX_HOME` 时使用 `~/.codex/collab-pair/state.json`。损坏的状态会先备份为 `.corrupt-<timestamp>` 再重建。

## 与 DSH 版本的差异

Codex 的线程工具与 DSH 不同，因此移植版做了以下适配：

- 本地派发使用 Codex CLI 的 `codex queue --resume`，不依赖 Codex 内部数据库。
- Codex 没有插件可调用的“修改现有线程模型/预设”接口；模型只能在用户明确要求新建线程时选择。
- 本地员工的最终回复由经理用 `wait_threads` + `read_thread` 获取；远程员工的 `collab_report` 会立即经 hub 回传并自动完成轮次记录。
- 不提供 DSH 的 `/collab` 原生命令注册；操作通过 MCP 工具和内嵌 MCP App 完成。
- Codex 目前没有 DSH 那种注入任意 React 设置页的公开接口；可视化主入口使用标准 MCP Apps。底层仍是沙箱内单文件 HTML，但由 Codex 直接渲染，不再另开网页。

## 验证

```bash
node --check server.mjs
node --check hub.mjs
node skills/collab-pair/scripts/selftest.mjs
node tools/build-mcp-app.mjs
python -m py_compile native_window.py
python native_window.py --self-test
```

`selftest.mjs` 覆盖本地双员工、项目和关联模式、浏览器 API、MCP 握手，以及真实 hub 进程上的远程派发、远程汇报和收尾通知。

## License

MIT。跨设备中继协议与产品设计参考并改编自 `awa1231/dsh-collab-pair`。
