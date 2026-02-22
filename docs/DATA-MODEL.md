# ClawUI 四层数据模型

## 概览

```
Layer 4 — App State        .clawui/app-state.json        UI 偏好、当前视图状态
Layer 3 — Enrichment       .clawui/enrichments.json      用户标注、标签、收藏、笔记
Layer 2 — Index/Cache      .clawui/index.db (SQLite)     解析后的结构化索引+缓存
Layer 1 — Raw Source       ~/.claude/projects/**/*.jsonl  Claude Code 原始数据（只读）
```

### 存储位置

所有持久化数据放在项目根目录的 `.clawui/` 隐藏文件夹中：
- 可跟随 git 版本控制（或 `.gitignore` 掉）
- 单机本地状态，不涉及远程同步
- 删除 `.clawui/` 即可完全重置，Layer 1 原始数据不受影响

---

## Layer 1 — Raw Source（只读）

**来源**: `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`

**现状**: 当前 `jsonl-parser.ts` 每次请求都从头读取 JSONL 文件并解析。

**不变**: 这一层永远只读，不写入任何内容。是一切数据的 source of truth。

**JSONL 行类型**:
- `user` / `assistant` — 对话消息
- `tool_use` / `tool_result` — 工具调用（嵌套在 assistant content 中）
- `file-history-snapshot` / `progress` / `queue-operation` — 元数据（跳过）

---

## Layer 2 — Index / Cache（SQLite）

**文件**: `.clawui/index.db`

**目的**: 避免每次都重新解析整个 JSONL。提供快速查询、搜索、排序。

**表结构**:

```sql
-- 项目索引
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,   -- 目录名 (e.g., "-Users-leizhou-Git-ClawUI")
  name         TEXT,               -- 解码后的友好名 (e.g., "Git/ClawUI")
  decoded_path TEXT,               -- 完整路径
  session_count INTEGER DEFAULT 0,
  updated_at   TEXT                -- 最后扫描时间
);

-- Session 索引
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,   -- session UUID
  project_id   TEXT REFERENCES projects(id),
  slug         TEXT,               -- Claude Code 给的 slug
  cwd          TEXT,               -- 工作目录
  created_at   TEXT,               -- 首条消息时间
  updated_at   TEXT,               -- 末条消息时间
  node_count   INTEGER DEFAULT 0,  -- user+assistant 消息数
  file_size    INTEGER,            -- JSONL 文件字节数（增量检测用）
  file_mtime   TEXT                -- JSONL 文件 mtime（增量检测用）
);

-- Timeline 节点缓存
CREATE TABLE timeline_nodes (
  id           TEXT PRIMARY KEY,   -- node UUID
  session_id   TEXT REFERENCES sessions(id),
  seq          INTEGER,            -- 节点顺序
  type         TEXT,               -- user/assistant/tool_use/tool_result/error/system
  timestamp    TEXT,
  title        TEXT,               -- 摘要（前 120 字）
  content      TEXT,               -- 完整内容
  tool_name    TEXT,
  tool_input   TEXT,
  tool_result  TEXT,
  tool_use_id  TEXT
);

CREATE INDEX idx_nodes_session ON timeline_nodes(session_id, seq);
```

**增量更新策略**:
1. 扫描 `~/.claude/projects/` 目录
2. 对比 `file_size` + `file_mtime` → 只重新解析变化的文件
3. 变化的文件：清空其 `timeline_nodes` → 重新解析写入
4. 后台定时扫描（启动时 + 每 30s）或 API 请求触发 lazy refresh

**选 SQLite 的理由**:
- 单文件，零配置
- 支持全文搜索（FTS5）未来可用
- Node.js 用 `better-sqlite3`（同步 API，简单高效）
- 比 JSON 文件快得多（尤其 session 多了之后）

---

## Layer 3 — Enrichment（JSON）

**文件**: `.clawui/enrichments.json`

**目的**: 用户附加的元数据，不依赖 Claude Code 原始数据。

**结构**:

```json
{
  "version": 1,
  "sessions": {
    "<session-uuid>": {
      "starred": true,
      "tags": ["bugfix", "ClawUI"],
      "notes": "这个 session 解决了 TTY 问题",
      "alias": "TTY Fix Session",
      "archived": false
    }
  },
  "nodes": {
    "<node-id>": {
      "bookmarked": true,
      "annotation": "关键突破点"
    }
  },
  "tags": ["bugfix", "feature", "experiment", "ClawUI", "MerakLegal"]
}
```

