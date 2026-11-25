# Collab Pair

A small Codex plugin that does three things:

1. Make the current conversation a project manager.
2. Let the manager create employee conversations and delegate work.
3. Keep a persistent todo list for the conversation.

No MCP server, task board, background daemon, or remote relay.

## Portability

Works on Windows, macOS, and Linux with:

- Codex desktop thread tools (`create_thread`, `wait_threads`, and related tools)
- Node.js 20 or newer
- `codex` CLI on `PATH`

If the Codex executable is not on `PATH`, set `CODEX_CLI_PATH` to its absolute path.

Todo state is stored under `$CODEX_HOME/collab-pair/todos.json`, or under `~/.codex` when `CODEX_HOME` is unset. No user path, machine ID, thread ID, port, or credential is bundled with the plugin.

## Install

```bash
codex plugin marketplace add awa1231/codex-collab-pair
codex plugin add collab-pair@codex-collab
```

Start a new Codex conversation after installing.

## Use

Make the current conversation the manager:

```text
Use $collab-pair to make this conversation the project manager.
```

Default title:

```text
[Project Manager] Original title
```

Create an employee:

```text
Create an employee to inspect the login page.
```

The manager creates a new conversation titled:

```text
[Employee] Employee name
```

Then it assigns the task, waits, reads the result, and reports back.

## Todo list

```text
Add these to my todo list:
1. Inspect the login page
2. Fix the validation bug
3. Run the regression tests
```

Manage items:

```text
Show my todo list.
Start the next todo.
Mark it done.
Clear pending todos.
```

The todo list is stored in:

```text
$CODEX_HOME/collab-pair/todos.json
```

## Language

English is the default for role prefixes, generated prompts, statuses, and todo summaries.

Chinese mode is available when explicitly requested:

- `【项目经理】`
- `【员工】`

## 中文简版

- 把当前对话设为项目经理。
- 项目经理可以创建员工对话并分配任务。
- 任意对话可以保存简单待办列表。
- 默认英文；明确要求时使用中文。
- 不包含任务板、服务器、中继或后台进程。

## Limits

Codex plugins cannot add items to the native conversation right-click menu. Start the workflow from the conversation with the `$collab-pair` phrase.

## License

MIT.
