/**
 * AG-UI Protocol types - mirrored from packages/adapter/src/types.ts
 */

export type AGUIEventType =
  | "RUN_STARTED"
  | "TEXT_MESSAGE_CONTENT"
  | "STEP_STARTED"
  | "WAITING_FOR_HUMAN"
  | "RUN_FINISHED";

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

export interface HumanAction {
  session_id: string;
  action_type: "APPROVE" | "REJECT" | "PROVIDE_INPUT";
  payload: string | boolean;
}

export type SessionStatus = "running" | "waiting" | "finished" | "idle";
