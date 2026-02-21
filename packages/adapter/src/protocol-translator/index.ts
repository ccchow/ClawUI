import { EventEmitter } from "events";
import type {
  AGUIMessage,
  AGUIEventType,
  AgentType,
  RunStartedData,
  TextMessageData,
  StepStartedData,
  WaitingForHumanData,
  RunFinishedData,
} from "../types.js";

/**
 * Pattern definition for matching CLI output to AG-UI events.
 */
interface TranslationPattern {
  /** Regex to match against a line of CLI output. */
  pattern: RegExp;
  /** The AG-UI event type to emit when matched. */
  eventType: AGUIEventType;
  /** Extract event data from the regex match. */
  extract: (match: RegExpMatchArray, sessionId: string) => AGUIMessage["data"];
}

/**
 * Translates raw CLI output lines into structured AG-UI events
 * using regex-based pattern matching.
 *
 * Supports multiple agent types (claude, openclaw) with auto-detection.
 *
 * Events:
 *  - "event" (message: AGUIMessage)
 */
export class ProtocolTranslator extends EventEmitter {
  private patterns: TranslationPattern[];
  /** Track which sessions have emitted RUN_STARTED. */
  private startedSessions = new Set<string>();
  /** Track detected agent type per session. */
  private sessionAgentType = new Map<string, AgentType>();

  constructor() {
    super();
    this.patterns = this.buildClaudeCodePatterns();
  }

  /**
   * Set the agent type for a session. If "auto", detection happens on first output.
   */
  setAgentType(sessionId: string, agentType: AgentType): void {
    this.sessionAgentType.set(sessionId, agentType);
    if (agentType !== "auto") {
      this.patterns = agentType === "openclaw"
        ? this.buildOpenClawPatterns()
        : this.buildClaudeCodePatterns();
    }
  }

  /**
   * Process a line of output and emit AG-UI events if patterns match.
   * Also handles initial RUN_STARTED for new sessions.
   */
  processLine(sessionId: string, line: string): void {
    // Auto-detect agent type on first output
    if (!this.startedSessions.has(sessionId)) {
      const agentType = this.sessionAgentType.get(sessionId) ?? "auto";
      const detected = agentType === "auto" ? this.detectAgentType(line) : agentType;
      this.sessionAgentType.set(sessionId, detected);

      // Switch pattern set based on detected agent
      this.patterns = detected === "openclaw"
        ? this.buildOpenClawPatterns()
        : this.buildClaudeCodePatterns();

      this.startedSessions.add(sessionId);
      this.emitEvent(sessionId, "RUN_STARTED", {
        agent_name: detected,
      } satisfies RunStartedData);
    }

    // Try each pattern
    for (const p of this.patterns) {
      const match = line.match(p.pattern);
      if (match) {
        this.emitEvent(sessionId, p.eventType, p.extract(match, sessionId));
        return; // First match wins
      }
    }

    // Default: treat as text content if non-empty
    if (line.trim().length > 0) {
      this.emitEvent(sessionId, "TEXT_MESSAGE_CONTENT", {
        delta: line,
      } satisfies TextMessageData);
    }
  }

  /**
   * Handle process exit — emit RUN_FINISHED.
   */
  processExit(sessionId: string, exitCode: number): void {
    this.emitEvent(sessionId, "RUN_FINISHED", {
      status: exitCode === 0 ? "success" : "failed",
    } satisfies RunFinishedData);
    this.startedSessions.delete(sessionId);
    this.sessionAgentType.delete(sessionId);
  }

  /**
   * Process a partial flush (incomplete line) — emit as text delta.
   */
  processFlush(sessionId: string, partial: string): void {
    if (partial.trim().length > 0) {
      this.emitEvent(sessionId, "TEXT_MESSAGE_CONTENT", {
        delta: partial,
      } satisfies TextMessageData);
    }
  }

  /**
   * Detect agent type based on output content characteristics.
   */
  private detectAgentType(line: string): "claude" | "openclaw" {
    // OpenClaw detection: lobster emoji or "openclaw" keyword
    if (/🦞|openclaw/i.test(line)) {
      return "openclaw";
    }
    return "claude";
  }

  private emitEvent(sessionId: string, type: AGUIEventType, data: AGUIMessage["data"]): void {
    const msg: AGUIMessage = {
      type,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data,
    };
    this.emit("event", msg);
  }

