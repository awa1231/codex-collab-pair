# 双对话协作

一个极简 Codex 插件：把当前对话设为项目经理，然后让项目经理自己创建员工对话并分配任务。

它只使用 Codex 自带的：

- `list_threads`
- `create_thread`
- `send_message_to_thread`
- `wait_threads`
- `read_thread`
- `set_thread_title`

没有任务板、数据库、后台服务、跨设备中继或额外窗口。

## 安装

```bash
codex plugin marketplace add awa1231/codex-collab-pair
codex plugin add collab-pair@codex-collab
```

安装后新建一个 Codex 对话。

## 使用

把当前对话设为项目经理：

```text
用 $collab-pair 把这个对话设为项目经理
```

经理会把标题改成：

```text
【项目经理】原标题
```

随后让项目经理创建员工：

```text
让项目经理创建一个前端员工，并让它检查登录页面
```

经理会：

1. 调用 `create_thread` 创建员工对话；
2. 将标题设为 `【员工】<名称>`；
3. 把任务和验收标准发给员工；
4. 等待员工完成；
5. 读取结果并向你汇总。

## 原则

- 只在用户明确要求时创建员工对话。
- 一个经理可以创建多个员工。
- 经理负责目标、拆分、验收和最终回复。
- 员工只执行当前任务并给出最终交付说明。

## 与旧版本的区别

2.0.0 删除了 1.x 的所有复杂能力，只保留“设为经理”和“经理创建员工”两条核心流程。

## License

MIT。
