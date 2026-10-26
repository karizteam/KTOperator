/**
 * Provider-independent AI orchestration contract. Every adapter normalizes
 * its vendor API into these shapes so the agent core never deals with
 * provider specifics.
 */
import type { JSONSchema } from '../../tools/json-schema.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string exactly as produced by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool result messages. */
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type ResponseFormat = 'text' | 'json';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  /** Invoked with each streamed text delta (streaming mode only). */
  onToken?: (delta: string) => void;
  responseFormat?: ResponseFormat;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** USD cost when the provider reports it (e.g. OpenRouter). */
  costUsd?: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';
  usage?: Usage;
  model?: string;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutputs: boolean;
  modelListing: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  contextLength?: number;
  capabilities?: Partial<ProviderCapabilities>;
}

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
  modelsDiscovered?: number;
}

export interface AIProvider {
  readonly type: string;
  readonly label: string;
  capabilities(): ProviderCapabilities;
  chat(request: ChatRequest): Promise<ChatResult>;
  listModels?(): Promise<ModelInfo[]>;
  testConnection?(): Promise<ConnectionTestResult>;
}

export interface ProviderDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for SSRF DNS checks in tests. */
  lookupImpl?: (hostname: string) => Promise<string[]>;
  maxRetries?: number;
  timeoutMs?: number;
}
