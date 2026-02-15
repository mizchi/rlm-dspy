import { describe, expect, test } from 'vitest';
import { MockLLMProvider } from '../src/llm/MockLLMProvider.ts';
import { evaluateCases } from '../src/eval/evaluate.ts';
import { parseEvalJSONL } from '../src/eval/jsonl.ts';
import { scoreAnswer } from '../src/eval/scoring.ts';
import type { EvalCase } from '../src/eval/types.ts';

describe('eval utilities', () => {
  test('JSONLを読み込める', () => {
    const input = [
      '# comment',
      '{"id":"a","prompt":"p","query":"q","expected":"x"}',
      '',
      '{"id":"b","prompt":"p2","query":"q2","expected":"y","metric":"contains"}',
    ].join('\n');

    const cases = parseEvalJSONL(input);
    expect(cases).toHaveLength(2);
    expect(cases[0]?.id).toBe('a');
    expect(cases[1]?.metric).toBe('contains');
  });

  test('採点できる', () => {
    expect(scoreAnswer('x', 'x', 'exact')).toBe(true);
    expect(scoreAnswer('x', 'xy', 'exact')).toBe(false);
    expect(scoreAnswer('needle', 'has needle in text', 'contains')).toBe(true);
  });
});

describe('evaluateCases', () => {
  test('baseline と rlm を比較しサマリを返す', async () => {
    const cases: EvalCase[] = [
      {
        id: 'c1',
        prompt: 'alpha\nbeta',
        query: 'beta を返せ',
        expected: 'beta',
      },
      {
        id: 'c2',
        prompt: 'x\ny',
        query: 'x を返せ',
        expected: 'x',
      },
    ];

    const report = await evaluateCases(cases, {
      providerFactory: (mode, evalCase) => {
        if (mode === 'baseline') {
          return new MockLLMProvider({
            scriptsByDepth: { 0: [evalCase.expected] },
          });
        }
        return new MockLLMProvider({
          scriptsByDepth: {
            0: [
              JSON.stringify({ op: 'set', path: 'scratch.answer', value: evalCase.expected }),
              JSON.stringify({ op: 'finalize', from: 'answer' }),
            ],
          },
        });
      },
    });

    expect(report.summary.totalCases).toBe(2);
    expect(report.summary.baseline.correct).toBe(2);
    expect(report.summary.rlm.correct).toBe(2);
    expect(report.results[0]?.rlm.answer).toBe('beta');
  });
});
