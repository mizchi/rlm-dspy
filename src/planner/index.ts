import type { BudgetState } from '../budget/Budget.ts';
import { buildProfileRLMOptions } from '../eval/profile.ts';
import {
  buildPolicyFromMetricSymbols,
  collectMetricSnapshotBySymbols,
  runLongImprovementLoop,
  type ConstraintMetricSymbol,
  type LongRunImprovementReport,
  type LongRunIterationContext,
  type ObjectiveMetricSymbol,
} from '../improve/longRun.ts';
import type { ImprovementCandidate, ImprovementResult, MetricSnapshot } from '../improve/index.ts';
import type {
  LLMCompleteOptions,
  LLMProvider,
  LLMResponseFormat,
} from '../llm/LLMProvider.ts';
import { runRLM } from '../rlm/runRLM.ts';
import type {
  ExternalSymbolFn,
  RLMOptions,
  RLMResultPack,
} from '../rlm/types.ts';
import { hashString } from '../util/hash.ts';
import { parseOneJSON } from '../util/json.ts';

export type PlannerMode = 'single' | 'long_run';

export interface PlannerObjectiveSpec {
  key: string;
  direction: 'maximize' | 'minimize';
  symbol: string;
  weight?: number;
}

export interface PlannerConstraintSpec {
  key: string;
  comparator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq';
  value: number;
  symbol?: string;
  source?: 'absolute' | 'delta' | 'ratio' | 'delta_ratio';
}

export interface PlannerLongRunSpec {
  objectives: PlannerObjectiveSpec[];
  constraints?: PlannerConstraintSpec[];
  maxIterations?: number;
  stopWhenNoAccept?: boolean;
  minScoreDelta?: number;
}

export interface RLMPlannerPlan {
  kind: 'rlm_plan';
  version: 1;
  mode: PlannerMode;
  task: string;
  profile?: 'pure' | 'hybrid';
  budget?: Partial<BudgetState>;
  requirePromptReadBeforeFinalize?: boolean;
  enableHeuristicPostprocess?: boolean;
  enableEarlyStopHeuristic?: boolean;
  symbols?: string[];
  longRun?: PlannerLongRunSpec;
}

export interface CreateRLMPlanArgs {
  input: string;
  prompt: string;
  llm: LLMProvider;
  availableSymbols?: string[];
  systemPrompt?: string;
  llmOptions?: LLMCompleteOptions;
}

export interface PlannedLongRunHooks<TCandidate = unknown, TState = unknown> {
  baseline: MetricSnapshot;
  initialState: TState;
  maxIterations?: number;
  stopWhenNoAccept?: boolean;
  generateCandidates: (
    context: LongRunIterationContext<TCandidate, TState> & { plan: RLMPlannerPlan },
  ) => Promise<ImprovementCandidate<TCandidate>[]>;
  onAccepted?: (
    accepted: ImprovementResult<TCandidate>,
    context: LongRunIterationContext<TCandidate, TState> & { plan: RLMPlannerPlan },
  ) => Promise<TState> | TState;
}

export interface RunPlannedRLMArgs<TCandidate = unknown, TState = unknown> {
  input: string;
  prompt: string;
  plannerLLM: LLMProvider;
  executorLLM?: LLMProvider;
  symbols?: Record<string, ExternalSymbolFn>;
  availableSymbols?: string[];
  plannerSystemPrompt?: string;
  plannerLLMOptions?: LLMCompleteOptions;
  runtimeOptions?: RLMOptions;
  planOverride?: RLMPlannerPlan;
  longRun?: PlannedLongRunHooks<TCandidate, TState>;
}

export type PlannedRLMResult<TCandidate = unknown, TState = unknown> =
  | {
      mode: 'single';
      plan: RLMPlannerPlan;
      result: RLMResultPack;
    }
  | {
      mode: 'long_run';
      plan: RLMPlannerPlan;
      result: LongRunImprovementReport<TCandidate, TState>;
    };

