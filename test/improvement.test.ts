import { describe, expect, test } from 'vitest';
import {
  runImprovementLoop,
  scoreSnapshot,
  type ImprovementCandidate,
  type ImprovementPolicy,
  type MetricSnapshot,
} from '../src/improve/index.ts';

describe('scoreSnapshot', () => {
  test('minimize / maximize の重み付きスコアを計算できる', () => {
    const policy: ImprovementPolicy = {
      objectives: [
        { key: 'latencyMs', direction: 'minimize', weight: 1 },
        { key: 'throughput', direction: 'maximize', weight: 0.5 },
      ],
    };
    const snapshot: MetricSnapshot = {
      metrics: {
        latencyMs: 120,
        throughput: 40,
      },
    };

    expect(scoreSnapshot(snapshot, policy)).toBe(-100);
  });
});

describe('runImprovementLoop', () => {
  test('実指標で候補を評価し、制約を満たす最良候補を選べる', async () => {
    const policy: ImprovementPolicy = {
      objectives: [
        { key: 'latencyP95', direction: 'minimize', weight: 1 },
        { key: 'throughput', direction: 'maximize', weight: 0.2 },
      ],
      constraints: [
        { key: 'testFailures', comparator: 'eq', value: 0 },
        { key: 'throughput', comparator: 'gte', value: 80 },
      ],
      minScoreDelta: 1,
    };
    const baseline: MetricSnapshot = {
      metrics: {
        latencyP95: 120,
        throughput: 100,
        testFailures: 0,
      },
    };

    const candidates: ImprovementCandidate<string>[] = [
      { id: 'cand-a', input: 'A' },
      { id: 'cand-b', input: 'B' },
      { id: 'cand-c', input: 'C' },
    ];

    const report = await runImprovementLoop({
      baseline,
      candidates,
      policy,
      evaluate: async (candidate) => {
        if (candidate.id === 'cand-a') {
          return {
            metrics: {
              latencyP95: 100,
              throughput: 105,
              testFailures: 0,
            },
          };
        }
        if (candidate.id === 'cand-b') {
          return {
            metrics: {
              latencyP95: 90,
              throughput: 70,
              testFailures: 0,
            },
          };
        }
        return {
          metrics: {
            latencyP95: 118,
            throughput: 101,
            testFailures: 0,
          },
        };
      },
    });

    expect(report.results).toHaveLength(3);
    expect(report.results[0]?.accepted).toBe(true);
    expect(report.results[1]?.accepted).toBe(false);
    expect(report.results[1]?.reasons).toContain('constraint_failed:throughput');
    expect(report.bestAccepted?.candidate.id).toBe('cand-a');
  });

  test('lint修正のような品質ゲート重視タスクを一般化できる', async () => {
    const policy: ImprovementPolicy = {
      objectives: [{ key: 'lintErrors', direction: 'minimize' }],
      constraints: [{ key: 'testFailures', comparator: 'eq', value: 0 }],
      minScoreDelta: 1,
    };
    const baseline: MetricSnapshot = {
      metrics: {
        lintErrors: 120,
        testFailures: 0,
      },
    };
    const candidates: ImprovementCandidate<string>[] = [
      { id: 'broken-fix', input: 'X' },
      { id: 'clean-fix', input: 'Y' },
    ];

    const report = await runImprovementLoop({
      baseline,
      candidates,
      policy,
      evaluate: async (candidate) =>
        candidate.id === 'broken-fix'
          ? {
              metrics: {
                lintErrors: 0,
                testFailures: 2,
              },
            }
          : {
              metrics: {
                lintErrors: 0,
                testFailures: 0,
              },
            },
    });

    expect(report.results[0]?.accepted).toBe(false);
    expect(report.results[1]?.accepted).toBe(true);
    expect(report.bestAccepted?.candidate.id).toBe('clean-fix');
  });

  test('accepted候補を新しい基準線に更新できる', async () => {
    const policy: ImprovementPolicy = {
      objectives: [{ key: 'throughput', direction: 'maximize' }],
      minScoreDelta: 1,
    };
    const baseline: MetricSnapshot = {
      metrics: {
        throughput: 100,
      },
    };
    const candidates: ImprovementCandidate<string>[] = [
      { id: 'c1', input: '1' },
      { id: 'c2', input: '2' },
    ];

    const report = await runImprovementLoop({
      baseline,
      candidates,
      policy,
      updateBaselineOnAccept: true,
      evaluate: async (candidate) =>
        candidate.id === 'c1'
          ? { metrics: { throughput: 103 } }
          : { metrics: { throughput: 102 } },
    });

    expect(report.results[0]?.accepted).toBe(true);
    expect(report.results[1]?.accepted).toBe(false);
    expect(report.results[1]?.reasons).toContain('score_delta_too_small');
  });

  test('候補評価で例外が出てもループ全体は継続する', async () => {
    const policy: ImprovementPolicy = {
      objectives: [{ key: 'latencyMs', direction: 'minimize' }],
    };
    const baseline: MetricSnapshot = {
      metrics: {
        latencyMs: 100,
      },
    };
    const candidates: ImprovementCandidate<string>[] = [
      { id: 'ok', input: 'ok' },
      { id: 'boom', input: 'boom' },
    ];

    const report = await runImprovementLoop({
      baseline,
      candidates,
      policy,
      evaluate: async (candidate) => {
        if (candidate.id === 'boom') {
          throw new Error('failed to run benchmark');
        }
        return { metrics: { latencyMs: 90 } };
      },
    });

    expect(report.results[0]?.accepted).toBe(true);
    expect(report.results[1]?.accepted).toBe(false);
    expect(report.results[1]?.error).toContain('failed to run benchmark');
    expect(report.results[1]?.reasons).toContain('evaluation_error');
  });
});
