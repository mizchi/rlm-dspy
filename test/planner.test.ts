import { describe, expect, test } from 'vitest';
import { MockLLMProvider } from '../src/llm/MockLLMProvider.ts';
import {
  createRLMPlan,
  runPlannedRLM,
  type RLMPlannerPlan,
} from '../src/planner/index.ts';

const dsl = (v: unknown): string => JSON.stringify(v);

describe('planner', () => {
  test('LLM出力から RLM planner plan を生成できる', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          JSON.stringify({
            mode: 'single',
            task: 'score を合計して返す',
            profile: 'hybrid',
            symbols: ['github_open_issues'],
            budget: { maxSteps: 10 },
          }),
        ],
      },
    });

    const plan = await createRLMPlan({
      input: 'CSVのscore列を合計して',
      prompt: 'name,score\nalice,3\nbob,5',
      llm,
      availableSymbols: ['github_open_issues'],
    });

    expect(plan.mode).toBe('single');
    expect(plan.task).toBe('score を合計して返す');
    expect(plan.budget?.maxSteps).toBe(10);
    expect(plan.symbols).toEqual(['github_open_issues']);
  });

  test('plan mode=single なら runRLM 実行サイクルに入れる', async () => {
    const plannerLLM = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          JSON.stringify({
            mode: 'single',
            task: 'Issue数を返す',
            profile: 'pure',
            symbols: ['github_open_issues'],
          }),
        ],
      },
    });
    const executorLLM = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'call_symbol', symbol: 'github_open_issues', out: 'issues' }),
          dsl({ op: 'finalize', from: 'issues' }),
        ],
      },
    });

    const out = await runPlannedRLM({
      input: 'GitHub issue数を返す',
      prompt: 'ignored',
      plannerLLM,
      executorLLM,
      symbols: {
        github_open_issues: async () => 42,
      },
    });

    expect(out.mode).toBe('single');
    if (out.mode === 'single') {
      expect(out.result.final).toBe('42');
    }
  });

  test('plan mode=long_run で候補反復ループを実行できる', async () => {
    const plannerLLM = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          JSON.stringify({
            mode: 'long_run',
            task: 'open issue を減らす',
            longRun: {
              objectives: [
                { key: 'openIssues', direction: 'minimize', symbol: 'metric_open_issues' },
              ],
              maxIterations: 2,
              minScoreDelta: 1,
              stopWhenNoAccept: true,
            },
          }),
        ],
      },
    });

    const result = await runPlannedRLM<{ openIssues: number }, { repo: string }>({
      input: 'open issue を減らしたい',
      prompt: 'ignored',
      plannerLLM,
      symbols: {
        metric_open_issues: async (ctx) => {
          const candidate = (ctx.args as { candidate?: { openIssues?: number } }).candidate;
          if (candidate?.openIssues !== undefined) {
            return candidate.openIssues;
          }
          return 100;
        },
      },
      longRun: {
        baseline: { metrics: { openIssues: 100 } },
        initialState: { repo: 'mizchi/rlm-dspy' },
        generateCandidates: async ({ iteration }) =>
          iteration === 0
            ? [{ id: 'a', input: { openIssues: 95 } }]
            : [{ id: 'b', input: { openIssues: 96 } }],
      },
    });

    expect(result.mode).toBe('long_run');
    if (result.mode === 'long_run') {
      expect(result.result.finalBaseline.metrics.openIssues).toBe(95);
      expect(result.result.rounds).toHaveLength(2);
    }
  });

  test('plan JSON が壊れていても最低限の single plan にフォールバックできる', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [JSON.stringify({ foo: 'bar' })],
      },
    });
    const plan = await createRLMPlan({
      input: '入力をそのまま処理',
      prompt: 'prompt',
      llm,
    });

    expect(plan.mode).toBe('single');
    expect(plan.task).toBe('入力をそのまま処理');
  });
});
