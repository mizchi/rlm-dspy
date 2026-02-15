import type {
  ChatMessage,
  LLMCompleteOptions,
  LLMResponseFormat,
  LLMProvider,
  LLMResult,
} from './LLMProvider.ts';

interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAIProvider implements LLMProvider {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseURL = options.baseURL ?? 'https://api.openai.com/v1';
    this.timeoutMs = options.timeoutMs ?? 30_000;

    if (this.apiKey === '') {
      throw new Error('OPENAI_API_KEY is required');
    }
  }

  async complete(
    messages: ChatMessage[],
    options?: LLMCompleteOptions,
  ): Promise<LLMResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };

    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.stop !== undefined) {
      body.stop = options.stop;
    }
    if (options?.responseFormat !== undefined) {
      body.response_format = toOpenAIResponseFormat(options.responseFormat);
    }

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    };
    if (options?.signal !== undefined) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      init.signal =
        typeof AbortSignal.any === 'function'
          ? AbortSignal.any([options.signal, timeoutSignal])
          : options.signal;
    } else {
      init.signal = AbortSignal.timeout(this.timeoutMs);
    }

    const res = await fetch(`${this.baseURL}/chat/completions`, init);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as OpenAIChatCompletionResponse;
    const text = json.choices?.[0]?.message?.content ?? '';

    const usage: LLMResult['usage'] = {};
    if (json.usage?.prompt_tokens !== undefined) {
      usage.inputTokens = json.usage.prompt_tokens;
    }
    if (json.usage?.completion_tokens !== undefined) {
      usage.outputTokens = json.usage.completion_tokens;
    }

    return {
      text,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      raw: json,
    };
  }
}

const toOpenAIResponseFormat = (
  format: LLMResponseFormat,
): Record<string, unknown> => {
  if (format.type === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: format.json_schema,
  };
};
