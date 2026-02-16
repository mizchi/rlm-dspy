import { describe, expect, test } from 'vitest';
import type { ImprovementCandidate, MetricSnapshot } from '../src/improve/index.ts';
import {
  buildPolicyFromMetricSymbols,
  collectMetricSnapshotBySymbols,
  runLongImprovementLoop,
  type ConstraintMetricSymbol,
  type ObjectiveMetricSymbol,
} from '../src/improve/longRun.ts';

describe('longRun improvement', () => {
  test('外部注入シンボルから metric snapshot を収集できる', async () => {
    const candidate: ImprovementCandidate<{ open: number; closed: number }> = {
      id: 'c1',
      input: { open: 120, closed: 30 },
    };

    const objectives: ObjectiveMetricSymbol<{ open: number; closed: number }, { repo: string }>[] = [
      {
        key: 'openIssues',
        direction: 'minimize',
        read: ({ candidate: row }) => row.input.open,
      },
      {
        key: 'closedIssues',
        direction: 'maximize',
        weight: 0.2,
        read: ({ candidate: row }) => row.input.closed,
      },
    ];
    const constraints: ConstraintMetricSymbol<
      { open: number; closed: number },
      { repo: string }
    >[] = [
      {
        key: 'failedChecks',
        comparator: 'eq',
        value: 0,
        read: async () => 0,
      },
    ];

    const snapshot = await collectMetricSnapshotBySymbols({
      candidate,
      iteration: 0,
      state: { repo: 'mizchi/rlm-dspy' },
      objectives,
      constraints,
    });

    expect(snapshot.metrics).toEqual({
      openIssues: 120,
      closedIssues: 30,
      failedChecks: 0,
    });
  });

  test('長時間ランで accepted 候補を基準線として更新できる', async () => {
    const objectives: ObjectiveMetricSymbol<{ openIssues: number }, { repo: string }>[] = [
      {
        key: 'openIssues',
        direction: 'minimize',
        read: ({ candidate }) => candidate.input.openIssues,
      },
    ];
    const policy = buildPolicyFromMetricSymbols({
      objectives,
      minScoreDelta: 1,
    });
    const baseline: MetricSnapshot = {
      metrics: {
        openIssues: 100,
      },
    };

    const report = await runLongImprovementLoop<{ openIssues: number }, { repo: string }>({
      baseline,
      policy,
      initialState: { repo: 'mizchi/rlm-dspy' },
      maxIterations: 3,
      stopWhenNoAccept: true,
      generateCandidates: async ({ iteration }) =>
        iteration === 0
          ? [
              { id: 'a', input: { openIssues: 95 } },
              { id: 'b', input: { openIssues: 90 } },
            ]
          : [{ id: 'c', input: { openIssues: 92 } }],
      evaluate: async (candidate, context) =>
        collectMetricSnapshotBySymbols({
          candidate,
          iteration: context.iteration,
          state: context.state,
          objectives,
        }),
    });

    expect(report.rounds).toHaveLength(2);
    expect(report.acceptedHistory.map((row) => row.candidate.id)).toEqual(['a', 'b']);
    expect(report.finalBaseline.metrics.openIssues).toBe(90);
  });
});
