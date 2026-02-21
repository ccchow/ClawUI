# PRD v2 — Claude Code Session Viewer (MVP)

## 目标
可视化 Claude Code 单个 Session 的历史，并提供交互式续写能力。

## 核心架构

```
~/.claude/projects/*/*.jsonl  →  Backend (JSONL Parser + CLI Runner)  →  Frontend (Timeline + Buttons)
```

**不做：** stdout/stdin 劫持、多 Agent 类型、PWA、AG-UI 全协议

## 数据源
- Claude Code session 存储在 `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`
- 每行一个 JSON 对象，包含 `type`（user/assistant/tool_use/tool_result/file-history-snapshot/progress 等）
- 直接读文件，不需要拦截进程

## 功能模块

### 1. Session 列表页
- 扫描 `~/.claude/projects/` 下所有项目和 session
- 展示：项目名、session 时间、消息数、最新状态
- 点击进入 session 详情

### 2. Session Timeline（核心）
- 将 JSONL 解析为可视化节点，每个节点代表一个 step：
  - 🗣️ User message
  - 🤖 Assistant text response
  - 🔧 Tool call (Read/Write/Edit/Bash/Glob 等) + result
  - ⚠️ Error
- 节点以垂直 timeline/thread 形式渲染
- 每个节点可展开查看详情（完整文本、代码 diff、命令输出等）

### 3. 续写建议 + 执行（核心交互）
- Session timeline 末尾，调用 Claude Code 生成 3 个可能的下一步建议
- 实现方式：`claude --resume <session_id> -p "Based on current session state, suggest 3 possible next steps. Output as JSON: [{title, description, prompt}]"`
- 前端渲染为 3 个按钮
- 用户点击按钮 → 后端执行：`claude --resume <session_id> -p "<selected prompt>"`
- 捕获输出 → 追加到 timeline → 刷新 UI

### 4. 自定义指令输入
- 除了 3 个建议按钮，还提供自由文本输入框
- 用户输入自定义 prompt → 同样通过 `--resume -p` 执行

## 技术栈

### Backend (Node.js / TypeScript)
- **JSONL Parser**: 读取 + 解析 session 文件，提取结构化节点
- **CLI Runner**: 封装 `claude --resume <sid> -p "..."` 调用，捕获 stdout
- **API**: Express/Fastify REST API
  - `GET /api/projects` — 列出项目
  - `GET /api/sessions/:projectId` — 列出 session
  - `GET /api/session/:sessionId` — 解析并返回 timeline 节点
  - `POST /api/session/:sessionId/run` — 执行 `--resume -p` 并返回结果
  - `POST /api/session/:sessionId/suggest` — 获取 3 个续写建议

### Frontend (Next.js + Tailwind + shadcn/ui)
- Session 列表页 → Session Timeline 页
- Timeline 组件：垂直节点列表，图标区分类型
- 底部：3 个建议按钮 + 自由输入框
- 深色主题

## MVP 交付标准
- [ ] 能列出本机所有 Claude Code 项目和 session
- [ ] 能可视化任意 session 的完整历史（节点 timeline）
- [ ] 能生成 3 个续写建议并渲染为按钮
- [ ] 点击按钮能触发 Claude Code 续写并更新 timeline
- [ ] 能输入自定义 prompt 触发续写
