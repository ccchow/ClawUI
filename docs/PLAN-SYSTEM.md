# Plan System — 宏观任务编排层

## 概念模型

```
Plan (Blueprint)
  ├── Node 1: "搭建项目骨架"        ⚪ pending
  │     └── Session: null (未执行)
  ├── Node 2: "实现数据模型"         🔵 running
  │     └── Session: abc-123.jsonl (关联已有 session)
  ├── Node 3: "编写 API 接口"       ⚪ pending
  │     └── depends_on: [Node 2]
  └── Node 4: "前端 UI"             ⚪ pending
        └── depends_on: [Node 3]
```

**Plan** = 一个高层任务的结构化分解，包含多个有序/有依赖关系的 **Node**。
**Node** = 一个可独立执行的子任务，执行时创建 Claude Code session。
**Artifact** = Node 完成后生成的交接摘要，传递给下游 Node 作为 context。

## 与现有四层模型的关系

```
现有四层                          Plan 系统扩展
─────────                        ──────────────
Layer 4 — App State              + activePlanId, planViewMode
Layer 3 — Enrichment             + session↔node 关联
Layer 2 — Index (SQLite)         + plans, plan_nodes 表
Layer 1 — Raw (JSONL)            不变（只读）
```

### 设计原则

1. **Plan 是 Layer 2 的扩展**，不是新层 — Plan 数据存入同一个 SQLite db
2. **Session 仍然是执行单元** — Node 执行时创建标准 Claude Code session
3. **双向可选关联** — 现有 session 可以不属于任何 plan（向后兼容）
4. **Plan 是 source of truth** — 不同于 session 索引（从 JSONL 派生），plan 数据是用户创建的原始数据
5. **Artifact 是 context 管道** — 解决跨 node/session 的状态传递问题

## 数据模型

### SQLite 新表

```sql
-- Plan / Blueprint
CREATE TABLE plans (
  id           TEXT PRIMARY KEY,   -- UUID
  title        TEXT NOT NULL,
  description  TEXT,               -- 原始任务描述
  status       TEXT DEFAULT 'draft', -- draft | approved | running | completed | failed
  project_id   TEXT,               -- 关联项目（可选）
  cwd          TEXT,               -- 工作目录
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Plan Node (宏观节点)
CREATE TABLE plan_nodes (
  id           TEXT PRIMARY KEY,   -- UUID
  plan_id      TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,   -- 执行顺序
  title        TEXT NOT NULL,
  description  TEXT,               -- 详细任务描述（作为 prompt 的基础）
  status       TEXT DEFAULT 'pending', -- pending | running | done | failed | blocked | skipped
  session_id   TEXT,               -- 关联的 Claude Code session（执行后填入）
  depends_on   TEXT,               -- JSON array of node IDs: ["node-uuid-1", "node-uuid-2"]
  prompt       TEXT,               -- 实际发送给 Claude 的 prompt（可与 description 不同）
  artifact     TEXT,               -- 完成后的交接摘要 (Artifact)
  error        TEXT,               -- 失败原因
  started_at   TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_plan_nodes_plan ON plan_nodes(plan_id, seq);
CREATE INDEX idx_plan_nodes_session ON plan_nodes(session_id);
```

### TypeScript 类型

```typescript
interface Plan {
  id: string;
  title: string;
  description: string;
  status: 'draft' | 'approved' | 'running' | 'completed' | 'failed';
  projectId?: string;
  cwd?: string;
  nodes: PlanNode[];
  createdAt: string;
  updatedAt: string;
}

interface PlanNode {
  id: string;
  planId: string;
  seq: number;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped';
  sessionId?: string;        // 关联的 Claude Code session
  dependsOn: string[];       // 前置依赖 node IDs
  prompt?: string;           // 自定义 prompt（覆盖 description）
  artifact?: string;         // 完成后的交接摘要
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface Artifact {
  nodeId: string;
  summary: string;           // <200 words 精简交接文档
  keyOutputs: string[];      // 关键产出（文件路径、API 等）
  decisions: string[];       // 重要决策
}
```

## API 设计

### Plan CRUD
```
POST   /api/plans                  — 创建 plan（可选：自动生成 nodes）
GET    /api/plans                  — 列出所有 plans
GET    /api/plans/:id              — 获取 plan 详情（含 nodes）
PUT    /api/plans/:id              — 更新 plan 元数据
DELETE /api/plans/:id              — 删除 plan
```

### Plan 生命周期
```
POST   /api/plans/:id/generate     — AI 生成 plan nodes（从 description）
POST   /api/plans/:id/approve      — 审批 plan（draft → approved）
POST   /api/plans/:id/run          — 执行下一个 pending node
POST   /api/plans/:id/run-all      — 顺序执行所有 pending nodes
POST   /api/plans/:id/cancel       — 取消执行
```