const DEFAULT_PLANNER_SYSTEM_PROMPT = [
  'You are an RLM planner.',
  'Convert user input to one JSON plan object.',
  'Output exactly one JSON object and nothing else.',
  'Plan schema:',
  '{',
  '  "mode": "single" | "long_run",',
  '  "task": string,',
  '  "profile"?: "pure" | "hybrid",',
  '  "symbols"?: string[],',
  '  "budget"?: { "maxSteps"?: number, "maxSubCalls"?: number, "maxDepth"?: number },',
  '  "longRun"?: {',
  '    "objectives": [{ "key": string, "direction": "minimize"|"maximize", "symbol": string, "weight"?: number }],',
  '    "constraints"?: [{ "key": string, "comparator": "lt"|"lte"|"gt"|"gte"|"eq", "value": number, "symbol"?: string, "source"?: "absolute"|"delta" }],',
  '    "maxIterations"?: number,',
  '    "stopWhenNoAccept"?: boolean,',
  '    "minScoreDelta"?: number',
  '  }',
  '}',
  'Use mode=single unless the user explicitly asks iterative optimization over measurable metrics.',
].join(' ');

const PLANNER_RESPONSE_FORMAT: LLMResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'rlm_planner',
    strict: false,
    schema: {
      type: 'object',
      required: ['mode', 'task'],
      additionalProperties: true,
      properties: {
        mode: { type: ['string', 'null'], enum: ['single', 'long_run', null] },
        task: { type: ['string', 'null'] },
        profile: { type: ['string', 'null'], enum: ['pure', 'hybrid', null] },
        symbols: { type: ['array', 'null'], items: { type: 'string' } },
        budget: { type: ['object', 'null'] },
        longRun: {
          type: ['object', 'null'],
          additionalProperties: true,
          properties: {
            objectives: {
              type: ['array', 'null'],
              items: {
                type: 'object',
                required: ['key', 'direction', 'symbol'],
                additionalProperties: true,
                properties: {
                  key: { type: 'string' },
                  direction: {
                    type: 'string',
                    enum: ['minimize', 'maximize'],
                  },
                  symbol: { type: 'string' },
                  weight: { type: ['number', 'null'] },
                },
              },
            },
            constraints: {
              type: ['array', 'null'],
              items: {
                type: 'object',
                required: ['key', 'comparator', 'value'],
                additionalProperties: true,
                properties: {
                  key: { type: 'string' },
                  comparator: {
                    type: 'string',
                    enum: ['lt', 'lte', 'gt', 'gte', 'eq'],
                  },
                  value: { type: 'number' },
                  symbol: { type: ['string', 'null'] },
                  source: {
                    type: ['string', 'null'],
                    enum: ['absolute', 'delta', 'ratio', 'delta_ratio', null],
                  },
                },
              },
            },
            maxIterations: { type: ['number', 'null'] },
            stopWhenNoAccept: { type: ['boolean', 'null'] },
            minScoreDelta: { type: ['number', 'null'] },
          },
        },
      },
    },
  },
};

export const createRLMPlan = async (
  args: CreateRLMPlanArgs,
): Promise<RLMPlannerPlan> => {
  const systemPrompt = args.systemPrompt ?? DEFAULT_PLANNER_SYSTEM_PROMPT;
  const availableSymbols = args.availableSymbols ?? [];
  const res = await args.llm.complete(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          kind: 'rlm_plan_request',
          input: args.input,
          prompt: {
            length: args.prompt.length,
            preview: args.prompt.slice(0, 200),
          },
          availableSymbols,
        }),
      },
    ],
    {
      responseFormat: PLANNER_RESPONSE_FORMAT,
      ...(args.llmOptions ?? {}),
    },
  );

  try {
    const parsed = parseOneJSON<unknown>(res.text);
    return coercePlannerPlan({
      raw: parsed,
      fallbackTask: args.input,
      availableSymbols,
    });
  } catch {
    return makeDefaultSinglePlan({
      task: args.input,
      availableSymbols,
    });
  }
};

