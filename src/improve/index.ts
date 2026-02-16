export type MetricDirection = 'maximize' | 'minimize';
export type MetricComparator = 'lt' | 'lte' | 'gt' | 'gte' | 'eq';

export interface ImprovementObjective {
  key: string;
  direction: MetricDirection;
  weight?: number;
}

export interface ImprovementConstraint {
  key: string;
  comparator: MetricComparator;
  value: number;
  source?: 'absolute' | 'delta' | 'ratio' | 'delta_ratio';
}

export interface ImprovementPolicy {
  objectives: ImprovementObjective[];
  constraints?: ImprovementConstraint[];
  minScoreDelta?: number;
}

export interface MetricSnapshot {
  metrics: Record<string, number>;
  gates?: Record<string, boolean>;
  meta?: Record<string, unknown>;
}

export interface ImprovementCandidate<T = unknown> {
  id: string;
  input: T;
}

export interface ImprovementContext<T = unknown> {
  baseline: MetricSnapshot;
  baselineScore: number;
  accepted: ImprovementResult<T>[];
  index: number;
}

export interface ImprovementResult<T = unknown> {
  candidate: ImprovementCandidate<T>;
  accepted: boolean;
  reasons: string[];
  snapshot?: MetricSnapshot;
  score?: number;
  scoreDelta?: number;
  error?: string;
}

export interface ImprovementReport<T = unknown> {
  policy: ImprovementPolicy;
  baseline: MetricSnapshot;
  baselineScore: number;
  results: ImprovementResult<T>[];
  bestAccepted?: ImprovementResult<T>;
}

export interface RunImprovementLoopArgs<T = unknown> {
  baseline: MetricSnapshot;
  candidates: ImprovementCandidate<T>[];
  policy: ImprovementPolicy;
  evaluate: (
    candidate: ImprovementCandidate<T>,
    context: ImprovementContext<T>,
  ) => Promise<MetricSnapshot>;
  updateBaselineOnAccept?: boolean;
}

export const scoreSnapshot = (
  snapshot: MetricSnapshot,
  policy: ImprovementPolicy,
): number => {
  validatePolicy(policy);

  let score = 0;
  for (const objective of policy.objectives) {
    const raw = snapshot.metrics[objective.key];
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`metric_missing:${objective.key}`);
    }
    const weight = objective.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`invalid_weight:${objective.key}`);
    }
    const oriented = objective.direction === 'maximize' ? value : -value;
    score += oriented * weight;
  }
  return score;
};

export const runImprovementLoop = async <T>(
  args: RunImprovementLoopArgs<T>,
): Promise<ImprovementReport<T>> => {
  const policy = args.policy;
  validatePolicy(policy);

  const baseScore = scoreSnapshot(args.baseline, policy);
  let currentBaseline = args.baseline;
  let currentBaselineScore = baseScore;

  const results: ImprovementResult<T>[] = [];
  const acceptedResults: ImprovementResult<T>[] = [];

  for (let i = 0; i < args.candidates.length; i += 1) {
    const candidate = args.candidates[i];
    if (candidate === undefined) {
      continue;
    }

    try {
      const snapshot = await args.evaluate(candidate, {
        baseline: currentBaseline,
        baselineScore: currentBaselineScore,
        accepted: acceptedResults,
        index: i,
      });

      const reasons = validateSnapshot(snapshot, policy, currentBaseline);
      const score =
        reasons.includes('invalid_snapshot') || hasMissingMetricReason(reasons)
          ? undefined
          : scoreSnapshot(snapshot, policy);
      const scoreDelta =
        score === undefined ? undefined : score - currentBaselineScore;

      const minScoreDelta = policy.minScoreDelta ?? 0;
      if (scoreDelta !== undefined && scoreDelta < minScoreDelta) {
        reasons.push('score_delta_too_small');
      }

      const accepted = reasons.length === 0;
      const result: ImprovementResult<T> = {
        candidate,
        accepted,
        reasons,
        snapshot,
        ...(score !== undefined ? { score } : {}),
        ...(scoreDelta !== undefined ? { scoreDelta } : {}),
      };
      results.push(result);

      if (accepted) {
        acceptedResults.push(result);
        if (args.updateBaselineOnAccept) {
          currentBaseline = snapshot;
          currentBaselineScore = score ?? currentBaselineScore;
        }
      }
    } catch (cause) {
      const error = (cause as Error).message;
      results.push({
        candidate,
        accepted: false,
        reasons: ['evaluation_error'],
        error,
      });
    }
  }

  const bestAccepted = pickBestAccepted(results);
  const report: ImprovementReport<T> = {
    policy,
    baseline: args.baseline,
    baselineScore: baseScore,
    results,
  };
  if (bestAccepted !== undefined) {
    report.bestAccepted = bestAccepted;
  }
  return report;
};

