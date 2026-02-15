import type {
  ChatMessage,
  LLMCompleteOptions,
  LLMProvider,
  LLMResult,
  LLMUsage,
} from '../llm/LLMProvider.ts';
import { runRLM } from '../rlm/runRLM.ts';
import { scoreAnswer } from './scoring.ts';
import type {
  EvalCase,
  EvalCaseResult,
  EvalModeSummary,
  EvalReport,
  EvalUsageSummary,
  EvaluateOptions,
  ModeEvalResult,
} from './types.ts';

interface MeteredCall {
  inputChars: number;
  outputChars: number;
  usage?: LLMUsage;
}

class MeteredLLMProvider implements LLMProvider {
  private readonly inner: LLMProvider;
  readonly calls: MeteredCall[] = [];

  constructor(inner: LLMProvider) {
    this.inner = inner;
  }

  async complete(
    messages: ChatMessage[],
    options?: LLMCompleteOptions,
  ): Promise<LLMResult> {
    const inputChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    const res = await this.inner.complete(messages, options);
    const call: MeteredCall = {
      inputChars,
      outputChars: res.text.length,
    };
    if (res.usage !== undefined) {
      call.usage = res.usage;
    }
    this.calls.push(call);
    return res;
  }

  summarize(): EvalUsageSummary {
    return this.calls.reduce<EvalUsageSummary>(
      (acc, call) => {
        acc.calls += 1;
        acc.inputChars += call.inputChars;
        acc.outputChars += call.outputChars;
        acc.inputTokens += call.usage?.inputTokens ?? 0;
        acc.outputTokens += call.usage?.outputTokens ?? 0;
        acc.costUSD += call.usage?.costUSD ?? 0;
        return acc;
      },
      {
        calls: 0,
        inputChars: 0,
        outputChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
      },
    );
  }
}

const DEFAULT_BASELINE_SYSTEM_PROMPT =
  'You solve tasks from a provided document. Return only the final answer without explanation.';

export const evaluateCases = async (
  cases: EvalCase[],
  options: EvaluateOptions,
): Promise<EvalReport> => {
  const results: EvalCaseResult[] = [];

  for (const evalCase of cases) {
    const metric = evalCase.metric ?? 'exact';

    const baseline = await runBaselineCase(evalCase, metric, options);
    const rlmResult = await runRLMCase(evalCase, metric, options);

    results.push({
      caseId: evalCase.id,
      metric,
      expected: evalCase.expected,
      baseline,
      rlm: rlmResult,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: summarize(results),
    results,
  };
};

const runBaselineCase = async (
  evalCase: EvalCase,
  metric: 'exact' | 'contains',
  options: EvaluateOptions,
): Promise<ModeEvalResult> => {
  const meter = new MeteredLLMProvider(options.providerFactory('baseline', evalCase));
  const started = Date.now();

  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: options.baselineSystemPrompt ?? DEFAULT_BASELINE_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          `Query: ${evalCase.query}`,
          '',
          'Document:',
          evalCase.prompt,
        ].join('\n'),
      },
    ];

    const res = await meter.complete(messages, options.baselineLLMOptions);
    const answer = res.text.trim();

    return {
      mode: 'baseline',
      answer,
      correct: scoreAnswer(evalCase.expected, answer, metric),
      latencyMs: Date.now() - started,
      usage: meter.summarize(),
    };
  } catch (cause) {
    return {
      mode: 'baseline',
      answer: '',
      correct: false,
      latencyMs: Date.now() - started,
      usage: meter.summarize(),
      error: (cause as Error).message,
    };
  }
};

const runRLMCase = async (
  evalCase: EvalCase,
  metric: 'exact' | 'contains',
  options: EvaluateOptions,
): Promise<ModeEvalResult> => {
  const meter = new MeteredLLMProvider(options.providerFactory('rlm', evalCase));
  const started = Date.now();

  try {
    const mergedBudget = {
      ...(options.rlmOptions?.budget ?? {}),
      ...(evalCase.budget ?? {}),
    };

    const out = await runRLM(evalCase.prompt, meter, {
      ...(options.rlmOptions ?? {}),
      budget: mergedBudget,
      task: evalCase.query,
    });

    const answer = out.final.trim();
    return {
      mode: 'rlm',
      answer,
      correct: scoreAnswer(evalCase.expected, answer, metric),
      latencyMs: Date.now() - started,
      usage: meter.summarize(),
      stepsUsed: out.budget.stepsUsed,
      subCallsUsed: out.budget.subCallsUsed,
      promptReadCharsUsed: out.budget.promptReadCharsUsed,
    };
  } catch (cause) {
    return {
      mode: 'rlm',
      answer: '',
      correct: false,
      latencyMs: Date.now() - started,
      usage: meter.summarize(),
      error: (cause as Error).message,
    };
  }
};

const summarize = (results: EvalCaseResult[]): {
  totalCases: number;
  baseline: EvalModeSummary;
  rlm: EvalModeSummary;
  accuracyDelta: number;
} => {
  const total = results.length;

  const baselineCorrect = results.filter((r) => r.baseline.correct).length;
  const rlmCorrect = results.filter((r) => r.rlm.correct).length;

  const baselineSummary = summarizeMode(
    results.map((r) => r.baseline),
    baselineCorrect,
    total,
  );
  const rlmSummary = summarizeMode(
    results.map((r) => r.rlm),
    rlmCorrect,
    total,
  );

  return {
    totalCases: total,
    baseline: baselineSummary,
    rlm: rlmSummary,
    accuracyDelta: rlmSummary.accuracy - baselineSummary.accuracy,
  };
};

const summarizeMode = (
  rows: ModeEvalResult[],
  correct: number,
  total: number,
): EvalModeSummary => {
  const usage = rows.reduce<EvalUsageSummary>(
    (acc, row) => {
      acc.calls += row.usage.calls;
      acc.inputChars += row.usage.inputChars;
      acc.outputChars += row.usage.outputChars;
      acc.inputTokens += row.usage.inputTokens;
      acc.outputTokens += row.usage.outputTokens;
      acc.costUSD += row.usage.costUSD;
      return acc;
    },
    {
      calls: 0,
      inputChars: 0,
      outputChars: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
    },
  );

  return {
    correct,
    accuracy: total === 0 ? 0 : correct / total,
    avgLatencyMs:
      rows.length === 0
        ? 0
        : rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length,
    usage,
  };
};