export const runPlannedRLM = async <TCandidate = unknown, TState = unknown>(
  args: RunPlannedRLMArgs<TCandidate, TState>,
): Promise<PlannedRLMResult<TCandidate, TState>> => {
  const plan =
    args.planOverride ??
    (await createRLMPlan({
      input: args.input,
      prompt: args.prompt,
      llm: args.plannerLLM,
      availableSymbols: args.availableSymbols ?? Object.keys(args.symbols ?? {}),
      ...(args.plannerSystemPrompt !== undefined
        ? { systemPrompt: args.plannerSystemPrompt }
        : {}),
      ...(args.plannerLLMOptions !== undefined
        ? { llmOptions: args.plannerLLMOptions }
        : {}),
    }));

  if (plan.mode === 'long_run') {
    if (plan.longRun === undefined) {
      throw new Error('planner long_run mode requires longRun spec');
    }
    if (args.longRun === undefined) {
      throw new Error('runPlannedRLM long_run mode requires args.longRun hooks');
    }

    const symbols = args.symbols ?? {};
    const metricReaders = buildMetricReaders({
      plan,
      prompt: args.prompt,
      symbols,
    });
    const policy = buildPolicyFromMetricSymbols({
      objectives: metricReaders.objectives,
      ...(metricReaders.constraints.length > 0
        ? { constraints: metricReaders.constraints }
        : {}),
      ...(plan.longRun.minScoreDelta !== undefined
        ? { minScoreDelta: plan.longRun.minScoreDelta }
        : {}),
    });

    const longRunArgs: Parameters<
      typeof runLongImprovementLoop<TCandidate, TState>
    >[0] = {
      baseline: args.longRun.baseline,
      policy,
      initialState: args.longRun.initialState,
      maxIterations:
        plan.longRun.maxIterations ??
        args.longRun.maxIterations ??
        8,
      generateCandidates: async (context) =>
        args.longRun?.generateCandidates({
          ...context,
          plan,
        }) ?? [],
      evaluate: async (candidate, context) =>
        collectMetricSnapshotBySymbols({
          candidate,
          iteration: context.iteration,
          state: context.state,
          objectives: metricReaders.objectives,
          constraints: metricReaders.constraints,
        }),
      ...(args.longRun.onAccepted !== undefined
        ? {
            onAccepted: async (accepted, context) =>
              args.longRun?.onAccepted?.(accepted, {
                ...context,
                plan,
              }) ?? context.state,
          }
        : {}),
    };
    const stopWhenNoAccept =
      plan.longRun.stopWhenNoAccept ?? args.longRun.stopWhenNoAccept;
    if (stopWhenNoAccept !== undefined) {
      longRunArgs.stopWhenNoAccept = stopWhenNoAccept;
    }
    const result = await runLongImprovementLoop<TCandidate, TState>(
      longRunArgs,
    );

    return {
      mode: 'long_run',
      plan,
      result,
    };
  }

  const symbols = pickSymbolsForPlan(args.symbols, plan.symbols);
  const runtimeOptions = compilePlanToRLMOptions({
    plan,
    ...(args.runtimeOptions !== undefined
      ? { base: args.runtimeOptions }
      : {}),
    ...(symbols !== undefined ? { symbols } : {}),
  });
  const llm = args.executorLLM ?? args.plannerLLM;
  const result = await runRLM(args.prompt, llm, runtimeOptions);
  return {
    mode: 'single',
    plan,
    result,
  };
};

export const compilePlanToRLMOptions = (args: {
  plan: RLMPlannerPlan;
  base?: RLMOptions;
  symbols?: Record<string, ExternalSymbolFn>;
}): RLMOptions => {
  const profile = buildProfileRLMOptions(args.plan.profile ?? 'hybrid');
  const fromPlan: RLMOptions = {
    task: args.plan.task,
    ...(args.plan.requirePromptReadBeforeFinalize !== undefined
      ? {
          requirePromptReadBeforeFinalize:
            args.plan.requirePromptReadBeforeFinalize,
        }
      : {}),
    ...(args.plan.enableHeuristicPostprocess !== undefined
      ? { enableHeuristicPostprocess: args.plan.enableHeuristicPostprocess }
      : {}),
    ...(args.plan.enableEarlyStopHeuristic !== undefined
      ? { enableEarlyStopHeuristic: args.plan.enableEarlyStopHeuristic }
      : {}),
    ...(args.plan.budget !== undefined ? { budget: args.plan.budget } : {}),
  };

  const out: RLMOptions = {
    ...profile,
    ...fromPlan,
    ...(args.base ?? {}),
    task: args.base?.task ?? args.plan.task,
  };
  out.budget = {
    ...(profile.budget ?? {}),
    ...(fromPlan.budget ?? {}),
    ...(args.base?.budget ?? {}),
  };
  if (args.symbols !== undefined) {
    out.symbols = args.symbols;
  } else if (args.base?.symbols !== undefined) {
    out.symbols = args.base.symbols;
  }
  return out;
};

