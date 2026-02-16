import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MockLLMProvider } from '../llm/MockLLMProvider.ts';
import { OpenAIProvider } from '../llm/OpenAIProvider.ts';
import {
  createRLMPlan,
  runPlannedRLM,
  type PlannedRLMResult,
  type RLMPlannerPlan,
} from '../planner/index.ts';
import { createMetricSymbol, selectUntriedCandidates } from './harness.ts';
import type { ImprovementCandidate } from './index.ts';
import type { ExternalSymbolFn } from '../rlm/types.ts';
import type { PlannerProvider } from '../util/cli.ts';

export interface LongRunCommonArgs {
  plannerProvider: PlannerProvider;
  model: string;
  goal: string;
  maxIterations: number;
  candidateLimit: number;
  outPath?: string;
}

export interface LongRunProgramIO {
  writer: (line: string) => void;
  errorWriter: (line: string) => void;
}

export interface RunLongRunProgramOptions {
  writer?: (line: string) => void;
  errorWriter?: (line: string) => void;
}

export interface LongRunProgramSpec<
  TArgs extends LongRunCommonArgs,
  TPool,
  TCandidate,
  TMetrics extends Record<string, number>,
  TState,
> {
  symbolName: string;
  parseArgs: (argv: string[]) => TArgs;
  createMockPlan: (goal: string, maxIterations: number) => RLMPlannerPlan;
  normalizePlan: (
    plan: RLMPlannerPlan,
    goal: string,
    maxIterations: number,
  ) => RLMPlannerPlan;
  buildPrompt: (args: TArgs) => string;
  loadPool: (args: TArgs) => Promise<TPool[]>;
  toCandidate: (entry: TPool) => ImprovementCandidate<TCandidate>;
  baselineCandidate: (args: TArgs) => TCandidate;
  coerceCandidate: (input: unknown) => TCandidate;
  evaluateCandidate: (
    args: TArgs,
    candidate: TCandidate,
    io: LongRunProgramIO,
  ) => Promise<TMetrics>;
  pickMetric: (metrics: TMetrics, key: string) => number;
  initialState: (args: TArgs) => TState;
  formatMetrics: (metrics: Record<string, number>) => string;
  cacheKey?: (candidate: TCandidate) => string;
  stopWhenNoAccept?: (args: TArgs) => boolean | undefined;
}

export const runLongRunProgram = async <
  TArgs extends LongRunCommonArgs,
  TPool,
  TCandidate,
  TMetrics extends Record<string, number>,
  TState,
>(
  spec: LongRunProgramSpec<TArgs, TPool, TCandidate, TMetrics, TState>,
  argv: string[],
  options: RunLongRunProgramOptions = {},
): Promise<PlannedRLMResult<TCandidate, TState>> => {
  const io: LongRunProgramIO = {
    writer: options.writer ?? ((line) => process.stdout.write(`${line}\n`)),
    errorWriter:
      options.errorWriter ?? ((line) => process.stderr.write(`${line}\n`)),
  };

  const args = spec.parseArgs(argv);
  const plannerLLM =
    args.plannerProvider === 'openai'
      ? new OpenAIProvider({ model: args.model })
      : new MockLLMProvider({
          scriptsByDepth: {
            0: [JSON.stringify(spec.createMockPlan(args.goal, args.maxIterations))],
          },
        });

  const pool = await spec.loadPool(args);
  const metricsCache = new Map<string, TMetrics>();
  const cacheKey = spec.cacheKey ?? ((candidate: TCandidate) => JSON.stringify(candidate));

  const evaluateCandidateCached = async (candidate: TCandidate): Promise<TMetrics> => {
    const key = cacheKey(candidate);
    const cached = metricsCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const metrics = await spec.evaluateCandidate(args, candidate, io);
    metricsCache.set(key, metrics);
    return metrics;
  };

  const baselineInput = spec.baselineCandidate(args);
  const baseline = await evaluateCandidateCached(baselineInput);
  io.writer(`[baseline] ${spec.formatMetrics(baseline)}`);

  const symbols: Record<string, ExternalSymbolFn> = {
    [spec.symbolName]: createMetricSymbol({
      baselineInput,
      coerceCandidate: spec.coerceCandidate,
      evaluateCandidate: evaluateCandidateCached,
      pickMetric: spec.pickMetric,
      cache: metricsCache,
      cacheKey,
    }),
  };

  const prompt = spec.buildPrompt(args);
  const planned = await createRLMPlan({
    input: args.goal,
    prompt,
    llm: plannerLLM,
    availableSymbols: [spec.symbolName],
  });
  const plan = spec.normalizePlan(planned, args.goal, args.maxIterations);

  const result = await runPlannedRLM<TCandidate, TState>({
    input: args.goal,
    prompt,
    plannerLLM,
    planOverride: plan,
    symbols,
    longRun: {
      baseline: {
        metrics: baseline,
      },
      initialState: spec.initialState(args),
      maxIterations: args.maxIterations,
      stopWhenNoAccept: spec.stopWhenNoAccept?.(args) ?? true,
      generateCandidates: async (ctx) => {
        const out = selectUntriedCandidates({
          pool,
          rounds: ctx.rounds,
          candidateLimit: args.candidateLimit,
          toInput: spec.toCandidate,
        });
        io.writer(
          `[round ${ctx.iteration}] candidates=${out.map((v) => v.id).join(',') || '(none)'}`,
        );
        return out;
      },
    },
  });

  if (result.mode === 'single') {
    io.writer(`planner selected single mode. final="${result.result.final}"`);
    if (args.outPath !== undefined) {
      await saveReport(args.outPath, result, io);
    }
    return result;
  }

  const rounds = result.result.rounds;
  io.writer(`completed rounds=${rounds.length} accepted=${result.result.acceptedHistory.length}`);
  for (const [roundIndex, round] of rounds.entries()) {
    io.writer(`- round ${roundIndex}`);
    for (const row of round.results) {
      const summary =
        row.snapshot === undefined
          ? 'no-snapshot'
          : spec.formatMetrics(row.snapshot.metrics);
      io.writer(
        `  ${row.candidate.id}: ${row.accepted ? 'accepted' : 'rejected'} ${summary} reasons=${row.reasons.join('|')}`,
      );
    }
  }

  const best = rounds.at(-1)?.bestAccepted;
  if (best !== undefined) {
    io.writer(`best accepted candidate: ${best.candidate.id}`);
  } else {
    io.writer('no accepted candidate');
  }
  io.writer(`final baseline: ${spec.formatMetrics(result.result.finalBaseline.metrics)}`);

  if (args.outPath !== undefined) {
    await saveReport(args.outPath, result, io);
  }

  return result;
};

const saveReport = async (
  outPath: string,
  result: unknown,
  io: LongRunProgramIO,
): Promise<void> => {
  const fullPath = resolve(outPath);
  await writeFile(fullPath, JSON.stringify(result, null, 2), 'utf8');
  io.writer(`saved report: ${fullPath}`);
};
