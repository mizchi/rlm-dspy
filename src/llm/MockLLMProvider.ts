import type {
  ChatMessage,
  LLMCompleteOptions,
  LLMProvider,
  LLMResult,
  LLMUsage,
} from './LLMProvider.ts';

interface MockCall {
  depth: number;
  messages: ChatMessage[];
  response: string;
}

interface MockLLMProviderOptions {
  scriptsByDepth?: Record<number, string[]>;
  fallbackByDepth?: Record<number, string>;
  usage?: LLMUsage;
  resolver?: (ctx: {
    depth: number;
    callIndex: number;
    messages: ChatMessage[];
  }) => string;
}

export class MockLLMProvider implements LLMProvider {
  readonly calls: MockCall[] = [];

  private readonly scriptsByDepth: Record<number, string[]>;
  private readonly fallbackByDepth: Record<number, string>;
  private readonly usage: LLMUsage | undefined;
  private readonly resolver: MockLLMProviderOptions['resolver'] | undefined;
  private readonly counters = new Map<number, number>();

  constructor(options: MockLLMProviderOptions = {}) {
    this.scriptsByDepth = options.scriptsByDepth ?? {};
    this.fallbackByDepth = options.fallbackByDepth ?? {};
    this.usage = options.usage;
    this.resolver = options.resolver;
  }

  async complete(
    messages: ChatMessage[],
    _options?: LLMCompleteOptions,
  ): Promise<LLMResult> {
    const depth = detectDepth(messages);
    const callIndex = this.counters.get(depth) ?? 0;
    this.counters.set(depth, callIndex + 1);

    const response = this.resolveResponse({ depth, callIndex, messages });
    this.calls.push({
      depth,
      messages: messages.map((m) => ({ ...m })),
      response,
    });

    const result: LLMResult = {
      text: response,
    };
    if (this.usage !== undefined) {
      result.usage = this.usage;
    }
    return result;
  }

  getCallCountByDepth(depth: number): number {
    return this.calls.filter((call) => call.depth === depth).length;
  }

  private resolveResponse(args: {
    depth: number;
    callIndex: number;
    messages: ChatMessage[];
  }): string {
    if (this.resolver !== undefined) {
      return this.resolver(args);
    }

    const scripted = this.scriptsByDepth[args.depth] ?? [];
    if (args.callIndex < scripted.length) {
      return scripted[args.callIndex] as string;
    }

    const fallback = this.fallbackByDepth[args.depth];
    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error(
      `MockLLMProvider: no scripted response for depth=${args.depth} callIndex=${args.callIndex}`,
    );
  }
}

const detectDepth = (messages: ChatMessage[]): number => {
  for (const msg of messages) {
    if (msg.role !== 'user') {
      continue;
    }
    try {
      const parsed = JSON.parse(msg.content) as { depth?: unknown };
      if (typeof parsed.depth === 'number') {
        return parsed.depth;
      }
    } catch {
      // ignored
    }
  }
  return 0;
};