const buildMetricReaders = <TCandidate, TState>(args: {
  plan: RLMPlannerPlan;
  prompt: string;
  symbols: Record<string, ExternalSymbolFn>;
}): {
  objectives: ObjectiveMetricSymbol<TCandidate, TState>[];
  constraints: ConstraintMetricSymbol<TCandidate, TState>[];
} => {
  const longRun = args.plan.longRun;
  if (longRun === undefined) {
    throw new Error('longRun spec is required');
  }
  const promptId = hashString(args.prompt);

  const callMetric = async (input: {
    symbol: string;
    key: string;
    candidate: ImprovementCandidate<TCandidate>;
    iteration: number;
    state: TState;
  }): Promise<number> => {
    const fn = args.symbols[input.symbol];
    if (fn === undefined) {
      throw new Error(`metric symbol not found: ${input.symbol}`);
    }
    const raw = await fn({
      symbol: input.symbol,
      prompt: args.prompt,
      promptId,
      depth: 0,
      scratch: {},
      args: {
        candidate: input.candidate.input,
        iteration: input.iteration,
        state: input.state,
        metricKey: input.key,
        task: args.plan.task,
      },
      input: input.candidate.input,
    });
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new Error(`metric symbol must return finite number: ${input.symbol}`);
    }
    return num;
  };

  const objectives: ObjectiveMetricSymbol<TCandidate, TState>[] =
    longRun.objectives.map((row) => ({
      key: row.key,
      direction: row.direction,
      ...(row.weight !== undefined ? { weight: row.weight } : {}),
      read: async ({ candidate, iteration, state }) =>
        callMetric({
          symbol: row.symbol,
          key: row.key,
          candidate,
          iteration,
          state,
        }),
    }));

  const constraints: ConstraintMetricSymbol<TCandidate, TState>[] =
    (longRun.constraints ?? []).map((row) => ({
      key: row.key,
      comparator: row.comparator,
      value: row.value,
      ...(row.source !== undefined ? { source: row.source } : {}),
      read: async ({ candidate, iteration, state }) =>
        callMetric({
          symbol: row.symbol ?? row.key,
          key: row.key,
          candidate,
          iteration,
          state,
        }),
    }));

  return {
    objectives,
    constraints,
  };
};

const makeDefaultSinglePlan = (args: {
  task: string;
  availableSymbols: string[];
}): RLMPlannerPlan => ({
  kind: 'rlm_plan',
  version: 1,
  mode: 'single',
  task: args.task,
  ...(args.availableSymbols.length > 0 ? { symbols: args.availableSymbols } : {}),
});