**为什么用 JSON 而不是 SQLite**:
- 数据量小（几百个标注顶天了）
- 可读性好，手动编辑方便
- 可以 git track 作为项目知识
- 不需要查询优化

---

## Layer 4 — App State（JSON）

**文件**: `.clawui/app-state.json`

**目的**: UI 运行时状态，关了再开能恢复。

**结构**:

```json
{
  "version": 1,
  "ui": {
    "theme": "dark",
    "sidebarWidth": 300,
    "timelineExpandAll": false,
    "lastViewedSession": "e9b4b7f9-c4f0-4456-9975-5bed7e7a7678",
    "lastViewedProject": "-Users-leizhou-Git-ClawUI"
  },
  "recentSessions": [
    { "id": "e9b4b7f9-...", "viewedAt": "2026-02-21T18:00:00Z" }
  ],
  "filters": {
    "hideArchivedSessions": true,
    "defaultSort": "updated_at"
  }
}
```

**应该 `.gitignore`**: 这是个人偏好，不需要版本控制。

---

## 迁移方案：从现状到四层模型

### 现状

```
请求 → jsonl-parser.ts 每次读文件解析 → 返回
       (无持久化，无缓存)
```

### Phase 1 — 加入 Layer 2 索引（最高优先级）

**改动**:
1. 新增 `backend/src/db.ts` — SQLite 初始化 + 增量同步逻辑
2. 修改 `jsonl-parser.ts` → 将 `parseTimeline()` 逻辑拆为：
   - `syncSession(sessionId)` — 检测变化 → 解析 → 写入 SQLite
   - `getTimeline(sessionId)` — 从 SQLite 读取
3. 修改 `routes.ts` → 启动时触发全量扫描，API 走 SQLite
4. 新增 `.clawui/` 目录 + `index.db`
5. `.gitignore` 加 `.clawui/index.db`

**兼容性**: API 接口不变，前端零改动。纯后端优化。

**收益**:
- Session 列表从 O(n×文件大小) 降到 O(1) 查询
- Timeline 首次加载后缓存，增量更新
- 为搜索功能打基础

### Phase 2 — 加入 Layer 3 + 4

**改动**:
1. 新增 `backend/src/enrichment.ts` — 读写 `enrichments.json`
2. 新增 API:
   - `PATCH /api/sessions/:id/meta` — 更新 star/tags/notes
   - `PATCH /api/nodes/:id/meta` — 更新 bookmark/annotation
   - `GET /api/tags` — 列出所有标签
3. 新增 `backend/src/app-state.ts` — 读写 `app-state.json`
4. 前端加入：星标、标签筛选、节点书签等 UI

### Phase 3 — 搜索 & 高级功能

- SQLite FTS5 全文搜索
- 跨 session 搜索
- 时间范围过滤
- Token/cost 统计（从 JSONL 提取 usage 字段）

---

## 目录结构

```
~/Git/ClawUI/
├── .clawui/                    # 持久化数据目录
│   ├── index.db                # Layer 2 (gitignore)
│   ├── enrichments.json        # Layer 3 (git track)
│   └── app-state.json          # Layer 4 (gitignore)
├── .gitignore                  # 加入 .clawui/index.db, .clawui/app-state.json
├── backend/
│   └── src/
│       ├── db.ts               # NEW: SQLite 管理
│       ├── enrichment.ts       # NEW: Layer 3 读写
│       ├── app-state.ts        # NEW: Layer 4 读写
│       ├── jsonl-parser.ts     # MODIFIED: 解析逻辑提取，写入 SQLite
│       ├── cli-runner.ts       # 不变
│       ├── routes.ts           # MODIFIED: 新增 API
│       └── index.ts            # MODIFIED: 启动时初始化 DB
└── frontend/                   # Phase 1 不改
```

---

## 设计原则

1. **Layer 1 只读** — 永远不写 Claude Code 的 JSONL
2. **向上可丢弃** — 删 `.clawui/` 一切可重建（Layer 2 重新解析，Layer 3/4 丢失但不致命）
3. **增量优先** — 用 mtime+size 检测变化，不重复解析
4. **JSON for 小数据，SQLite for 大数据** — 标注用 JSON，索引用 SQLite
5. **API 接口稳定** — Phase 1 不改现有 API contract，前端零改动
