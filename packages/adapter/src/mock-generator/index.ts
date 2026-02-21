import { v4 as uuidv4 } from "uuid";
import type { AGUIMessage, AgentType } from "../types.js";

/**
 * Mock data generator that simulates a complete Agent lifecycle event stream.
 * Useful for frontend development without a real Agent running.
 * Supports both claude and openclaw agent types.
 */
export class MockGenerator {
  private sessionId: string;
  private agentName: string;
  private agentType: AgentType;

  constructor(agentName = "claude", agentType: AgentType = "claude") {
    this.sessionId = uuidv4();
    this.agentName = agentName;
    this.agentType = agentType;
  }

  /** Generate a full lifecycle sequence of AG-UI events. */
  generateLifecycle(): AGUIMessage[] {
    return this.agentType === "openclaw"
      ? this.generateOpenClawLifecycle()
      : this.generateClaudeLifecycle();
  }

  /** Generate Claude Code agent lifecycle events. */
  private generateClaudeLifecycle(): AGUIMessage[] {
    const events: AGUIMessage[] = [];

    // 1. RUN_STARTED
    events.push(this.makeEvent("RUN_STARTED", { agent_name: this.agentName }));

    // 2. Initial thinking text
    const thinkingLines = [
      "I'll help you with that task. Let me analyze the codebase first.",
      "Looking at the project structure...",
      "I can see this is a TypeScript project with the following layout:",
    ];
    for (const line of thinkingLines) {
      events.push(this.makeEvent("TEXT_MESSAGE_CONTENT", { delta: line }));
    }

    // 3. Tool call — reading files
    events.push(
      this.makeEvent("STEP_STARTED", {
        step_type: "tool_call",
        tool_name: "Read file: src/index.ts",
      })
    );

    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "The main entry point exports the application config...",
      })
    );

    // 4. Tool call — running a command
    events.push(
      this.makeEvent("STEP_STARTED", {
        step_type: "tool_call",
        tool_name: "Bash: npm test",
      })
    );

    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "All 15 tests passed successfully.",
      })
    );

    // 5. Dangerous operation — waiting for human
    events.push(
      this.makeEvent("WAITING_FOR_HUMAN", {
        reason: "Agent wants to execute a potentially dangerous command",
        a2ui_payload: {
          component: "ApprovalCard",
          props: {
            title: "Dangerous Operation Warning",
            command: "rm -rf /tmp/old-build",
            actions: ["Approve", "Reject"],
          },
        },
      })
    );

    // 6. More text after approval
    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "Old build artifacts cleaned up. Now deploying...",
      })
    );

    // 7. Another tool call
    events.push(
      this.makeEvent("STEP_STARTED", {
        step_type: "tool_call",
        tool_name: "Bash: npm run build",
      })
    );

    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "Build completed successfully. Output written to dist/",
      })
    );

    // 8. RUN_FINISHED
    events.push(this.makeEvent("RUN_FINISHED", { status: "success" }));

    return events;
  }

  /** Generate OpenClaw agent lifecycle events. */
  private generateOpenClawLifecycle(): AGUIMessage[] {
    const events: AGUIMessage[] = [];

    // 1. RUN_STARTED with lobster marker
    events.push(this.makeEvent("RUN_STARTED", { agent_name: "openclaw" }));

    // 2. OpenClaw startup banner
    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "🦞 OpenClaw agent initialized. Ready to assist.",
      })
    );

    // 3. Thinking/reasoning phase
    const thinkingLines = [
      "Thinking... Analyzing the request and planning approach.",
      "I'll break this into steps and work through each one.",
      "Scanning project files for relevant context...",
    ];
    for (const line of thinkingLines) {
      events.push(this.makeEvent("TEXT_MESSAGE_CONTENT", { delta: line }));
    }

    // 4. Tool call — OpenClaw style
    events.push(
      this.makeEvent("STEP_STARTED", {
        step_type: "tool_call",
        tool_name: "file_read: package.json",
      })
    );

    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "Found project configuration. Dependencies look good.",
      })
    );

    // 5. Another tool call
    events.push(
      this.makeEvent("STEP_STARTED", {
        step_type: "tool_call",
        tool_name: "shell_exec: npm run lint",
      })
    );

    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "Linting passed with no warnings.",
      })
    );

    // 6. Permission prompt — OpenClaw style
    events.push(
      this.makeEvent("WAITING_FOR_HUMAN", {
        reason: "Waiting for user confirmation to modify source files",
        a2ui_payload: {
          component: "ApprovalCard",
          props: {
            title: "OpenClaw requires input",
            description: "Waiting for user: Apply changes to src/config.ts?",
            actions: ["Approve", "Reject"],
          },
        },
      })
    );

    // 7. Post-approval work
    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "Changes applied successfully. Running verification...",
      })
    );

    events.push(
      this.makeEvent("STEP_STARTED", {
        step_type: "tool_call",
        tool_name: "shell_exec: npm test",
      })
    );

    events.push(
      this.makeEvent("TEXT_MESSAGE_CONTENT", {
        delta: "All tests passing. Task complete.",
      })
    );

    // 8. RUN_FINISHED
    events.push(this.makeEvent("RUN_FINISHED", { status: "success" }));

    return events;
  }

  /**
   * Stream lifecycle events with realistic delays.
   * Calls the callback for each event, returns a cancel function.
   */
  streamLifecycle(
    onEvent: (event: AGUIMessage) => void,
    opts?: { baseDelay?: number }
  ): { cancel: () => void } {
    const events = this.generateLifecycle();
    const baseDelay = opts?.baseDelay ?? 800;
    let index = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const next = () => {
      if (cancelled || index >= events.length) return;
      onEvent(events[index]);
      index++;
      if (index < events.length) {
        // Vary delay: text content faster, step changes slower
        const event = events[index];
        const delay =
          event.type === "TEXT_MESSAGE_CONTENT"
            ? baseDelay * 0.5
            : event.type === "WAITING_FOR_HUMAN"
              ? baseDelay * 2
              : baseDelay;
        timer = setTimeout(next, delay);
      }
    };

    timer = setTimeout(next, 300);

    return {
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
      },
    };
  }

  /** Get the session ID for this mock run. */
  getSessionId(): string {
    return this.sessionId;
  }

  private makeEvent(type: AGUIMessage["type"], data: AGUIMessage["data"]): AGUIMessage {
    return {
      type,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      data,
    };
  }
}

/** Run mock generator as a standalone script. */
function main() {
  const agentType = process.argv[2] === "openclaw" ? "openclaw" : "claude";
  const mock = new MockGenerator(agentType, agentType as AgentType);
  console.log(`[Mock] Starting ${agentType} mock lifecycle for session: ${mock.getSessionId()}`);
  console.log("---");

  mock.streamLifecycle(
    (event) => {
      console.log(JSON.stringify(event, null, 2));
      console.log("---");
    },
    { baseDelay: 500 }
  );
}

// Run if executed directly
const isMain = process.argv[1]?.endsWith("mock-generator/index.js") ||
  process.argv[1]?.endsWith("mock-generator/index.ts");
if (isMain) {
  main();
}
