import { describe, expect, test } from 'vitest';
import type { RLMPlannerPlan } from '../src/planner/index.ts';
import { runLongRunProgram } from '../src/improve/program.ts';

interface Args {
  plannerProvider: 'mock' | 'openai';
  model: string;
  goal: string;
  maxIterations: number;
  candidateLimit: number;
  outPath?: string;
}

interface Candidate {
  id: string;
  score: number;
}

describe('runLongRunProgram', () => {
  test('mock planner で long-run を実行し、改善候補を受理できる', async () => {
    const logs: string[] = [];
    const spec = {
      symbolName: 'metric_score',
      parseArgs: (): Args => ({
        plannerProvider: 'mock',
        model: 'gpt-4.1-mini',
        goal: 'minimize score',
        maxIterations: 1,
        candidateLimit: 2,
      }),
      createMockPlan: (goal: string, maxIterations: number): RLMPlannerPlan => ({
        kind: 'rlm_plan',
        version: 1,
        mode: 'long_run',
        task: goal,
        symbols: ['metric_score'],
        longRun: {
          objectives: [
            {
              key: 'score',
              direction: 'minimize',
              symbol: 'metric_score',
            },
          ],
          maxIterations,
          stopWhenNoAccept: true,
          minScoreDelta: 0.1,
        },
      }),
      normalizePlan: (plan: RLMPlannerPlan) => plan,
      buildPrompt: () => 'dummy prompt',
      loadPool: async () =>
        [
          { id: 'better', score: 5 },
          { id: 'worse', score: 20 },
        ] satisfies Candidate[],
      toCandidate: (row: Candidate) => ({
        id: row.id,
        input: row,
      }),
      baselineCandidate: () =>
        ({
          id: 'baseline',
          score: 10,
        }) satisfies Candidate,
      coerceCandidate: (input: unknown): Candidate => {
        if (typeof input === 'object' && input !== null) {
          const row = input as { id?: string; score?: number };
          return {
            id: typeof row.id === 'string' ? row.id : 'unknown',
            score: typeof row.score === 'number' ? row.score : 0,
          };
        }
        return {
          id: 'unknown',
          score: 0,
        };
      },
      evaluateCandidate: async (_args: Args, candidate: Candidate) => ({
        score: candidate.score,
      }),
      pickMetric: (metrics: { score: number }, key: string) =>
        key === 'score' ? metrics.score : Number.NaN,
      initialState: () => ({}),
      formatBaseline: (metrics: { score: number }) => `score=${metrics.score}`,
      formatMetrics: (metrics: Record<string, number>) => `score=${metrics.score}`,
    } as const;

    const out = await runLongRunProgram(spec, [], {
      writer: (line) => logs.push(line),
      errorWriter: (line) => logs.push(`ERR:${line}`),
    });

    expect(out.mode).toBe('long_run');
    if (out.mode !== 'long_run') {
      return;
    }
    expect(out.result.acceptedHistory.length).toBeGreaterThan(0);
    expect(out.result.finalBaseline.metrics.score).toBe(5);
    expect(logs.some((line) => line.includes('best accepted candidate: better'))).toBe(true);
  });
});
