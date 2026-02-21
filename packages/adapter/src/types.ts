/**
 * AG-UI Protocol event types emitted by the adapter layer.
 */
export type AGUIEventType =
  | "RUN_STARTED"
  | "TEXT_MESSAGE_CONTENT"
  | "STEP_STARTED"
  | "WAITING_FOR_HUMAN"
  | "RUN_FINISHED";

/**
 * Base message sent from adapter to presentation layer.
 */
export interface AGUIMessage {
  type: AGUIEventType;
  session_id: string;
  timestamp: string;
  data: RunStartedData | TextMessageData | StepStartedData | WaitingForHumanData | RunFinishedData;
}

export interface RunStartedData {
  agent_name: string;
}

export interface TextMessageData {
  delta: string;
}

export interface StepStartedData {
  step_type: "tool_call";
  tool_name: string;
}

export interface A2UIPayload {
  component: string;
  props: Record<string, unknown>;
}

export interface WaitingForHumanData {
  reason: string;
  a2ui_payload?: A2UIPayload;
}

export interface RunFinishedData {
  status: "success" | "failed";
}

/**
 * Action sent from presentation layer back to adapter.
 */
export interface HumanAction {
  session_id: string;
  action_type: "APPROVE" | "REJECT" | "PROVIDE_INPUT";
  payload: string | boolean;
}

/**
 * Session state tracked by the process manager.
 */
export type SessionStatus = "running" | "waiting" | "finished";

export interface SessionInfo {
  session_id: string;
  agent_name: string;
  command: string;
  status: SessionStatus;
  created_at: string;
}
