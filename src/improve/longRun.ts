import {
  runImprovementLoop,
  scoreSnapshot,
  type ImprovementCandidate,
  type ImprovementConstraint,
  type ImprovementPolicy,
  type ImprovementReport,
  type ImprovementResult,
  type MetricSnapshot,
} from './index.ts';

export interface ObjectiveMetricSymbol<TCandidate = unknown, TState = unknown> {
  key: string;
  direction: 'maximize' | 'minimize';
  weight?: number;
  read: (input: {
    candidate: ImprovementCandidate<TCandidate>;
    iteration: number;
    state: TState;
  }) => Promise<number> | number;
}

export interface ConstraintMetricSymbol<TCandidate = unknown, TState = unknown> {
  key: string;
  comparator: ImprovementConstraint['comparator'];
  value: number;
  source?: ImprovementConstraint['source'];
  read: (input: {
    candidate: ImprovementCandidate<TCandidate>;
    iteration: number;
    state: TState;
  }) => Promise<number> | number;
}

export interface BuildPolicyFromMetricSymbolsArgs<
  TCandidate = unknown,
  TState = unknown,
> {
  objectives: ObjectiveMetricSymbol<TCandidate, TState>[];
  constraints?: ConstraintMetricSymbol<TCandidate, TState>[];
  minScoreDelta?: number;
}

export interface CollectMetricSnapshotBySymbolsArgs<
  TCandidate = unknown,
  TState = unknown,
> {
  candidate: ImprovementCandidate<TCandidate>;
  iteration: number;
  state: TState;
  objectives: ObjectiveMetricSymbol<TCandidate, TState>[];
  constraints?: ConstraintMetricSymbol<TCandidate, TState>[];
}

export interface LongRunIterationContext<TCandidate = unknown, TState = unknown> {
  iteration: number;
  state: TState;
  baseline: MetricSnapshot;
  baselineScore: number;
  rounds: ImprovementReport<TCandidate>[];
  acceptedHistory: ImprovementResult<TCandidate>[];
}

export interface RunLongImprovementLoopArgs<TCandidate = unknown, TState = unknown> {
  baseline: MetricSnapshot;
  policy: ImprovementPolicy;
  initialState: TState;
  maxIterations: number;
  stopWhenNoAccept?: boolean;
  generateCandidates: (
    context: LongRunIterationContext<TCandidate, TState>,
  ) => Promise<ImprovementCandidate<TCandidate>[]>;
  evaluate: (
    candidate: ImprovementCandidate<TCandidate>,
    context: LongRunIterationContext<TCandidate, TState>,
  ) => Promise<MetricSnapshot>;
  onAccepted?: (
    accepted: ImprovementResult<TCandidate>,
    context: LongRunIterationContext<TCandidate, TState>,
  ) => Promise<TState> | TState;
}

export interface LongRunImprovementReport<TCandidate = unknown, TState = unknown> {
  rounds: ImprovementReport<TCandidate>[];
  acceptedHistory: ImprovementResult<TCandidate>[];
  finalBaseline: MetricSnapshot;
  finalBaselineScore: number;
  finalState: TState;
}

export const buildPolicyFromMetricSymbols = <
  TCandidate = unknown,
  TState = unknown,
>(
  args: BuildPolicyFromMetricSymbolsArgs<TCandidate, TState>,
): ImprovementPolicy => ({
  objectives: args.objectives.map((row) => ({
    key: row.key,
    direction: row.direction,
    ...(row.weight !== undefined ? { weight: row.weight } : {}),
  })),
  ...(args.constraints !== undefined
    ? {
        constraints: args.constraints.map((row) => ({
          key: row.key,
          comparator: row.comparator,
          value: row.value,
          ...(row.source !== undefined ? { source: row.source } : {}),
        })),
      }
    : {}),
  ...(args.minScoreDelta !== undefined
    ? { minScoreDelta: args.minScoreDelta }
    : {}),
});

export const collectMetricSnapshotBySymbols = async <
  TCandidate = unknown,
  TState = unknown,
>(
  args: CollectMetricSnapshotBySymbolsArgs<TCandidate, TState>,
): Promise<MetricSnapshot> => {
  const metrics: Record<string, number> = {};

  for (const objective of args.objectives) {
    metrics[objective.key] = await objective.read({
      candidate: args.candidate,
      iteration: args.iteration,
      state: args.state,
    });
  }
  for (const constraint of args.constraints ?? []) {
    metrics[constraint.key] = await constraint.read({
      candidate: args.candidate,
      iteration: args.iteration,
      state: args.state,
    });
  }

  return { metrics };
};

export const runLongImprovementLoop = async <
  TCandidate = unknown,
  TState = unknown,
>(
  args: RunLongImprovementLoopArgs<TCandidate, TState>,
): Promise<LongRunImprovementReport<TCandidate, TState>> => {
  let baseline = args.baseline;
  let baselineScore = scoreSnapshot(baseline, args.policy);
  let state = args.initialState;
  const rounds: ImprovementReport<TCandidate>[] = [];
  const acceptedHistory: ImprovementResult<TCandidate>[] = [];

  const maxIterations = Math.max(0, Math.floor(args.maxIterations));
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const context: LongRunIterationContext<TCandidate, TState> = {
      iteration,
      state,
      baseline,
      baselineScore,
      rounds,
      acceptedHistory,
    };
    const candidates = await args.generateCandidates(context);
    if (candidates.length === 0) {
      break;
    }

    const round = await runImprovementLoop({
      baseline,
      policy: args.policy,
      candidates,
      evaluate: async (candidate) => args.evaluate(candidate, context),
    });
    rounds.push(round);

    const acceptedThisRound = round.results.filter((row) => row.accepted);
    acceptedHistory.push(...acceptedThisRound);

    const best = round.bestAccepted;
    if (best !== undefined && best.snapshot !== undefined) {
      baseline = best.snapshot;
      baselineScore =
        best.score ?? scoreSnapshot(best.snapshot, args.policy);
      if (args.onAccepted !== undefined) {
        state = await args.onAccepted(best, context);
      }
      continue;
    }

    if (args.stopWhenNoAccept) {
      break;
    }
  }

  return {
    rounds,
    acceptedHistory,
    finalBaseline: baseline,
    finalBaselineScore: baselineScore,
    finalState: state,
  };
};
