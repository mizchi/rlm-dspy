import type { ImprovementCandidate } from './index.ts';
import type { ExternalSymbolFn } from '../rlm/types.ts';

export interface CandidateRoundLike {
  results: Array<{ candidate: { id: string } }>;
}

export interface SelectUntriedCandidatesArgs<TPool, TInput> {
  pool: TPool[];
  rounds: CandidateRoundLike[];
  candidateLimit: number;
  toInput: (entry: TPool) => ImprovementCandidate<TInput>;
}

export const selectUntriedCandidates = <TPool, TInput>(
  args: SelectUntriedCandidatesArgs<TPool, TInput>,
): ImprovementCandidate<TInput>[] => {
  const tried = new Set<string>();
  for (const round of args.rounds) {
    for (const row of round.results) {
      tried.add(row.candidate.id);
    }
  }

  const out: ImprovementCandidate<TInput>[] = [];
  for (const entry of args.pool) {
    const candidate = args.toInput(entry);
    if (tried.has(candidate.id)) {
      continue;
    }
    out.push(candidate);
    if (out.length >= args.candidateLimit) {
      break;
    }
  }
  return out;
};

export interface CreateMetricSymbolArgs<TCandidate, TMetrics extends Record<string, number>> {
  baselineInput: TCandidate;
  coerceCandidate: (input: unknown) => TCandidate;
  evaluateCandidate: (candidate: TCandidate) => Promise<TMetrics>;
  pickMetric: (metrics: TMetrics, key: string) => number;
  cache?: Map<string, TMetrics>;
  cacheKey?: (candidate: TCandidate) => string;
}

export const createMetricSymbol = <TCandidate, TMetrics extends Record<string, number>>(
  args: CreateMetricSymbolArgs<TCandidate, TMetrics>,
): ExternalSymbolFn => {
  return async (call) => {
    const argsRow = asRecord(call.args);
    const metricKey = asString(argsRow.metricKey, 'metricKey');
    const candidate = args.coerceCandidate(
      argsRow.candidate ?? call.input ?? args.baselineInput,
    );

    const keyFn = args.cacheKey ?? ((v: TCandidate) => JSON.stringify(v));
    const key = keyFn(candidate);
    const cached = args.cache?.get(key);
    if (cached !== undefined) {
      return args.pickMetric(cached, metricKey);
    }

    const metrics = await args.evaluateCandidate(candidate);
    args.cache?.set(key, metrics);
    return args.pickMetric(metrics, metricKey);
  };
};

const asRecord = (input: unknown): Record<string, unknown> => {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
};

const asString = (input: unknown, label: string): string => {
  if (typeof input === 'string' && input !== '') {
    return input;
  }
  throw new Error(`${label} must be string`);
};
