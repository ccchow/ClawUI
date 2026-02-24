# PRD v3 — ClawUI: Agent Task Orchestrator

> **Internal Reference Document** — This is the original product requirements document written during ClawUI's design phase. It is kept for historical reference. For the current architecture, see [DATA-MODEL.md](DATA-MODEL.md) and [PLAN-SYSTEM.md](PLAN-SYSTEM.md).

## Summary (English)

ClawUI's architecture decouples **business logic nodes** from **physical execution sessions**. Sessions are disposable compute resources, while nodes forming a DAG (directed acyclic graph) represent the project's core structure.

The system uses a four-layer model:
- **Layer 1 — Blueprint**: The top-level business unit (e.g., "Build a Next.js full-stack app"), represented as a DAG defining node order and parallelism rules.
- **Layer 2 — Macro-Node / Task**: Independent steps within a blueprint, each with defined inputs (prerequisites) and outputs (deliverables). States: pending → running → done / failed / blocked.
- **Layer 3 — Session / Worker**: Claude Code physical processes. Relationship is Node:Session = 1:N (for isolation/retry/parallelism).
- **Layer 4 — Micro-Event / Trace**: Individual tool calls (Bash, Edit, Read, Think, etc.) — the execution trace within a session.

Key mechanisms include **artifact-based state handoff** between nodes (auto-generated summaries passed as context to downstream nodes), **fan-out/fan-in concurrency** for parallel node groups, and a **dual UI view** (map view for the DAG overview, session view for micro-level tool traces).

---

*The remainder of this document is in Chinese (original design language).*

---

## 核心理念
**将"业务逻辑的节点 (Node)"与"物理执行的会话 (Session)"解耦。Session 只是随用随弃的计算资源，而 Node 构成的 DAG 才是项目的灵魂。**

---

## 四层架构模型

```
Layer 1: Blueprint (蓝图)
│  最大业务单元，如"开发 Next.js 全栈应用"
│  形态：有向无环图 (DAG)
│  职责：定义节点、顺序、并行规则
│
├── Layer 2: Macro-Node / Task (宏观节点)
│   │  Blueprint 中的独立步骤
│   │  拥有明确的 Input (前置条件) 和 Output (交付物)
│   │  状态：pending → running → done / failed / blocked
│   │
│   ├── Layer 3: Session / Worker (执行会话)
│   │   │  Claude Code 的物理进程
│   │   │  Node:Session = 1:N (隔离/重试/并行)
│   │   │  Session:Node = N:1 也可 (串行复用，context 允许时)
│   │   │
│   │   └── Layer 4: Micro-Event / Trace (微观动作)
│   │       Bash, Edit, Read, Think 等工具调用
│   │       属于 Session 内部的执行轨迹
```

## 数据模型

```typescript
// Layer 1: Blueprint
interface Blueprint {
  id: string;
  title: string;                    // "开发 Next.js 全栈应用"
  description?: string;
  projectCwd: string;               // 关联的项目路径
  status: "draft" | "approved" | "running" | "paused" | "done";
  nodes: MacroNode[];
  createdAt: string;
  updatedAt: string;
}

// Layer 2: Macro-Node
interface MacroNode {
  id: string;
  title: string;                    // "设计数据库 Schema"
  description: string;              // 详细描述 + 预期交付物
  order: number;
  status: "pending" | "running" | "done" | "failed" | "blocked";
  dependencies: string[];           // 前置节点 IDs (DAG edges)
  parallelGroup?: string;           // 同 group 的节点可并行

  // 状态交接
  inputArtifacts: Artifact[];       // 从前置节点接收的交接文档
  outputArtifacts: Artifact[];      // 完成后生成的交接文档

  // 执行记录
  executions: NodeExecution[];

  // 元数据
  estimatedMinutes?: number;
  actualMinutes?: number;
}

// Artifact: 跨节点的状态传递载体
interface Artifact {
  id: string;
  type: "handoff_summary" | "file_diff" | "test_report" | "custom";
  content: string;                  // 精简的交接文档内容
  sourceNodeId?: string;
  createdAt: string;
}

// Layer 3: Session / Worker
interface NodeExecution {
  id: string;
  sessionId: string;                // Claude Code session ID
  type: "primary" | "retry" | "continuation" | "subtask";
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;

  // 上下文管理
  inputContext: string;             // 注入的 system prompt / context
  outputSummary?: string;           // 执行结果摘要
  contextTokensUsed?: number;       // 监控 context 使用量

  // 关联
  parentExecutionId?: string;       // continuation 时关联前一个 execution
}

// Layer 4: Micro-Event (复用现有 TimelineNode)
// 已有实现，存储在 Claude Code 的 JSONL 文件中
```

## 状态交接机制 (State Handoff)

```
Node A 完成
    ↓
Adapter 强制生成 Handoff Summary (Artifact)
    ↓
存入 Node A 的 outputArtifacts
    ↓
Node B 启动时，将 Node A 的 outputArtifacts 注入为 inputContext
    ↓
Session 以干净的 context 开始执行
```

**Handoff Summary 模板：**
```
claude -p "Summarize what was accomplished:
- Key decisions made
- Files created/modified
- Current state of the system
- Any issues or warnings
Keep under 200 words. Output as markdown."
```

## 并发控制 (Fan-out & Fan-in)

### Fan-out (发散)
当一个节点标记为 parallelGroup 时，同组的所有 pending 节点同时启动：
```
Node: "调研框架" (parallelGroup: "research")
  ├── Session 1: "调研 React"
  ├── Session 2: "调研 Vue"
  └── Session 3: "调研 Svelte"
```

### Fan-in (收敛)
后续节点设置 dependencies 包含所有并行节点。Barrier 机制：
- 所有 dependencies 节点状态为 done 时才触发
- 将所有并行节点的 outputArtifacts 合并为下一节点的 inputArtifacts

## UI 双视角

### 1. Map View (全局地图)
- 路由: `/plans/:id`
- DAG 可视化：节点 + 连线
- 状态灯：⚪ pending / 🔵 running (呼吸灯) / 🟢 done / 🟡 blocked / 🔴 failed
- 并行节点并排显示
- 点击节点 → Zoom in

### 2. Session View (显微镜)
- 路由: `/plans/:id/nodes/:nodeId` 或 `/session/:sessionId`
- 复用现有 Timeline 组件
- 显示该节点所有 executions 的微观事件
- 支持续写（现有的 Run 功能）

## 持久化

```
~/.clawui/
├── blueprints/
│   ├── <blueprint-id>.json      # Blueprint + Nodes + Executions
│   └── ...
├── artifacts/
│   ├── <artifact-id>.md         # Handoff summaries
│   └── ...
└── config.json                  # 全局设置
```

## 实现路径

### Phase 1: Blueprint CRUD + 静态可视化
- Blueprint 创建（用户输入任务 → Claude 生成 DAG JSON）
- 持久化到 ~/.clawui/blueprints/
- 前端 DAG 节点链渲染（线性，暂不支持并行分支）
- 节点状态灯

### Phase 2: 单节点执行 + Handoff
- 点击节点 → 创建 NodeExecution → 调用 Claude Code
- 执行完成 → 自动生成 Handoff Summary (Artifact)
- 下一节点启动时注入前置 Artifact 为 context
- Approve Plan → Run All (顺序执行)

### Phase 3: 并发 + DAG 编辑
- Fan-out / Fan-in 并发控制
- DAG 节点编辑（拖拽、增删、连线）
- 多 Session 并行监控

### Phase 4: 语义缩放 + 流式
- Map View ↔ Session View 无缝切换
- 流式输出（WebSocket/SSE）
- 多 Agent 支持
