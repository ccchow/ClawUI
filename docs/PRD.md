# 需求与架构文档 (PRD & Architecture)

## 项目代号: Agent-Cockpit (MVP)

## 项目目标
为高强度并行运行的命令行/本地 Agent (如 Claude Code, OpenClaw) 提供一个基于 AG-UI 协议的云端适配层，以及一个支持状态可视化和 A2UI 动态交互的 Web/移动端展示层。

---

## 1. 核心架构概述

系统分为完全解耦的两层，通过标准的 WebSocket 进行双向通信。

- **适配层 (Adapter Layer)**: 部署在运行 Agent 的云主机上。负责劫持 CLI 进程，将非结构化的标准输出 (stdout/stderr) 转化为结构化的 AG-UI 标准事件。
- **展示层 (Presentation Layer)**: 纯前端应用，作为状态接收器和用户指令下发器。

---

## 2. 适配层 (Adapter Layer) 规范

### 2.1 技术栈建议
- **Runtime**: Node.js (TypeScript)
- **核心库**: `child_process` 用于劫持终端；`ws` 或 `socket.io` 用于 WebSocket 服务；regex 或轻量级本地 LLM (如需) 用于日志解析。

### 2.2 核心职责
1. **进程管理 (Process Spawning)**: 能够通过 API 启动、暂停、终止目标 Agent (如 `claude-code --dir /target`)
2. **流式拦截 (Stream Interception)**: 实时读取 Agent 的 stdout 和 stderr
3. **协议翻译 (Protocol Translation)**: 持续监听输出流，基于关键字、正则或固定模式，将 Agent 的行为翻译为 AG-UI 事件 JSON
4. **状态广播 (State Broadcasting)**: 将事件通过 WebSocket 发送给所有连接的客户端

### 2.3 AG-UI 事件映射表 (核心逻辑)

| CLI 输出特征 (以 Claude Code 为例) | 触发的 AG-UI Event Type | Payload 核心字段示例 | 描述 |
|---|---|---|---|
| 进程启动 / 检测到 `> claude` | `RUN_STARTED` | `session_id, timestamp, agent_name` | 标记一个新的 Session 开启 |
| 输出思考过程、代码生成过程 | `TEXT_MESSAGE_CONTENT` | `session_id, delta (增量文本)` | 用于前端打字机效果渲染 |
| 输出如 `Running command: git status` | `STEP_STARTED` | `session_id, step_type: "tool_call", tool_name` | 标记 Agent 开始使用外部工具 |
| 输出如 `Permission denied` 或要求按 `y/N` | `WAITING_FOR_HUMAN` | `session_id, reason, a2ui_payload` | 关键: 进程挂起，等待前端回传决策 |
| 进程退出 / 任务完成 | `RUN_FINISHED` | `session_id, status: "success" \| "failed"` | 标记 Session 结束，更新前端状态灯 |

### 2.4 数据结构规约 (Type Definitions)

```typescript
// 从后端发往前端的基础 Message 格式
interface AGUIMessage {
  type: "RUN_STARTED" | "TEXT_MESSAGE_CONTENT" | "STEP_STARTED" | "WAITING_FOR_HUMAN" | "RUN_FINISHED";
  session_id: string;
  timestamp: string;
  data: any; // 根据 type 不同的具体 payload
}
```

---

## 3. 展示层 (Presentation Layer) 规范

### 3.1 技术栈
- **框架**: Next.js (React)
- **UI 组件**: Tailwind CSS + shadcn/ui
- **状态管理**: Zustand (用于管理多个并行的 Session 状态树)
- **通信**: 原生 WebSocket API 或 socket.io-client

### 3.2 核心 UI 模块需求

#### Session 监控雷达 (Dashboard)
- 维护一个全局状态，展示当前所有活跃的 `session_id`
- 每个 Session 渲染为一个卡片，包含：Agent 名称、当前执行阶段 (根据 `STEP_STARTED` 更新)、最新一条文本 (根据 `TEXT_MESSAGE_CONTENT` 截断显示)

#### 状态指示灯 (Status Indicator)
- 🟢 运行中 (收到 `RUN_STARTED` 或 `STEP_STARTED`)
- 🟡 等待授权 (收到 `WAITING_FOR_HUMAN`) - 需高亮闪烁，并提供系统级 Notification
- ⚪ 休眠/完成 (收到 `RUN_FINISHED`)

#### 富交互组件渲染器 (A2UI Renderer)
当收到 `WAITING_FOR_HUMAN` 事件且携带了 A2UI JSON 时，前端不要显示终端那样的纯文本输入框，而是动态渲染组件。

**示例场景**: 后端检测到 Agent 需要执行 `rm -rf`，发送如下 JSON 到前端：
```json
{
  "component": "ApprovalCard",
  "props": {
    "title": "危险操作警告",
    "command": "rm -rf /temp",
    "actions": ["Approve", "Reject"]
  }
}
```
前端需根据此 JSON 渲染出一个带有原生"批准"和"拒绝"按钮的卡片组件。

### 3.3 交互反向控制 (Frontend to Backend)

```typescript
interface HumanAction {
  session_id: string;
  action_type: "APPROVE" | "REJECT" | "PROVIDE_INPUT";
  payload: string | boolean; // 用户输入的文本或按钮的布尔值
}
```

前端通过 WebSocket 发送 `HumanAction` 后，适配层需将其注入到对应 CLI 进程的 stdin 中，恢复进程执行。

---

## 开发指令

- **优先解耦**: 务必将"解析 CLI 终端流"的逻辑与"WebSocket 通信"的逻辑分离。提供一套 Mock 数据生成器，以便在没有真实 Agent 运行的情况下独立测试前端 UI。
- **容错处理**: 终端输出流往往是碎片化和混乱的。请确保流式拦截器 (Stream Interceptor) 有良好的缓冲 (Buffering) 机制，避免发送半截词导致 JSON 解析失败。
