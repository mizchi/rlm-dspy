export type {
  ChatMessage,
  LLMProvider,
  LLMResult,
  LLMUsage,
  Role,
} from './llm/LLMProvider.ts';

export { MockLLMProvider } from './llm/MockLLMProvider.ts';
export { OpenAIProvider } from './llm/OpenAIProvider.ts';

export {
  BudgetExceeded,
  defaultBudget,
  type BudgetState,
} from './budget/Budget.ts';

export {
  InMemoryDocStore,
  MCPDocStore,
  type DocStore,
  type MCPDocStoreClient,
} from './doc/DocStore.ts';

export type {
  ExternalSymbolCall,
  ExternalSymbolFn,
  RLMEnv,
  RLMOptions,
  RLMResultPack,
  SubRLMOptions,
} from './rlm/types.ts';

export { runRLM as rlm } from './rlm/runRLM.ts';

export type {
  EvalCase,
  EvalCaseResult,
  EvalMetric,
  EvalModeSummary,
  EvalReport,
  EvalSummary,
  EvalUsageSummary,
  EvaluateOptions,
  ModeEvalResult,
} from './eval/types.ts';

export { parseEvalJSONL } from './eval/jsonl.ts';
export { scoreAnswer } from './eval/scoring.ts';
export { evaluateCases } from './eval/evaluate.ts';
export {
  buildProfileRLMOptions,
  parseRLMProfile,
  type RLMProfile,
} from './eval/profile.ts';

export type {
  ImprovementCandidate,
  ImprovementConstraint,
  ImprovementContext,
  ImprovementObjective,
  ImprovementPolicy,
  ImprovementReport,
  ImprovementResult,
  MetricComparator,
  MetricDirection,
  MetricSnapshot,
  RunImprovementLoopArgs,
} from './improve/index.ts';
export { runImprovementLoop, scoreSnapshot } from './improve/index.ts';

export type {
  BuildPolicyFromMetricSymbolsArgs,
  CollectMetricSnapshotBySymbolsArgs,
  ConstraintMetricSymbol,
  LongRunImprovementReport,
  LongRunIterationContext,
  ObjectiveMetricSymbol,
  RunLongImprovementLoopArgs,
} from './improve/longRun.ts';
export {
  buildPolicyFromMetricSymbols,
  collectMetricSnapshotBySymbols,
  runLongImprovementLoop,
} from './improve/longRun.ts';
