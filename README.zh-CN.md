<div align="center">

<img src="resources/icon.png" width="120" alt="CodeCockpit logo" />

# CodeCockpit

**你的 AI 编程智能体驾驶舱。**

在同一个原生窗口里运行、观测、管理多个 AI 编程 CLI 会话（当前支持 Claude Code，openCode 即将接入）——真实 PTY 终端、精确的 token/成本统计、完整的会话历史。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-blue)
![Electron](https://img.shields.io/badge/Electron-45-47848F)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)

[English](README.md) | 简体中文

</div>

---

## 为什么需要 CodeCockpit？

同时驾驭多个 AI 编程智能体意味着：在一堆原始终端窗口里来回切换、搞不清哪个会话烧了多少 token、手动翻历史记录文件。CodeCockpit 把这一切收进一个驾驶舱：

- 一个窗口，多个活跃智能体终端——每个都是真实 PTY，不是文本转储。
- 每个会话的遥测数据直接解析自 Claude Code 自己的会话记录：模型、输入/输出 token、缓存读写、估算成本、工具调用分布、纯 AI 工作时长。
- 历史与工作区状态在重启后完整保留；任何历史会话一键 `--resume` 续聊。

## 特性

- **真实 PTY 终端** — 每个会话运行在独立的 ConPTY 进程中，由 xterm.js 完整渲染，支持选中、复制/粘贴、文件路径拖拽，可并行任意多个会话。
- **精确会话遥测** — 解析 Claude Code 的 jsonl 会话日志：模型、输入/输出 token、缓存读/写、估算成本、轮次、工具调用排行、纯 AI 工作时长。
- **会话仪表盘** — 每个会话底部一条实时状态栏：上下文占用、输出速度、工具使用分布一目了然。
- **历史中心** — 汇集 `~/.claude/projects` 下全部会话，按项目分组，支持重命名、删除（带确认）、拖动排序、搜索、记录大小。分组默认折叠，一键全部展开。
- **工作区持久化** — 启动时完整恢复活跃会话列表；已退出的进程一键 `--resume` 回来。
- **权限模式切换** — default / acceptEdits / plan / bypassPermissions 实时切换、上下文不丢；bypass 模式双重确认。
- **换目录续接上下文** — 项目搬家后切换 cwd 并对同一会话 `--resume`，上下文原样保留。
- **完成通知** — 窗口在后台时智能体完成即弹系统通知，点击跳回。
- **设置中心** — 新会话默认模式/模型、数据目录可迁移、数据导出/导入（zip）、Claude 配置快捷入口、MCP 服务器概览。
- **10 种语言** — English、简体中文、繁體中文、日本語、한국어、Deutsch、Français、Español、Português (Brasil)、Русский。设置里随时切换。
- **多引擎就绪** — 架构保持引擎层中立，openCode 支持已列入计划。

## 环境要求

- **操作系统**：Windows 10 (1809+) 或 Windows 11
- **Node.js** ≥ 20（仅源码构建需要；打包产物无需任何依赖）
- 已安装并可在终端正常使用的 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- Git Bash（Windows 上的 Claude Code CLI 依赖它；CodeCockpit 自动探测常见安装路径）

## 开发

```bash
npm install
npm run dev
```

CodeCockpit 启动时自动定位 `claude` CLI（PATH、WinGet Links、npm 全局）与 Git Bash。

常用脚本：

```bash
npm run dev         # 开发服务器 + electron
npm run typecheck   # tsc 项目引用构建
npm run build       # 编译 main/preload/renderer 到 out/
npm run dist        # 构建 + 打包便携目录 + 带版本 zip 到 dist/
```

`dist` 步骤产出：

- `dist/CodeCockpit/` — 固定名称的便携目录（升级时直接覆盖该目录即可；其中的 `data/` 会保留）
- `dist/CodeCockpit-<版本>-win-x64.zip` — 用于分发的压缩包

## 数据位置

- **应用数据**（会话列表、自定义命名、排序、设置）：便携模式下位于可执行文件旁边的 `data/`，或 `data-dir.txt` 指定的路径。可在设置中更改，或通过导出/导入 zip 迁移。
- **聊天记录**：`~/.claude/projects/<项目目录编码>/<sessionId>.jsonl`，由 Claude Code 自身写入。CodeCockpit 只读取这些文件——绝不改写你的会话记录。

## 国际化

CodeCockpit 内置 10 种语言，渲染进程与主进程（菜单、对话框、通知）共用一套类型安全字典。新增一种语言只需两个文件——见 [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-translation)。

| 语言 | 代码 | 语言 | 代码 |
| --- | --- | --- | --- |
| English | `en` | Deutsch | `de` |
| 简体中文 | `zh-CN` | Français | `fr` |
| 繁體中文 | `zh-TW` | Español | `es` |
| 日本語 | `ja` | Português (Brasil) | `pt-BR` |
| 한국어 | `ko` | Русский | `ru` |

## 路线图

- [x] M1 — PTY 终端核心 + 多会话
- [x] M2 — 会话中心（历史/重命名/删除/排序/持久化）
- [x] M3 — jsonl 镜像管道（精确 token/成本/工具遥测）
- [x] M4 — 会话仪表盘
- [x] M5 — 设置中心 + 数据迁移 + MCP 概览
- [x] M6 — 完成通知 + 打包
- [x] M7 — 国际化（10 种语言）
- [ ] openCode 第二引擎接入
- [ ] macOS / Linux 构建

## 参与贡献

欢迎 Issue 与 PR——尤其是翻译与引擎适配。构建方式与规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © CodeCockpit Contributors
