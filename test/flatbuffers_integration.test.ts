import { describe, expect, test } from 'vitest';
import {
  buildFlatbuffersConfigureArgs,
  extractFlatbuffersBenchmarkSummary,
  makeDefaultFlatbuffersCandidates,
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
});
