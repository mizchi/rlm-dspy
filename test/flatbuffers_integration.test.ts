import { describe, expect, test } from 'vitest';
import {
  applyTextEdits,
  buildFlatbuffersConfigureArgs,
  extractFlatbuffersBenchmarkSummary,
  makeDefaultFlatbuffersLongRunPlan,
  makeDefaultFlatbuffersCandidates,
  normalizeFlatbuffersPlan,
  sanitizeCandidateId,
} from '../src/integrations/flatbuffers.ts';

describe('flatbuffers integration helpers', () => {
  test('Google Benchmark JSON から必要メトリクスを抽出できる', () => {
    const json = {
      benchmarks: [
        {
          name: 'BM_Flatbuffers_Encode_mean',
          aggregate_name: 'mean',
          real_time: 100.5,
        },
        {
          name: 'BM_Flatbuffers_Decode_mean',
          aggregate_name: 'mean',
          real_time: 0.5,
        },
        {
          name: 'BM_Flatbuffers_Use_mean',
          aggregate_name: 'mean',
          real_time: 5.5,
        },
      ],
    };

    const out = extractFlatbuffersBenchmarkSummary(json);
    expect(out).toEqual({
      encodeNs: 100.5,
      decodeNs: 0.5,
      useNs: 5.5,
    });
  });

  test('repetitions=1 の通常行でも抽出できる', () => {
    const json = {
      benchmarks: [
        { name: 'BM_Flatbuffers_Encode', real_time: 101.1 },
        { name: 'BM_Flatbuffers_Decode', real_time: 0.6 },
        { name: 'BM_Flatbuffers_Use', real_time: 5.7 },
      ],
    };

    const out = extractFlatbuffersBenchmarkSummary(json);
    expect(out).toEqual({
      encodeNs: 101.1,
      decodeNs: 0.6,
      useNs: 5.7,
    });
  });

  test('候補IDはファイルパスとして安全な形に正規化される', () => {
    expect(sanitizeCandidateId('O3 + IPO')).toBe('o3-ipo');
    expect(sanitizeCandidateId('  weird///id  ')).toBe('weird-id');
  });

  test('デフォルト候補は重複しないIDを持つ', () => {
    const candidates = makeDefaultFlatbuffersCandidates();
    const ids = candidates.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('o3');
    expect(candidates.some((row) => (row.edits?.length ?? 0) > 0)).toBe(true);
  });

  test('cmake configure 引数を組み立てられる', () => {
    const args = buildFlatbuffersConfigureArgs({
      sourceDir: '/repo',
      buildDir: '/repo/build-x',
      candidateCMakeArgs: ['-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG'],
    });

    expect(args).toContain('-S');
    expect(args).toContain('/repo');
    expect(args).toContain('-B');
    expect(args).toContain('/repo/build-x');
    expect(args).toContain('-DFLATBUFFERS_BUILD_BENCHMARKS=ON');
  });

  test('applyTextEdits で source 候補の編集を適用できる', () => {
    const src = ['hello', 'TARGET', 'world'].join('\n');
    const out = applyTextEdits(src, [
      {
        file: 'dummy.txt',
        search: 'TARGET',
        replace: 'REPLACED',
      },
    ]);

    expect(out.changed).toBe(true);
    expect(out.content).toContain('REPLACED');
  });

  test('applyTextEdits は search 未一致なら changed=false', () => {
    const out = applyTextEdits('abc', [
      {
        file: 'dummy.txt',
        search: 'zzz',
        replace: 'x',
      },
    ]);
    expect(out.changed).toBe(false);
  });

  test('single plan は flatbuffers 用 long_run plan に補正される', () => {
    const normalized = normalizeFlatbuffersPlan(
      {
        kind: 'rlm_plan',
        version: 1,
        mode: 'single',
        task: 'optimize',
      },
      'goal',
      3,
    );

    expect(normalized.mode).toBe('long_run');
    expect(normalized.longRun?.objectives.length).toBeGreaterThan(0);
    expect(normalized.longRun?.maxIterations).toBe(3);
  });

  test('unsupported objective だけの plan は default にフォールバックする', () => {
    const normalized = normalizeFlatbuffersPlan(
      {
        kind: 'rlm_plan',
        version: 1,
        mode: 'long_run',
        task: 'optimize',
        longRun: {
          objectives: [
            {
              key: 'unknownMetric',
              direction: 'minimize',
              symbol: 'metric_flatbuffers',
            },
          ],
        },
      },
      'goal-fallback',
      2,
    );

    const fallback = makeDefaultFlatbuffersLongRunPlan('goal-fallback', 2);
    expect(normalized.mode).toBe('long_run');
    expect(normalized.longRun?.objectives).toEqual(fallback.longRun?.objectives);
  });

  test('guard 制約が不足している plan にデフォルト制約を補う', () => {
    const normalized = normalizeFlatbuffersPlan(
      {
        kind: 'rlm_plan',
        version: 1,
        mode: 'long_run',
        task: 'optimize',
        longRun: {
          objectives: [
            {
              key: 'encodeNs',
              direction: 'minimize',
              symbol: 'x',
            },
          ],
          constraints: [
            {
              key: 'buildFailures',
              comparator: 'eq',
              value: 0,
            },
          ],
        },
      },
      'goal',
      4,
    );

    const constraints = normalized.longRun?.constraints ?? [];
    expect(constraints.some((row) => row.key === 'decodeNs')).toBe(true);
    expect(constraints.some((row) => row.key === 'useNs')).toBe(true);
    expect(normalized.longRun?.objectives[0]?.symbol).toBe('metric_flatbuffers');
  });
});
