/**
 * Minimal structural Pi API surface used by this extension.
 *
 * Same adapter-boundary pattern as PiToRuleThemAll: the core never imports Pi
 * types, this file declares only the members Studio touches, the real
 * ExtensionAPI satisfies it structurally at runtime, and tests need no Pi
 * package. A Pi upgrade can break at most this file.
 */

export type PiMode = "tui" | "rpc" | "json" | "print";

export interface PiUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface PiToolInfo {
  name: string;
}

export interface PiContext {
  cwd: string;
  mode: PiMode;
  hasUI: boolean;
  ui: PiUi;
  isProjectTrusted(): boolean;
  model?: { provider?: string; id?: string } | undefined;
}

export interface PiToolContext extends PiContext {
  tools: PiToolInfo[];
  executeTool(
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{
    isError?: boolean;
    result?: { content?: { type?: string; text?: string }[] };
    content?: { type?: string; text?: string }[];
  }>;
}

export interface PiToolResult {
  content: { type: string; text: string }[];
  details?: unknown;
  isError?: boolean;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: PiToolContext,
  ): Promise<PiToolResult>;
}

/** `agent_before_settle` projection Pi hands to handlers. */
export interface PiBoundaryEvent {
  type: "agent_before_settle";
  outcome: "completed" | "aborted" | "error";
  entries: unknown[];
  continue: boolean;
  context: { canContinue: boolean };
}

export interface PiBeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: {
    sections?: Record<string, string>;
    appendSystemPrompt?: string;
    promptGuidelines?: string[];
    [key: string]: unknown;
  };
}

export interface PiSessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface PiAgentEndEvent {
  type: "agent_end";
  messages: unknown[];
}

export interface PiBoundaryResult {
  entries?: unknown[];
  continue?: boolean;
}

export interface PiBeforeAgentStartResult {
  message?: { customType: string; content: string; display: boolean; details?: unknown };
  systemPrompt?: string;
}

export interface PiApi {
  on(event: "session_start", handler: (event: PiSessionStartEvent, ctx: PiContext) => Promise<void> | void): () => void;
  on(
    event: "before_agent_start",
    handler: (event: PiBeforeAgentStartEvent, ctx: PiContext) => Promise<PiBeforeAgentStartResult | undefined> | PiBeforeAgentStartResult | undefined,
  ): () => void;
  on(event: "agent_end", handler: (event: PiAgentEndEvent, ctx: PiContext) => Promise<void> | void): () => void;
  on(
    event: "agent_before_settle",
    handler: (event: PiBoundaryEvent, ctx: PiContext) => Promise<PiBoundaryResult | undefined> | PiBoundaryResult | undefined,
  ): () => void;
  on(event: "agent_settled", handler: (event: { type: "agent_settled" }, ctx: PiContext) => Promise<void> | void): () => void;
  on(event: "session_shutdown", handler: (event: { type: "session_shutdown"; reason: string }, ctx: PiContext) => Promise<void> | void): () => void;
  registerTool(def: PiToolDefinition): void;
  getAllTools(): PiToolInfo[];
}

/** Custom-message draft accepted by the boundary `entries` array. */
export interface CustomMessageDraft {
  type: "custom_message";
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

export function customMessage(customType: string, content: string, display: boolean, details?: unknown): CustomMessageDraft {
  return { type: "custom_message", customType, content, display, details };
}

export function textResult(text: string, details?: unknown, isError = false): PiToolResult {
  return { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }), ...(isError ? { isError } : {}) };
}
