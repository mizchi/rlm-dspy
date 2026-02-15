export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
}

export interface LLMResult {
  text: string;
  usage?: LLMUsage;
  raw?: unknown;
}

export type LLMResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
        description?: string;
      };
    };

export interface LLMCompleteOptions {
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
  responseFormat?: LLMResponseFormat;
}

export interface LLMProvider {
  complete(messages: ChatMessage[], options?: LLMCompleteOptions): Promise<LLMResult>;
}
