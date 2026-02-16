import { describe, expect, test } from 'vitest';
import {
  createMetricSymbol,
  selectUntriedCandidates,
} from '../src/improve/harness.ts';

describe('longrun harness helpers', () => {
  test('selectUntriedCandidates は既試行IDを除いて先頭から返す', () => {
    const out = selectUntriedCandidates({
      pool: [
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
        { id: 'c', value: 3 },
      ],
      rounds: [
        {
          results: [{ candidate: { id: 'a' } }],
        },
      ],
      candidateLimit: 2,
      toInput: (row) => ({ id: row.id, input: { value: row.value } }),
    });

    expect(out.map((row) => row.id)).toEqual(['b', 'c']);
  });

  test('selectUntriedCandidates は candidateLimit が0以下なら空配列を返す', () => {
    const out = selectUntriedCandidates({
      pool: [{ id: 'a', value: 1 }],
      rounds: [],
      candidateLimit: 0,
      toInput: (row) => ({ id: row.id, input: { value: row.value } }),
    });

    expect(out).toEqual([]);
  });

  test('createMetricSymbol は candidate を評価して metricKey を返す', async () => {
    const symbol = createMetricSymbol({
      baselineInput: { id: 'baseline', score: 10 },
      coerceCandidate: (input) => {
        if (typeof input === 'object' && input !== null) {
          const row = input as { id?: string; score?: number };
          return {
            id: typeof row.id === 'string' ? row.id : 'unknown',
            score: typeof row.score === 'number' ? row.score : 0,
          };
        }
        return { id: 'unknown', score: 0 };
      },
      evaluateCandidate: async (candidate) => ({
        score: candidate.score,
        inverse: candidate.score === 0 ? Number.POSITIVE_INFINITY : 1 / candidate.score,
      }),
      pickMetric: (metrics, key) => metrics[key as keyof typeof metrics] ?? Number.NaN,
    });

    const value = await symbol({
      symbol: 'metric_test',
      prompt: 'p',
      promptId: 'pid',
      depth: 0,
      scratch: {},
      args: {
        metricKey: 'score',
        candidate: { id: 'x', score: 42 },
      },
      input: null,
    });
    expect(value).toBe(42);
  });

  test('createMetricSymbol は同一candidateをキャッシュできる', async () => {
    let calls = 0;
    const symbol = createMetricSymbol({
      baselineInput: { id: 'baseline', score: 1 },
      coerceCandidate: (input) => {
        if (typeof input === 'object' && input !== null) {
          const row = input as { id?: string; score?: number };
          return {
            id: typeof row.id === 'string' ? row.id : 'unknown',
            score: typeof row.score === 'number' ? row.score : 0,
          };
        }
        return { id: 'unknown', score: 0 };
      },
      evaluateCandidate: async (candidate) => {
        calls += 1;
        return { score: candidate.score };
      },
      pickMetric: (metrics, key) => metrics[key as keyof typeof metrics] ?? Number.NaN,
      cache: new Map<string, { score: number }>(),
      cacheKey: (candidate) => candidate.id,
    });

    const call = {
      symbol: 'metric_test',
      prompt: 'p',
      promptId: 'pid',
      depth: 0,
      scratch: {},
      args: { metricKey: 'score', candidate: { id: 'x', score: 1 } },
      input: null,
    } as const;

    await symbol(call);
    await symbol(call);
    expect(calls).toBe(1);
  });
});
