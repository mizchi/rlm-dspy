import type { BudgetState } from '../budget/Budget.ts';
import type { LLMCompleteOptions, LLMProvider } from '../llm/LLMProvider.ts';
import type { RLMOptions } from '../rlm/types.ts';

export type EvalMetric = 'exact' | 'contains';

export interface EvalCase {
  id: string;
  prompt: string;
  query: string;
  expected: string;
  metric?: EvalMetric;
  tags?: string[];
  budget?: Partial<BudgetState>;
}

export interface EvalUsageSummary {
  calls: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface ModeEvalResult {
  mode: 'baseline' | 'rlm';
  answer: string;
  correct: boolean;
  latencyMs: number;
  usage: EvalUsageSummary;
  error?: string;
  stepsUsed?: number;
  subCallsUsed?: number;
  promptReadCharsUsed?: number;
}

export interface EvalCaseResult {
  caseId: string;
  metric: EvalMetric;
  expected: string;
  baseline: ModeEvalResult;
  rlm: ModeEvalResult;
}

export interface EvalModeSummary {
  correct: number;
  accuracy: number;
  avgLatencyMs: number;
  usage: EvalUsageSummary;
}

export interface EvalSummary {
  totalCases: number;
  baseline: EvalModeSummary;
  rlm: EvalModeSummary;
  accuracyDelta: number;
}

export interface EvalReport {
  generatedAt: string;
  summary: EvalSummary;
  results: EvalCaseResult[];
}

export interface EvaluateOptions {
  providerFactory: (
    mode: 'baseline' | 'rlm',
    evalCase: EvalCase,
  ) => LLMProvider;
  baselineSystemPrompt?: string;
  baselineLLMOptions?: LLMCompleteOptions;
  rlmOptions?: RLMOptions;
}