  /**
   * Build regex patterns specific to Claude Code CLI output.
   * Patterns are tried in order — first match wins.
   */
  private buildClaudeCodePatterns(): TranslationPattern[] {
    return [
      // Tool usage patterns — Claude Code shows tool calls
      {
        pattern: /(?:Running|Executing|Using)\s+(?:tool:\s*)?(\w[\w\s]*?)(?:\s*\(|$)/i,
        eventType: "STEP_STARTED",
        extract: (match) =>
          ({
            step_type: "tool_call",
            tool_name: match[1].trim(),
          }) satisfies StepStartedData,
      },
      // Bash/command execution
      {
        pattern: /^>\s*(.+)$/,
        eventType: "STEP_STARTED",
        extract: (match) =>
          ({
            step_type: "tool_call",
            tool_name: match[1].trim(),
          }) satisfies StepStartedData,
      },
      // Permission / approval prompts
      {
        pattern: /(?:allow|approve|permit|accept|deny|reject|y\/n|yes\/no|\[Y\/n\]|\[y\/N\])/i,
        eventType: "WAITING_FOR_HUMAN",
        extract: (match) =>
          ({
            reason: match[0],
            a2ui_payload: {
              component: "ApprovalCard",
              props: {
                title: "Agent requires approval",
                description: match.input ?? match[0],
                actions: ["Approve", "Reject"],
              },
            },
          }) satisfies WaitingForHumanData,
      },
      // Dangerous command detection
      {
        pattern: /(?:rm\s+-rf|DROP\s+TABLE|DELETE\s+FROM|force\s+push|--force)/i,
        eventType: "WAITING_FOR_HUMAN",
        extract: (match) =>
          ({
            reason: `Dangerous operation detected: ${match[0]}`,
            a2ui_payload: {
              component: "ApprovalCard",
              props: {
                title: "Dangerous Operation Warning",
                command: match.input ?? match[0],
                actions: ["Approve", "Reject"],
              },
            },
          }) satisfies WaitingForHumanData,
      },
      // Task/run completion
      {
        pattern: /(?:task\s+completed?|finished|done|completed\s+successfully)/i,
        eventType: "RUN_FINISHED",
        extract: () => ({ status: "success" }) satisfies RunFinishedData,
      },
      // Error / failure
      {
        pattern: /(?:error|failed|fatal|panic|exception):\s*(.+)/i,
        eventType: "TEXT_MESSAGE_CONTENT",
        extract: (match) =>
          ({
            delta: match[0],
          }) satisfies TextMessageData,
      },
    ];
  }

  /**
   * Build regex patterns specific to OpenClaw agent CLI output.
   * Patterns are tried in order — first match wins.
   */
  private buildOpenClawPatterns(): TranslationPattern[] {
    return [
      // OpenClaw startup marker
      {
        pattern: /(?:🦞|openclaw)\s*(?:start|launch|init|ready)/i,
        eventType: "RUN_STARTED",
        extract: () =>
          ({
            agent_name: "openclaw",
          }) satisfies RunStartedData,
      },
      // OpenClaw tool calls: "Running tool:" or "Calling:"
      {
        pattern: /(?:Running\s+tool|Calling|Invoking):\s*(.+)/i,
        eventType: "STEP_STARTED",
        extract: (match) =>
          ({
            step_type: "tool_call",
            tool_name: match[1].trim(),
          }) satisfies StepStartedData,
      },
      // OpenClaw thinking/reasoning process
      {
        pattern: /^(?:Thinking\.\.\.|Reasoning|Analyzing|Planning)(.*)$/i,
        eventType: "TEXT_MESSAGE_CONTENT",
        extract: (match) =>
          ({
            delta: match[0],
          }) satisfies TextMessageData,
      },
      // OpenClaw waiting for user / permission prompts
      {
        pattern: /(?:Waiting\s+for\s+user|permission\s+required|confirm|proceed\?|y\/n|\[Y\/n\]|\[y\/N\])/i,
        eventType: "WAITING_FOR_HUMAN",
        extract: (match) =>
          ({
            reason: match[0],
            a2ui_payload: {
              component: "ApprovalCard",
              props: {
                title: "OpenClaw requires input",
                description: match.input ?? match[0],
                actions: ["Approve", "Reject"],
              },
            },
          }) satisfies WaitingForHumanData,
      },
      // Dangerous command detection (shared)
      {
        pattern: /(?:rm\s+-rf|DROP\s+TABLE|DELETE\s+FROM|force\s+push|--force)/i,
        eventType: "WAITING_FOR_HUMAN",
        extract: (match) =>
          ({
            reason: `Dangerous operation detected: ${match[0]}`,
            a2ui_payload: {
              component: "ApprovalCard",
              props: {
                title: "Dangerous Operation Warning",
                command: match.input ?? match[0],
                actions: ["Approve", "Reject"],
              },
            },
          }) satisfies WaitingForHumanData,
      },
      // OpenClaw session end: "Done" or session ended
      {
        pattern: /(?:^Done$|session\s+(?:ended|closed|finished)|task\s+completed?|completed\s+successfully)/i,
        eventType: "RUN_FINISHED",
        extract: () => ({ status: "success" }) satisfies RunFinishedData,
      },
      // Error / failure
      {
        pattern: /(?:error|failed|fatal|panic|exception):\s*(.+)/i,
        eventType: "TEXT_MESSAGE_CONTENT",
        extract: (match) =>
          ({
            delta: match[0],
          }) satisfies TextMessageData,
      },
    ];
  }
}