const coercePlannerPlan = (args: {
  raw: unknown;
  fallbackTask: string;
  availableSymbols: string[];
}): RLMPlannerPlan => {
  if (!isRecord(args.raw)) {
    return makeDefaultSinglePlan({
      task: args.fallbackTask,
      availableSymbols: args.availableSymbols,
    });
  }
  const row = args.raw;
  const task = pickString(row.task) ?? args.fallbackTask;
  const mode = row.mode === 'long_run' ? 'long_run' : 'single';
  const profile =
    row.profile === 'pure' || row.profile === 'hybrid' ? row.profile : undefined;

  const symbols = pickStringArray(row.symbols);
  const budget = coerceBudget(row.budget);

  const plan: RLMPlannerPlan = {
    kind: 'rlm_plan',
    version: 1,
    mode,
    task,
    ...(profile !== undefined ? { profile } : {}),
    ...(symbols !== undefined ? { symbols } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(typeof row.requirePromptReadBeforeFinalize === 'boolean'
      ? { requirePromptReadBeforeFinalize: row.requirePromptReadBeforeFinalize }
      : {}),
    ...(typeof row.enableHeuristicPostprocess === 'boolean'
      ? { enableHeuristicPostprocess: row.enableHeuristicPostprocess }
      : {}),
    ...(typeof row.enableEarlyStopHeuristic === 'boolean'
      ? { enableEarlyStopHeuristic: row.enableEarlyStopHeuristic }
      : {}),
  };

  const longRun = coerceLongRunSpec(row.longRun);
  if (mode === 'long_run' && longRun !== undefined) {
    plan.longRun = longRun;
  } else if (mode === 'long_run') {
    plan.mode = 'single';
  }

  if (plan.symbols === undefined && args.availableSymbols.length > 0) {
    plan.symbols = args.availableSymbols;
  }
  return plan;
};

const coerceLongRunSpec = (input: unknown): PlannerLongRunSpec | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }
  const objectivesRaw = input.objectives;
  if (!Array.isArray(objectivesRaw) || objectivesRaw.length === 0) {
    return undefined;
  }
  const objectives: PlannerObjectiveSpec[] = [];
  for (const row of objectivesRaw) {
    if (!isRecord(row)) {
      continue;
    }
    const key = pickString(row.key);
    const direction =
      row.direction === 'minimize' || row.direction === 'maximize'
        ? row.direction
        : undefined;
    const symbol = pickString(row.symbol);
    if (key === undefined || direction === undefined || symbol === undefined) {
      continue;
    }
    const item: PlannerObjectiveSpec = {
      key,
      direction,
      symbol,
      ...(typeof row.weight === 'number' && Number.isFinite(row.weight)
        ? { weight: row.weight }
        : {}),
    };
    objectives.push(item);
  }
  if (objectives.length === 0) {
    return undefined;
  }

  const constraintsRaw = input.constraints;
  const constraints: PlannerConstraintSpec[] = [];
  if (Array.isArray(constraintsRaw)) {
    for (const row of constraintsRaw) {
      if (!isRecord(row)) {
        continue;
      }
      const key = pickString(row.key);
      const comparator =
        row.comparator === 'lt' ||
        row.comparator === 'lte' ||
        row.comparator === 'gt' ||
        row.comparator === 'gte' ||
        row.comparator === 'eq'
          ? row.comparator
          : undefined;
      const value =
        typeof row.value === 'number' && Number.isFinite(row.value)
          ? row.value
          : undefined;
      if (key === undefined || comparator === undefined || value === undefined) {
        continue;
      }
      const symbol = pickString(row.symbol);
      const source =
        row.source === 'absolute' ||
        row.source === 'delta' ||
        row.source === 'ratio' ||
        row.source === 'delta_ratio'
          ? row.source
          : undefined;
      constraints.push({
        key,
        comparator,
        value,
        ...(symbol !== undefined ? { symbol } : {}),
        ...(source !== undefined ? { source } : {}),
      });
    }
  }

  const out: PlannerLongRunSpec = {
    objectives,
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(typeof input.maxIterations === 'number' &&
    Number.isFinite(input.maxIterations)
      ? { maxIterations: Math.max(1, Math.floor(input.maxIterations)) }
      : {}),
    ...(typeof input.stopWhenNoAccept === 'boolean'
      ? { stopWhenNoAccept: input.stopWhenNoAccept }
      : {}),
    ...(typeof input.minScoreDelta === 'number' &&
    Number.isFinite(input.minScoreDelta)
      ? { minScoreDelta: input.minScoreDelta }
      : {}),
  };
  return out;
};

const coerceBudget = (input: unknown): Partial<BudgetState> | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }
  const out: Partial<BudgetState> = {};
  const keys: (keyof BudgetState)[] = [
    'maxSteps',
    'maxSubCalls',
    'maxDepth',
    'maxPromptReadChars',
    'maxTimeMs',
  ];
  for (const key of keys) {
    const raw = input[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const pickSymbolsForPlan = (
  symbols: Record<string, ExternalSymbolFn> | undefined,
  requested: string[] | undefined,
): Record<string, ExternalSymbolFn> | undefined => {
  if (symbols === undefined) {
    return undefined;
  }
  if (requested === undefined || requested.length === 0) {
    return symbols;
  }
  const picked: Record<string, ExternalSymbolFn> = {};
  for (const name of requested) {
    const fn = symbols[name];
    if (fn === undefined) {
      throw new Error(`planner requested unknown symbol: ${name}`);
    }
    picked[name] = fn;
  }
  return picked;
};

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const pickString = (input: unknown): string | undefined =>
  typeof input === 'string' && input.trim() !== '' ? input : undefined;

const pickStringArray = (input: unknown): string[] | undefined => {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const out = input.filter((v): v is string => typeof v === 'string' && v !== '');
  return out.length > 0 ? out : undefined;
};