### Node 操作
```
PUT    /api/plans/:planId/nodes/:nodeId          — 编辑 node
POST   /api/plans/:planId/nodes                  — 添加 node
DELETE /api/plans/:planId/nodes/:nodeId           — 删除 node
POST   /api/plans/:planId/nodes/:nodeId/run      — 执行单个 node
POST   /api/plans/:planId/nodes/:nodeId/retry     — 重试失败 node
POST   /api/plans/:planId/nodes/reorder           — 重排序 [{id, seq}]
```

## 执行流程

### Node 执行（核心）

```
1. 检查前置依赖是否全部 done
2. 收集前置 nodes 的 artifacts 作为 inputContext
3. 构建 prompt:
   - System context: plan title + description
   - Input artifacts: 前置节点的交接摘要
   - Task: node description (或自定义 prompt)
   - Working directory: plan.cwd
4. 调用 claude -p "..." (新 session，不用 --resume)
5. 捕获输出，更新 node status
6. 自动生成 artifact (调用 claude 做 summarize)
7. 检查是否有下游 node 可以执行
```

### Prompt 模板

```
You are executing step {seq}/{total} of a plan: "{plan.title}"

## Context from previous steps:
{artifacts from depends_on nodes, joined}

## Your task:
{node.description or node.prompt}

## Working directory: {plan.cwd}

Complete this step. Be thorough but focused on THIS step only.
```

### Artifact 生成模板

```
Summarize what was accomplished in the previous step. Include:
1. What was done (2-3 sentences)
2. Key files created/modified (list paths)
3. Important decisions made
4. Any issues or notes for the next step

Keep it under 200 words. Be specific and factual.
```

## 数据迁移

### 从现有系统迁移（零成本）

**不需要迁移** — Plan 系统是纯增量：

1. 现有的 `sessions` 和 `timeline_nodes` 表不变
2. 新增 `plans` 和 `plan_nodes` 表
3. 关联通过 `plan_nodes.session_id` 可选外键
4. 没有 plan 的 session 继续正常工作
5. 前端新增 `/plans` 路由，现有 `/` 和 `/session/[id]` 不变

### Layer 3 扩展

`enrichments.json` 新增 `plans` 字段：

```json
{
  "version": 2,
  "sessions": { ... },
  "nodes": { ... },
  "tags": [...],
  "plans": {
    "<plan-id>": {
      "starred": true,
      "tags": ["sprint-1"],
      "notes": "MerakLegal MVP 的第一阶段"
    }
  }
}
```

### Layer 4 扩展

`app-state.json` 新增：

```json
{
  "version": 2,
  "ui": {
    "activePlanId": "...",
    "planViewMode": "list",
    ...
  }
}
```

## 前端路由

```
/                           — 现有 Session 列表（不变）
/session/[id]               — 现有 Session Timeline（不变）
/plans                      — Plan 列表（新增）
/plans/new                  — 创建 Plan（新增）
/plans/[id]                 — Plan 详情：宏观节点链 + 状态指示灯（新增）
/plans/[id]/nodes/[nodeId]  — Node 微观 Timeline（复用 session timeline）
```

## 实现分阶段

### Phase A — Plan 数据层（后端）
1. `backend/src/plan-db.ts` — SQLite 表 + CRUD
2. `backend/src/plan-routes.ts` — REST API
3. 单元测试：创建 plan → 增删 node → 更新状态

### Phase B — Plan 生成 + 执行引擎
1. `backend/src/plan-generator.ts` — 调用 Claude 生成 plan nodes
2. `backend/src/plan-executor.ts` — Node 执行 + artifact 生成
3. Prompt 模板 + context 组装

### Phase C — 前端可视化
1. Plan 列表页 + 创建页
2. Plan 详情：宏观节点链 + 状态指示灯
3. Node 展开 → 复用 Timeline 组件
4. 审批流：Approve + Run All + 单步执行

### Phase D — 编辑 + 高级功能
1. 节点增删改
2. 依赖关系编辑
3. 拖拽排序
4. 并行执行（无依赖节点同时运行）

## 文件结构（新增）

```
backend/src/
├── plan-db.ts              # Plan SQLite CRUD
├── plan-routes.ts          # Plan REST API
├── plan-generator.ts       # AI 任务分解
└── plan-executor.ts        # Node 执行 + Artifact 生成

frontend/src/
├── app/plans/
│   ├── page.tsx            # Plan 列表
│   ├── new/page.tsx        # 创建 Plan
│   └── [id]/
│       ├── page.tsx        # Plan 详情（宏观节点链）
│       └── nodes/[nodeId]/page.tsx  # Node Timeline
├── components/
│   ├── PlanList.tsx
│   ├── PlanNodeChain.tsx   # 宏观节点垂直链
│   ├── PlanNodeCard.tsx    # 单个宏观节点
│   └── StatusIndicator.tsx # 状态指示灯
└── lib/
    └── plan-api.ts         # Plan API client
```
