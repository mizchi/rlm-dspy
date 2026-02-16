import { describe, expect, test } from 'vitest';
import {
  extractESLintSummary,
  makeDefaultLintCandidates,
  makeDefaultLintLongRunPlan,
  normalizeLintPlan,
  sanitizeCandidateId,
} from '../src/integrations/lint.ts';

describe('lint integration helpers', () => {
  test('eslint JSON 配列から summary を抽出できる', () => {
    const summary = extractESLintSummary([
      {
        filePath: '/tmp/a.ts',
        errorCount: 2,
        warningCount: 1,
        fixableErrorCount: 1,
        fixableWarningCount: 1,
      },
      {
        filePath: '/tmp/b.ts',
        errorCount: 0,
        warningCount: 3,
        fixableErrorCount: 0,
        fixableWarningCount: 2,
      },
    ]);

    expect(summary).toEqual({
      lintErrors: 2,
      lintWarnings: 4,
      fixableErrors: 1,
      fixableWarnings: 3,
      filesWithProblems: 2,
    });
  });

  test('object.results 形式も抽出できる', () => {
    const summary = extractESLintSummary({
      results: [
        {
          errorCount: 0,
          warningCount: 0,
          fixableErrorCount: 0,
          fixableWarningCount: 0,
        },
      ],
    });

    expect(summary.lintErrors).toBe(0);
    expect(summary.lintWarnings).toBe(0);
    expect(summary.filesWithProblems).toBe(0);
  });

  test('invalid json は例外になる', () => {
    expect(() => extractESLintSummary({})).toThrowError(
      /eslint json must be array or object with results\[\]/,
    );
  });

  test('single plan は lint long_run plan に補正される', () => {
    const normalized = normalizeLintPlan(
      {
        kind: 'rlm_plan',
        version: 1,
        mode: 'single',
        task: 'lint を改善したい',
      },
      'lint を改善したい',
      4,
      'metric_lint',
    );

    expect(normalized.mode).toBe('long_run');
    expect(normalized.longRun?.objectives.length).toBeGreaterThan(0);
    expect(normalized.longRun?.maxIterations).toBe(4);
    expect(normalized.symbols).toEqual(['metric_lint']);
  });

  test('unsupported objective だけの場合は default に戻る', () => {
    const normalized = normalizeLintPlan(
      {
        kind: 'rlm_plan',
        version: 1,
        mode: 'long_run',
        task: 'lint',
        longRun: {
          objectives: [
            {
              key: 'unknown',
              direction: 'minimize',
              symbol: 'metric_lint',
            },
          ],
        },
      },
      'lint',
      2,
      'metric_lint',
    );

    const fallback = makeDefaultLintLongRunPlan('lint', 2, 'metric_lint');
    expect(normalized.longRun?.objectives).toEqual(fallback.longRun?.objectives);
  });

  test('不足している guard 制約は補完される', () => {
    const normalized = normalizeLintPlan(
      {
        kind: 'rlm_plan',
        version: 1,
        mode: 'long_run',
        task: 'lint',
        longRun: {
          objectives: [
            {
              key: 'lintErrors',
              direction: 'minimize',
              symbol: 'any',
            },
          ],
          constraints: [
            {
              key: 'testFailures',
              comparator: 'eq',
              value: 0,
            },
          ],
        },
      },
      'lint',
      3,
      'metric_lint',
    );

    const constraints = normalized.longRun?.constraints ?? [];
    expect(constraints.some((row) => row.key === 'commandFailures')).toBe(true);
    expect(constraints.some((row) => row.key === 'lintWarnings')).toBe(true);
  });

  test('デフォルト候補は重複しない', () => {
    const ids = makeDefaultLintCandidates().map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('candidate id は slug 化される', () => {
    expect(sanitizeCandidateId(' ESLint Fix Layout ')).toBe('eslint-fix-layout');
  });
});