const validatePolicy = (policy: ImprovementPolicy): void => {
  if (!Array.isArray(policy.objectives) || policy.objectives.length === 0) {
    throw new Error('policy.objectives must be non-empty');
  }
  for (const objective of policy.objectives) {
    if (objective.direction !== 'maximize' && objective.direction !== 'minimize') {
      throw new Error(`invalid_direction:${objective.key}`);
    }
  }
};

const validateSnapshot = (
  snapshot: MetricSnapshot,
  policy: ImprovementPolicy,
  baseline: MetricSnapshot,
): string[] => {
  const reasons: string[] = [];
  let invalid = false;

  for (const [key, value] of Object.entries(snapshot.metrics)) {
    if (!Number.isFinite(value)) {
      invalid = true;
      reasons.push(`invalid_metric:${key}`);
    }
  }

  for (const objective of policy.objectives) {
    if (!Number.isFinite(snapshot.metrics[objective.key])) {
      invalid = true;
      reasons.push(`metric_missing:${objective.key}`);
    }
  }

  for (const constraint of policy.constraints ?? []) {
    const metric = snapshot.metrics[constraint.key];
    if (metric === undefined || !Number.isFinite(metric)) {
      invalid = true;
      reasons.push(`metric_missing:${constraint.key}`);
      continue;
    }
    const baselineMetric = baseline.metrics[constraint.key];
    const baselineValue =
      typeof baselineMetric === 'number' && Number.isFinite(baselineMetric)
        ? baselineMetric
        : 0;
    const target = toConstraintTarget({
      source: constraint.source ?? 'absolute',
      metric,
      baseline: baselineValue,
    });
    if (!Number.isFinite(target)) {
      invalid = true;
      reasons.push(`invalid_constraint_source:${constraint.key}`);
      continue;
    }
    if (!compareMetric(target, constraint.comparator, constraint.value)) {
      reasons.push(`constraint_failed:${constraint.key}`);
    }
  }

  for (const [gate, passed] of Object.entries(snapshot.gates ?? {})) {
    if (!passed) {
      reasons.push(`gate_failed:${gate}`);
    }
  }

  if (invalid) {
    reasons.unshift('invalid_snapshot');
  }
  return dedupeReasons(reasons);
};

const compareMetric = (
  value: number,
  comparator: MetricComparator,
  expected: number,
): boolean => {
  switch (comparator) {
    case 'lt':
      return value < expected;
    case 'lte':
      return value <= expected;
    case 'gt':
      return value > expected;
    case 'gte':
      return value >= expected;
    case 'eq':
      return value === expected;
    default: {
      const never: never = comparator;
      throw new Error(`unreachable comparator: ${String(never)}`);
    }
  }
};

const dedupeReasons = (reasons: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const reason of reasons) {
    if (seen.has(reason)) {
      continue;
    }
    seen.add(reason);
    out.push(reason);
  }
  return out;
};

const toConstraintTarget = (args: {
  source: NonNullable<ImprovementConstraint['source']>;
  metric: number;
  baseline: number;
}): number => {
  switch (args.source) {
    case 'absolute':
      return args.metric;
    case 'delta':
      return args.metric - args.baseline;
    case 'ratio':
      return args.baseline === 0 ? Number.NaN : args.metric / args.baseline;
    case 'delta_ratio':
      return args.baseline === 0
        ? Number.NaN
        : (args.metric - args.baseline) / args.baseline;
    default: {
      const never: never = args.source;
      throw new Error(`unreachable source: ${String(never)}`);
    }
  }
};

const hasMissingMetricReason = (reasons: string[]): boolean =>
  reasons.some(
    (reason) => reason === 'invalid_snapshot' || reason.startsWith('metric_missing:'),
  );

const pickBestAccepted = <T>(
  results: ImprovementResult<T>[],
): ImprovementResult<T> | undefined => {
  let best: ImprovementResult<T> | undefined;
  for (const result of results) {
    if (!result.accepted || result.score === undefined) {
      continue;
    }
    if (best === undefined || (best.score !== undefined && result.score > best.score)) {
      best = result;
    }
  }
  return best;
};
