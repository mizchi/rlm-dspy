import type { BudgetState } from '../budget/Budget.ts';
import type { LLMCompleteOptions, LLMProvider } from '../llm/LLMProvider.ts';
import type { TraceEvent } from '../trace/Trace.ts';
import type { DocStore } from '../doc/DocStore.ts';

export interface DocStoreFactoryInput {
  prompt: string;
  promptId: string;
  depth: number;
}

export interface RLMEnv {
  prompt: string;
  promptId: string;
  docStore: DocStore;
  scratch: Record<string, unknown>;
  cache: Map<string, string>;
  final?: string;
  budget: BudgetState;
  trace: TraceEvent[];
}

export interface RLMOptions {
  llm?: LLMCompleteOptions;
  budget?: Partial<BudgetState>;
  subBudget?: Partial<BudgetState>;
  metaPreviewChars?: number;
  systemPrompt?: string;
  task?: string;
  requirePromptReadBeforeFinalize?: boolean;
  enableHeuristicPostprocess?: boolean;
  enableEarlyStopHeuristic?: boolean;
  maxConsecutiveErrorsForEarlyStop?: number;
  docStoreFactory?: (input: DocStoreFactoryInput) => DocStore;
}

export interface SubRLMOptions {
  prompt?: string;
  budget?: Partial<BudgetState>;
}

export interface RLMResultPack {
  final: string;
  trace: TraceEvent[];
  budget: BudgetState;
}

export type SubRLMFn = (
  query: string,
  options?: SubRLMOptions,
) => Promise<string>;

export type RunChildRLM = (input: {
  prompt: string;
  query: string;
  options?: SubRLMOptions;
}) => Promise<string>;

export type RLMRunner = (
  prompt: string,
  llm: LLMProvider,
  opts?: RLMOptions,
) => Promise<RLMResultPack>;
