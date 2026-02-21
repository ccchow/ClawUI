import { EventEmitter } from "events";
import type {
  AGUIMessage,
  AGUIEventType,
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
 * Events:
 *  - "event" (message: AGUIMessage)
 */
export class ProtocolTranslator extends EventEmitter {
  private patterns: TranslationPattern[];
  /** Track which sessions have emitted RUN_STARTED. */
  private startedSessions = new Set<string>();

  constructor() {
    super();
    this.patterns = this.buildClaudeCodePatterns();
  }

  /**
   * Process a line of output and emit AG-UI events if patterns match.
   * Also handles initial RUN_STARTED for new sessions.
   */
  processLine(sessionId: string, line: string): void {
    // Auto-emit RUN_STARTED on first output from a session
    if (!this.startedSessions.has(sessionId)) {
      this.startedSessions.add(sessionId);
      this.emitEvent(sessionId, "RUN_STARTED", {
        agent_name: "claude",
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
}
