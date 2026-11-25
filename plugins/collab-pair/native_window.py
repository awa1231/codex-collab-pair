#!/usr/bin/env python3
"""Native Windows collaboration dashboard for the Codex collab-pair plugin."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import messagebox, simpledialog, ttk


API = "http://127.0.0.1:43157"
INSTANCE_PORT = 43158
PLUGIN_DIR = Path(__file__).resolve().parent
SERVER_FILE = PLUGIN_DIR / "server.mjs"

BG = "#f4f6fb"
SURFACE = "#ffffff"
SURFACE_ALT = "#edf1f7"
TEXT = "#182033"
MUTED = "#66718a"
LINE = "#d9e0eb"
PRIMARY = "#2563eb"
PRIMARY_ACTIVE = "#1d4ed8"
SUCCESS = "#147a51"
WARNING = "#9b5c08"
DANGER = "#b92f45"


class AlreadyRunning(RuntimeError):
    pass


def request_json(path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            value = json.loads(error.read().decode("utf-8"))
        except Exception:
            raise RuntimeError(f"HTTP {error.code}") from error
        raise RuntimeError(value.get("error") or f"HTTP {error.code}") from error
    except Exception as error:
        raise RuntimeError(f"无法连接协作服务：{error}") from error
    if isinstance(value, dict) and value.get("ok") is False:
        raise RuntimeError(value.get("error") or "操作失败")
    return value


def service_ready() -> bool:
    try:
        request_json("/health")
        return True
    except Exception:
        return False


def ensure_service() -> None:
    if service_ready():
        return
    if not SERVER_FILE.exists():
        raise RuntimeError(f"缺少协作服务文件：{SERVER_FILE}")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    subprocess.Popen(
        ["node", str(SERVER_FILE), "--dashboard-only"],
        cwd=str(PLUGIN_DIR),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
    )
    for _ in range(20):
        time.sleep(0.15)
        if service_ready():
            return
    raise RuntimeError("协作服务未能在本机启动。")


def acquire_instance_lock() -> socket.socket:
    guard = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        guard.bind(("127.0.0.1", INSTANCE_PORT))
        guard.listen(1)
        return guard
    except OSError as error:
        guard.close()
        raise AlreadyRunning("协作窗口已经打开。") from error


def state_label(link: dict[str, Any]) -> tuple[str, str]:
    if link.get("status") != "active":
        return "已结束", "done"
    if link.get("pending"):
        return "等待回报", "waiting"
    return "空闲", "idle"


def wait_text(seconds: Any) -> str:
    try:
        value = max(0, float(seconds))
    except (TypeError, ValueError):
        return ""
    if value < 60:
        return f"{round(value)} 秒"
    if value < 3600:
        return f"{round(value / 60)} 分钟"
    return f"{round(value / 360) / 10:g} 小时"


def report_text(link: dict[str, Any]) -> str:
    report = link.get("lastReport")
    if not isinstance(report, dict):
        return "还没有回报"
    label = {"done": "完成", "partial": "部分完成", "blocked": "受阻"}.get(
        str(report.get("status")), "未知"
    )
    return f"{label} · {report.get('summary') or '无摘要'}"


class NativeDashboard:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.board: dict[str, Any] = {}
        self.links: dict[str, dict[str, Any]] = {}
        self.worker_choices: dict[str, str] = {}
        self.dispatch_message = ""
        self._after_id: str | None = None

        self.manager_var = tk.StringVar()
        self.manager_title_var = tk.StringVar()
        self.worker_var = tk.StringVar()
        self.worker_title_var = tk.StringVar()
        self.goal_var = tk.StringVar()
        self.project_var = tk.StringVar()
        self.link_mode_var = tk.StringVar(value="temporary")
        self.link_result_var = tk.StringVar(value="")
        self.dispatch_worker_var = tk.StringVar()
        self.config_manager_var = tk.StringVar()
        self.config_language_var = tk.StringVar(value="zh")
        self.config_rounds_var = tk.StringVar(value="0")
        self.config_nudge_var = tk.StringVar(value="20")
        self.config_project_var = tk.StringVar()
        self.config_auto_send_var = tk.StringVar(value="true")
        self.status_var = tk.StringVar(value="正在连接本机协作服务…")

        self._configure_window()
        self._configure_style()
        self._build_ui()
        self.refresh_board(show_error=False)
        self._schedule_refresh()

    def _configure_window(self) -> None:
        self.root.title("双对话协作")
        self.root.geometry("1120x760")
        self.root.minsize(940, 620)
        self.root.configure(bg=BG)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _configure_style(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(".", font=("Microsoft YaHei UI", 10), background=BG, foreground=TEXT)
        style.configure("TFrame", background=BG)
        style.configure("Surface.TFrame", background=SURFACE)
        style.configure("Header.TFrame", background=BG)
        style.configure("TLabel", background=BG, foreground=TEXT)
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 22, "bold"), background=BG)
        style.configure("Subtitle.TLabel", foreground=MUTED, background=BG)
        style.configure("Muted.TLabel", foreground=MUTED, background=BG)
        style.configure("Surface.TLabel", background=SURFACE, foreground=TEXT)
        style.configure("SurfaceMuted.TLabel", background=SURFACE, foreground=MUTED)
        style.configure("StatLabel.TLabel", background=SURFACE_ALT, foreground=MUTED)
        style.configure(
            "StatValue.TLabel",
            background=SURFACE_ALT,
            foreground=TEXT,
            font=("Microsoft YaHei UI", 20, "bold"),
        )
        style.configure(
            "TButton",
            padding=(12, 7),
            font=("Microsoft YaHei UI", 10),
            background=SURFACE,
            foreground=TEXT,
            bordercolor=LINE,
            focusthickness=1,
        )
        style.map("TButton", background=[("active", SURFACE_ALT)])
        style.configure(
            "Primary.TButton",
            background=PRIMARY,
            foreground="#ffffff",
            bordercolor=PRIMARY,
        )
        style.map(
            "Primary.TButton",
            background=[("active", PRIMARY_ACTIVE), ("disabled", "#93a9d8")],
            foreground=[("disabled", "#eef2ff")],
        )
        style.configure(
            "Danger.TButton",
            foreground=DANGER,
            background=SURFACE,
            bordercolor="#e2a4ae",
        )
        style.map("Danger.TButton", background=[("active", "#fff0f2")])
        style.configure(
            "TEntry",
            padding=7,
            fieldbackground=SURFACE,
            foreground=TEXT,
            bordercolor=LINE,
        )
        style.configure(
            "TCombobox",
            padding=6,
            fieldbackground=SURFACE,
            foreground=TEXT,
            bordercolor=LINE,
        )
        style.configure("TNotebook", background=BG, borderwidth=0)
        style.configure("TNotebook.Tab", padding=(14, 8), font=("Microsoft YaHei UI", 10, "bold"))
        style.map(
            "TNotebook.Tab",
            background=[("selected", SURFACE), ("!selected", SURFACE_ALT)],
            foreground=[("selected", PRIMARY), ("!selected", MUTED)],
        )
        style.configure(
            "Treeview",
            background=SURFACE,
            fieldbackground=SURFACE,
            foreground=TEXT,
            rowheight=30,
            bordercolor=LINE,
        )
        style.configure(
            "Treeview.Heading",
            background=SURFACE_ALT,
            foreground=MUTED,
            font=("Microsoft YaHei UI", 9, "bold"),
            padding=8,
        )
        style.map("Treeview", background=[("selected", "#dbe7ff")], foreground=[("selected", TEXT)])

    def _build_ui(self) -> None:
        shell = ttk.Frame(self.root, padding=(24, 20, 24, 16))
        shell.pack(fill="both", expand=True)

        header = ttk.Frame(shell, style="Header.TFrame")
        header.pack(fill="x", pady=(0, 16))
        title_group = ttk.Frame(header, style="Header.TFrame")
        title_group.pack(side="left", fill="x", expand=True)
        ttk.Label(title_group, text="双对话协作", style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            title_group,
            text="项目经理线程 · 多员工线程 · 多轮任务看板",
            style="Subtitle.TLabel",
        ).pack(anchor="w", pady=(4, 0))
        ttk.Button(header, text="刷新看板", command=self.refresh_board).pack(side="right")

        stats = ttk.Frame(shell, style="TFrame")
        stats.pack(fill="x", pady=(0, 14))
        for index in range(4):
            stats.columnconfigure(index, weight=1, uniform="stats")
        self.active_value = self._stat_card(stats, 0, "进行中")
        self.waiting_value = self._stat_card(stats, 1, "等待回报")
        self.idle_value = self._stat_card(stats, 2, "空闲员工")
        self.total_value = self._stat_card(stats, 3, "全部任务")

        self.notebook = ttk.Notebook(shell)
        self.notebook.pack(fill="both", expand=True)
        self._build_board_tab()
        self._build_link_tab()
        self._build_dispatch_tab()
        self._build_settings_tab()

        footer = ttk.Frame(shell, style="Header.TFrame")
        footer.pack(fill="x", pady=(10, 0))
        ttk.Label(footer, textvariable=self.status_var, style="Muted.TLabel").pack(side="left")
        self.storage_var = tk.StringVar(value="")
        ttk.Label(footer, textvariable=self.storage_var, style="Muted.TLabel").pack(side="right")

    def _stat_card(self, parent: ttk.Frame, column: int, label: str) -> ttk.Label:
        card = ttk.Frame(parent, style="Surface.TFrame", padding=(15, 12))
        card.grid(row=0, column=column, sticky="nsew", padx=(0 if column == 0 else 8, 0))
        ttk.Label(card, text=label, style="StatLabel.TLabel").pack(anchor="w")
        value = ttk.Label(card, text="0", style="StatValue.TLabel")
        value.pack(anchor="w", pady=(3, 0))
        return value

    def _build_board_tab(self) -> None:
        tab = ttk.Frame(self.notebook, style="Surface.TFrame", padding=14)
        self.notebook.add(tab, text="任务看板")

        toolbar = ttk.Frame(tab, style="Surface.TFrame")
        toolbar.pack(fill="x", pady=(0, 10))
        ttk.Label(toolbar, text="全部协作任务", style="Surface.TLabel").pack(side="left")
        ttk.Button(toolbar, text="解除关联", style="Danger.TButton", command=self.unlink_selected).pack(
            side="right", padx=(8, 0)
        )
        ttk.Button(toolbar, text="收尾", command=self.done_selected).pack(side="right", padx=(8, 0))
        ttk.Button(toolbar, text="查看详情", command=self.show_selected_details).pack(side="right")

        tree_frame = ttk.Frame(tab, style="Surface.TFrame")
        tree_frame.pack(fill="both", expand=True)
        columns = ("project", "worker", "manager", "mode", "round", "state", "wait", "task", "report")
        self.tree = ttk.Treeview(tree_frame, columns=columns, show="headings", selectmode="browse")
        headings = {
            "project": "项目",
            "worker": "员工",
            "manager": "项目经理",
            "mode": "关联",
            "round": "轮次",
            "state": "状态",
            "wait": "已等待",
            "task": "本轮任务",
            "report": "最近回报",
        }
        widths = {
            "project": 120,
            "worker": 145,
            "manager": 145,
            "mode": 65,
            "round": 58,
            "state": 82,
            "wait": 74,
            "task": 300,
            "report": 235,
        }
        for column in columns:
            self.tree.heading(column, text=headings[column])
            self.tree.column(
                column,
                width=widths[column],
                minwidth=50,
                anchor="w" if column not in {"round", "wait", "state"} else "center",
            )
        self.tree.tag_configure("waiting", foreground=WARNING)
        self.tree.tag_configure("idle", foreground=PRIMARY)
        self.tree.tag_configure("done", foreground=MUTED)
        y_scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        x_scroll = ttk.Scrollbar(tree_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")
        tree_frame.rowconfigure(0, weight=1)
        tree_frame.columnconfigure(0, weight=1)
        self.tree.bind("<<TreeviewSelect>>", self.on_task_selected)
        self.tree.bind("<Double-1>", lambda _event: self.show_selected_details())

        ttk.Label(
            tab,
            text="等待回报：该轮任务已经记录，员工尚未结束本轮。空闲：经理需要派发下一轮或收尾。",
            style="SurfaceMuted.TLabel",
        ).pack(anchor="w", pady=(9, 0))

    def _build_link_tab(self) -> None:
        tab = ttk.Frame(self.notebook, style="Surface.TFrame", padding=18)
        self.notebook.add(tab, text="关联员工")
        self._form_label(tab, "项目经理线程 ID", 0)
        ttk.Entry(tab, textvariable=self.manager_var).grid(row=1, column=0, sticky="ew", pady=(4, 12))
        self._form_label(tab, "项目经理标题", 0, column=1)
        ttk.Entry(tab, textvariable=self.manager_title_var).grid(
            row=1, column=1, sticky="ew", pady=(4, 12), padx=(12, 0)
        )
        self._form_label(tab, "员工线程 ID", 2)
        ttk.Entry(tab, textvariable=self.worker_var).grid(row=3, column=0, sticky="ew", pady=(4, 12))
        self._form_label(tab, "员工标题", 2, column=1)
        ttk.Entry(tab, textvariable=self.worker_title_var).grid(
            row=3, column=1, sticky="ew", pady=(4, 12), padx=(12, 0)
        )
        self._form_label(tab, "项目总目标", 4)
        ttk.Entry(tab, textvariable=self.goal_var).grid(
            row=5, column=0, columnspan=2, sticky="ew", pady=(4, 16)
        )
        self._form_label(tab, "项目名称", 6)
        ttk.Entry(tab, textvariable=self.project_var).grid(
            row=7, column=0, sticky="ew", pady=(4, 16)
        )
        self._form_label(tab, "关联模式", 6, column=1)
        ttk.Combobox(
            tab,
            textvariable=self.link_mode_var,
            values=("temporary", "permanent"),
            state="readonly",
        ).grid(row=7, column=1, sticky="ew", pady=(4, 16), padx=(12, 0))
        actions = ttk.Frame(tab, style="Surface.TFrame")
        actions.grid(row=8, column=0, columnspan=2, sticky="ew")
        ttk.Button(actions, text="建立关联", style="Primary.TButton", command=self.link_worker).pack(
            side="left"
        )
        ttk.Label(actions, textvariable=self.link_result_var, style="SurfaceMuted.TLabel").pack(
            side="left", padx=(12, 0)
        )
        ttk.Label(
            tab,
            text="线程 ID 可从 Codex 的线程列表或 $collab-pair 获取。一个经理可以关联多个员工。",
            style="SurfaceMuted.TLabel",
        ).grid(row=9, column=0, columnspan=2, sticky="w", pady=(14, 0))
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(1, weight=1)

    def _build_dispatch_tab(self) -> None:
        tab = ttk.Frame(self.notebook, style="Surface.TFrame", padding=18)
        self.notebook.add(tab, text="派发任务")
        self._form_label(tab, "项目经理线程 ID", 0)
        ttk.Entry(tab, textvariable=self.manager_var).grid(row=1, column=0, sticky="ew", pady=(4, 12))
        self._form_label(tab, "员工线程", 0, column=1)
        self.dispatch_combo = ttk.Combobox(
            tab,
            textvariable=self.dispatch_worker_var,
            state="readonly",
            values=[],
        )
        self.dispatch_combo.grid(row=1, column=1, sticky="ew", pady=(4, 12), padx=(12, 0))
        self._form_label(tab, "本轮任务", 2)
        self.dispatch_task = tk.Text(
            tab,
            height=6,
            wrap="word",
            font=("Microsoft YaHei UI", 10),
            background=SURFACE,
            foreground=TEXT,
            insertbackground=TEXT,
            relief="solid",
            borderwidth=1,
            highlightthickness=0,
            padx=8,
            pady=7,
        )
        self.dispatch_task.grid(row=3, column=0, columnspan=2, sticky="nsew", pady=(4, 12))
        self._form_label(tab, "验收标准", 4)
        self.dispatch_acceptance = tk.Text(
            tab,
            height=4,
            wrap="word",
            font=("Microsoft YaHei UI", 10),
            background=SURFACE,
            foreground=TEXT,
            insertbackground=TEXT,
            relief="solid",
            borderwidth=1,
            highlightthickness=0,
            padx=8,
            pady=7,
        )
        self.dispatch_acceptance.grid(row=5, column=0, columnspan=2, sticky="nsew", pady=(4, 12))
        actions = ttk.Frame(tab, style="Surface.TFrame")
        actions.grid(row=6, column=0, columnspan=2, sticky="ew")
        ttk.Button(
            actions,
            text="生成并记录本轮",
            style="Primary.TButton",
            command=self.dispatch_round,
        ).pack(side="left")
        ttk.Button(actions, text="复制任务提示词", command=self.copy_dispatch).pack(
            side="left", padx=(8, 0)
        )
        ttk.Label(
            tab,
            text="生成后把提示词发送给对应员工线程；员工完成时用 collab_report 汇报。",
            style="SurfaceMuted.TLabel",
        ).grid(row=7, column=0, columnspan=2, sticky="w", pady=(14, 0))
        self.prompt_preview = tk.Text(
            tab,
            height=7,
            wrap="word",
            font=("Consolas", 9),
            background=SURFACE_ALT,
            foreground=TEXT,
            relief="flat",
            padx=9,
            pady=8,
        )
        self.prompt_preview.grid(row=8, column=0, columnspan=2, sticky="nsew", pady=(10, 0))
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(3, weight=1)
        tab.rowconfigure(5, weight=1)
        tab.rowconfigure(8, weight=1)

    def _build_settings_tab(self) -> None:
        tab = ttk.Frame(self.notebook, style="Surface.TFrame", padding=18)
        self.notebook.add(tab, text="协作设置")
        self._form_label(tab, "项目经理线程 ID", 0)
        ttk.Entry(tab, textvariable=self.config_manager_var).grid(
            row=1, column=0, columnspan=2, sticky="ew", pady=(4, 12)
        )
        self._form_label(tab, "消息语言", 2)
        ttk.Combobox(
            tab,
            textvariable=self.config_language_var,
            values=("zh", "en"),
            state="readonly",
        ).grid(row=3, column=0, sticky="ew", pady=(4, 12))
        self._form_label(tab, "最大轮次", 2, column=1)
        ttk.Entry(tab, textvariable=self.config_rounds_var).grid(
            row=3, column=1, sticky="ew", pady=(4, 12), padx=(12, 0)
        )
        self._form_label(tab, "项目名称", 4)
        ttk.Entry(tab, textvariable=self.config_project_var).grid(
            row=5, column=0, columnspan=2, sticky="ew", pady=(4, 12)
        )
        self._form_label(tab, "空闲提醒间隔（分钟）", 6)
        ttk.Entry(tab, textvariable=self.config_nudge_var).grid(
            row=7, column=0, sticky="ew", pady=(4, 12)
        )
        self._form_label(tab, "自动派发", 6, column=1)
        ttk.Combobox(
            tab,
            textvariable=self.config_auto_send_var,
            values=("true", "false"),
            state="readonly",
        ).grid(
            row=7, column=1, sticky="ew", pady=(4, 12), padx=(12, 0)
        )
        ttk.Button(
            tab,
            text="保存设置",
            style="Primary.TButton",
            command=self.save_settings,
        ).grid(row=8, column=0, sticky="w", pady=(4, 0))
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(1, weight=1)

    @staticmethod
    def _form_label(parent: ttk.Frame, text: str, row: int, column: int = 0) -> None:
        ttk.Label(parent, text=text, style="SurfaceMuted.TLabel").grid(
            row=row,
            column=column,
            sticky="w",
            padx=(0 if column == 0 else 12, 0),
        )

    def refresh_board(self, show_error: bool = True) -> None:
        try:
            board = request_json("/api/board")
            self.board = board if isinstance(board, dict) else {}
            links = self.board.get("links")
            rows = links if isinstance(links, list) else []
            self.links = {
                str(link.get("linkId")): link
                for link in rows
                if isinstance(link, dict) and link.get("linkId")
            }
            active = [link for link in rows if link.get("status") == "active"]
            waiting = [link for link in active if link.get("pending")]
            idle = [link for link in active if not link.get("pending")]
            self.active_value.configure(text=str(self.board.get("activeCount", len(active))))
            self.waiting_value.configure(text=str(len(waiting)))
            self.idle_value.configure(text=str(len(idle)))
            self.total_value.configure(text=str(self.board.get("totalCount", len(rows))))
            self._render_tree(rows)
            self._render_worker_choices(active)
            generated = self.board.get("generatedAt")
            self.status_var.set(
                f"服务运行中 · {len(active)} 个进行中 · 最近刷新 {generated or '刚刚'}"
            )
            self.storage_var.set(str(self.board.get("storage") or ""))
        except Exception as error:
            self.status_var.set(f"读取失败：{error}")
            if show_error:
                messagebox.showerror("双对话协作", str(error), parent=self.root)

    def _render_tree(self, rows: list[dict[str, Any]]) -> None:
        selected = self.tree.selection()
        selected_id = selected[0] if selected else None
        for item in self.tree.get_children():
            self.tree.delete(item)
        for link in rows:
            if not isinstance(link, dict):
                continue
            label, tag = state_label(link)
            pending = link.get("pending") if isinstance(link.get("pending"), dict) else None
            task = (pending or {}).get("task") or link.get("finalSummary") or "当前没有待执行任务"
            wait = wait_text((pending or {}).get("waitedSeconds")) if pending else ""
            self.tree.insert(
                "",
                "end",
                iid=str(link.get("linkId")),
                values=(
                    link.get("projectName") or "",
                    link.get("workerTitle") or link.get("workerThreadId") or "",
                    link.get("managerTitle") or link.get("managerThreadId") or "",
                    "永久" if link.get("mode") == "permanent" else "临时",
                    link.get("round") or 0,
                    label,
                    wait,
                    str(task).replace("\n", " ")[:120],
                    report_text(link)[:100],
                ),
                tags=(tag,),
            )
        if selected_id and self.tree.exists(selected_id):
            self.tree.selection_set(selected_id)

    def _render_worker_choices(self, active: list[dict[str, Any]]) -> None:
        self.worker_choices = {}
        values = []
        for link in active:
            label = (
                f"{link.get('workerTitle') or link.get('workerThreadId')} · 第 "
                f"{link.get('round') or 0} 轮 · {link.get('workerThreadId')}"
            )
            self.worker_choices[label] = str(link.get("workerThreadId"))
            values.append(label)
        self.dispatch_combo.configure(values=values)
        if values and self.dispatch_worker_var.get() not in self.worker_choices:
            self.dispatch_worker_var.set(values[0])

    def selected_link(self) -> dict[str, Any] | None:
        selection = self.tree.selection()
        return self.links.get(selection[0]) if selection else None

    def on_task_selected(self, _event: Any = None) -> None:
        link = self.selected_link()
        if not link:
            return
        self.manager_var.set(str(link.get("managerThreadId") or ""))
        self.worker_var.set(str(link.get("workerThreadId") or ""))
        self.config_manager_var.set(str(link.get("managerThreadId") or ""))
        self.project_var.set(str(link.get("projectName") or ""))
        self.config_project_var.set(str(link.get("projectName") or ""))
        self.link_mode_var.set(str(link.get("mode") or "temporary"))
        worker_id = str(link.get("workerThreadId") or "")
        for label, value in self.worker_choices.items():
            if value == worker_id:
                self.dispatch_worker_var.set(label)
                break

    def link_worker(self) -> None:
        manager = self.manager_var.get().strip()
        worker = self.worker_var.get().strip()
        if not manager or not worker:
            messagebox.showwarning("缺少信息", "项目经理和员工线程 ID 都必须填写。", parent=self.root)
            return
        try:
            value = request_json(
                "/api/action",
                "POST",
                {
                    "name": "collab_link",
                    "arguments": {
                        "currentThreadId": manager,
                        "peerThreadId": worker,
                        "role": "manager",
                        "currentTitle": self.manager_title_var.get().strip(),
                        "peerTitle": self.worker_title_var.get().strip(),
                        "goal": self.goal_var.get().strip(),
                        "projectName": self.project_var.get().strip(),
                        "mode": self.link_mode_var.get(),
                    },
                },
            )
            link = value.get("link") or {}
            self.link_result_var.set(f"已关联 {link.get('workerTitle') or worker}")
            self.refresh_board(show_error=False)
        except Exception as error:
            messagebox.showerror("关联失败", str(error), parent=self.root)

    def dispatch_round(self) -> None:
        manager = self.manager_var.get().strip()
        worker = self.worker_choices.get(self.dispatch_worker_var.get(), "")
        task = self.dispatch_task.get("1.0", "end").strip()
        acceptance = self.dispatch_acceptance.get("1.0", "end").strip()
        if not manager or not worker or not task:
            messagebox.showwarning(
                "缺少信息",
                "项目经理、员工和本轮任务都必须填写。",
                parent=self.root,
            )
            return
        try:
            value = request_json(
                "/api/action",
                "POST",
                {
                    "name": "collab_dispatch",
                    "arguments": {
                        "managerThreadId": manager,
                        "worker": worker,
                        "task": task,
                        "acceptance": acceptance,
                    },
                },
            )
            self.dispatch_message = str((value.get("dispatch") or {}).get("messageText") or "")
            self.prompt_preview.delete("1.0", "end")
            self.prompt_preview.insert("1.0", self.dispatch_message)
            self.dispatch_task.delete("1.0", "end")
            self.dispatch_acceptance.delete("1.0", "end")
            self.refresh_board(show_error=False)
            messagebox.showinfo(
                "已派发",
                (
                    f"第 {value.get('round')} 轮已自动派发到员工线程。"
                    if (value.get("delivery") or {}).get("sent")
                    else f"第 {value.get('round')} 轮已记录。请复制任务提示词并发送到员工线程。"
                ),
                parent=self.root,
            )
        except Exception as error:
            messagebox.showerror("派发失败", str(error), parent=self.root)

    def copy_dispatch(self) -> None:
        if not self.dispatch_message:
            messagebox.showwarning("没有内容", "先生成一轮协作任务。", parent=self.root)
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.dispatch_message)
        self.status_var.set("任务提示词已复制到剪贴板")

    def done_selected(self) -> None:
        link = self.selected_link()
        if not link:
            messagebox.showwarning("没有选择", "先在任务表中选择一个员工。", parent=self.root)
            return
        summary = simpledialog.askstring(
            "协作收尾",
            "输入最终验收总结：",
            parent=self.root,
        )
        if summary is None:
            return
        if not summary.strip():
            messagebox.showwarning("缺少总结", "验收总结不能为空。", parent=self.root)
            return
        try:
            request_json(
                "/api/action",
                "POST",
                {
                    "name": "collab_done",
                    "arguments": {
                        "managerThreadId": link.get("managerThreadId"),
                        "worker": link.get("workerThreadId"),
                        "summary": summary.strip(),
                    },
                },
            )
            self.refresh_board(show_error=False)
        except Exception as error:
            messagebox.showerror("收尾失败", str(error), parent=self.root)

    def unlink_selected(self) -> None:
        link = self.selected_link()
        if not link:
            messagebox.showwarning("没有选择", "先在任务表中选择一个员工。", parent=self.root)
            return
        if not messagebox.askyesno(
            "解除关联",
            f"确定解除与 {link.get('workerTitle') or link.get('workerThreadId')} 的协作关系？",
            parent=self.root,
        ):
            return
        try:
            request_json(
                "/api/action",
                "POST",
                {
                    "name": "collab_unlink",
                    "arguments": {
                        "threadId": link.get("managerThreadId"),
                        "worker": link.get("workerThreadId"),
                    },
                },
            )
            self.refresh_board(show_error=False)
        except Exception as error:
            messagebox.showerror("解除失败", str(error), parent=self.root)

    def show_selected_details(self) -> None:
        link = self.selected_link()
        if not link:
            messagebox.showwarning("没有选择", "先在任务表中选择一个员工。", parent=self.root)
            return
        window = tk.Toplevel(self.root)
        window.title(f"协作详情 · {link.get('workerTitle') or link.get('workerThreadId')}")
        window.geometry("760x580")
        window.configure(bg=SURFACE)
        text = tk.Text(
            window,
            wrap="word",
            font=("Microsoft YaHei UI", 10),
            background=SURFACE,
            foreground=TEXT,
            relief="flat",
            padx=18,
            pady=16,
        )
        text.pack(fill="both", expand=True)
        details = json.dumps(link, ensure_ascii=False, indent=2)
        text.insert("1.0", details)
        text.configure(state="disabled")

    def save_settings(self) -> None:
        manager = self.config_manager_var.get().strip()
        if not manager:
            messagebox.showwarning("缺少信息", "项目经理线程 ID 不能为空。", parent=self.root)
            return
        try:
            rounds = int(self.config_rounds_var.get())
            nudge = int(self.config_nudge_var.get())
            request_json(
                "/api/action",
                "POST",
                {
                    "name": "collab_config",
                    "arguments": {
                        "managerThreadId": manager,
                        "config": {
                            "language": self.config_language_var.get(),
                            "maxRounds": rounds,
                            "nudgeAfterMinutes": nudge,
                            "autoSend": self.config_auto_send_var.get() == "true",
                        },
                    },
                },
            )
            project = self.config_project_var.get().strip()
            if project:
                request_json(
                    "/api/action",
                    "POST",
                    {
                        "name": "collab_project",
                        "arguments": {
                            "managerThreadId": manager,
                            "name": project,
                        },
                    },
                )
            messagebox.showinfo("已保存", "协作设置已保存。", parent=self.root)
            self.refresh_board(show_error=False)
        except Exception as error:
            messagebox.showerror("保存失败", str(error), parent=self.root)

    def _schedule_refresh(self) -> None:
        self._after_id = self.root.after(5000, self._poll)

    def _poll(self) -> None:
        self.refresh_board(show_error=False)
        self._schedule_refresh()

    def close(self) -> None:
        if self._after_id:
            self.root.after_cancel(self._after_id)
        self.root.destroy()


def self_test() -> int:
    ensure_service()
    board = request_json("/api/board")
    print(
        json.dumps(
            {
                "ok": True,
                "service": f"{API}/health",
                "activeCount": board.get("activeCount", 0),
                "totalCount": board.get("totalCount", 0),
            },
            ensure_ascii=False,
        )
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Codex collab-pair native dashboard")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    try:
        ensure_service()
        guard = acquire_instance_lock()
    except AlreadyRunning:
        return 0
    except Exception as error:
        messagebox.showerror("双对话协作", str(error))
        return 1
    root = tk.Tk()
    NativeDashboard(root)
    try:
        root.mainloop()
    finally:
        guard.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
