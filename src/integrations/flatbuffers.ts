import type {
  PlannerConstraintSpec,
  RLMPlannerPlan,
} from '../planner/index.ts';
import {
  applyTextEdits as applyTextEditsBase,
  type ApplyTextEditsResult,
  type TextEdit,
} from '../util/textEdits.ts';
export type { ApplyTextEditsResult } from '../util/textEdits.ts';

export interface FlatbuffersBenchmarkSummary {
  encodeNs: number;
  decodeNs: number;
  useNs: number;
}

export interface FlatbuffersCandidate {
  id: string;
  description: string;
  cmakeArgs: string[];
  edits?: FlatbuffersTextEdit[];
}

export type FlatbuffersTextEdit = TextEdit;

export const sanitizeCandidateId = (input: string): string => {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'candidate' : slug;
};

export const makeDefaultFlatbuffersCandidates = (): FlatbuffersCandidate[] => [
  {
    id: 'o2',
    description: 'Release O2',
    cmakeArgs: ['-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG'],
  },
  {
    id: 'o3',
    description: 'Release O3',
    cmakeArgs: ['-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG'],
  },
  {
    id: 'ofast',
    description: 'Release Ofast',
    cmakeArgs: ['-DCMAKE_CXX_FLAGS_RELEASE=-Ofast -DNDEBUG'],
  },
  {
    id: 'ipo',
    description: 'Enable IPO/LTO',
    cmakeArgs: ['-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON'],
  },
  {
    id: 'o3-ipo',
    description: 'Release O3 + IPO/LTO',
    cmakeArgs: [
      '-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG',
      '-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON',
    ],
  },
  {
    id: 'src-reuse-name-offset',
    description: 'Reuse string offset in FlatBufferBench::Encode loop',
    cmakeArgs: [],
    edits: [
      {
        file: 'benchmarks/cpp/flatbuffers/fb_bench.cpp',
        search: [
          '    for (int i = 0; i < kVectorLength; ++i) {',
          "      Foo foo(0xABADCAFEABADCAFE + i, 10000 + i, '@' + i, 1000000 + i);",
          '      Bar bar(foo, 123456 + i, 3.14159f + i, 10000 + i);',
          '      auto name = fbb.CreateString("Hello, World!");',
          '      auto foobar =',
          "          CreateFooBar(fbb, &bar, name, 3.1415432432445543543 + i, '!' + i);",
          '      vec[i] = foobar;',
          '    }',
        ].join('\n'),
        replace: [
          '    auto name = fbb.CreateString("Hello, World!");',
          '    for (int i = 0; i < kVectorLength; ++i) {',
          "      Foo foo(0xABADCAFEABADCAFE + i, 10000 + i, '@' + i, 1000000 + i);",
          '      Bar bar(foo, 123456 + i, 3.14159f + i, 10000 + i);',
          '      auto foobar =',
          "          CreateFooBar(fbb, &bar, name, 3.1415432432445543543 + i, '!' + i);",
          '      vec[i] = foobar;',
          '    }',
        ].join('\n'),
      },
    ],
  },
];

export const makeDefaultFlatbuffersLongRunPlan = (
  goal: string,
  maxIterations: number,
): RLMPlannerPlan => ({
  kind: 'rlm_plan',
  version: 1,
  mode: 'long_run',
  task: goal,
  profile: 'hybrid',
  symbols: ['metric_flatbuffers'],
  longRun: {
    objectives: [
      {
        key: 'encodeNs',
        direction: 'minimize',
        symbol: 'metric_flatbuffers',
        weight: 1,
      },
      {
        key: 'decodeNs',
        direction: 'minimize',
        symbol: 'metric_flatbuffers',
        weight: 0.25,
      },
      {
        key: 'useNs',
        direction: 'minimize',
        symbol: 'metric_flatbuffers',
        weight: 0.25,
      },
    ],
    constraints: [
      {
        key: 'buildFailures',
        comparator: 'eq',
        value: 0,
        symbol: 'metric_flatbuffers',
      },
      {
        key: 'decodeNs',
        comparator: 'lte',
        value: 1.03,
        source: 'ratio',
        symbol: 'metric_flatbuffers',
      },
      {
        key: 'useNs',
        comparator: 'lte',
        value: 1.03,
        source: 'ratio',
        symbol: 'metric_flatbuffers',
      },
    ],
    maxIterations,
    stopWhenNoAccept: true,
    minScoreDelta: 0.01,
  },
});

export const normalizeFlatbuffersPlan = (
  plan: RLMPlannerPlan,
  goal: string,
  maxIterations: number,
): RLMPlannerPlan => {
  if (plan.mode !== 'long_run' || plan.longRun === undefined) {
    return makeDefaultFlatbuffersLongRunPlan(goal, maxIterations);
  }

  const supportedKeys = new Set<string>([
    'encodeNs',
    'decodeNs',
    'useNs',
    'buildFailures',
  ]);
  const objectives = plan.longRun.objectives.filter((row) =>
    supportedKeys.has(row.key),
  );
  if (objectives.length === 0) {
    return makeDefaultFlatbuffersLongRunPlan(goal, maxIterations);
  }

  const constraints = (plan.longRun.constraints ?? [])
    .filter((row) => supportedKeys.has(row.key))
    .map((row) => ({
      ...row,
      symbol: row.symbol ?? 'metric_flatbuffers',
    }));
  const guardedConstraints = withDefaultFlatbuffersGuards(constraints);

  return {
    ...plan,
    mode: 'long_run',
    symbols: ['metric_flatbuffers'],
    longRun: {
      ...plan.longRun,
      objectives: objectives.map((row) => ({
        ...row,
        symbol: 'metric_flatbuffers',
      })),
      constraints: guardedConstraints,
      maxIterations: plan.longRun.maxIterations ?? maxIterations,
    },
  };
};

export const buildFlatbuffersConfigureArgs = (args: {
  sourceDir: string;
  buildDir: string;
  candidateCMakeArgs: string[];
}): string[] => [
  '-S',
  args.sourceDir,
  '-B',
  args.buildDir,
  '-G',
  'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DFLATBUFFERS_BUILD_BENCHMARKS=ON',
  '-DFLATBUFFERS_BUILD_TESTS=OFF',
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
  ...args.candidateCMakeArgs,
];

export const extractFlatbuffersBenchmarkSummary = (
  json: unknown,
): FlatbuffersBenchmarkSummary => {
  if (
    typeof json !== 'object' ||
    json === null ||
    Array.isArray(json)
  ) {
    throw new Error('benchmark json must be object');
  }
  const root = json as Record<string, unknown>;
  const rows = root.benchmarks;
  if (!Array.isArray(rows)) {
    throw new Error('benchmark json must include benchmarks[]');
  }

  const encodeNs = pickAggregate(rows, [
    'BM_Flatbuffers_Encode_mean',
    'BM_Flatbuffers_Encode',
  ]);
  const decodeNs = pickAggregate(rows, [
    'BM_Flatbuffers_Decode_mean',
    'BM_Flatbuffers_Decode',
  ]);
  const useNs = pickAggregate(rows, [
    'BM_Flatbuffers_Use_mean',
    'BM_Flatbuffers_Use',
  ]);

  return { encodeNs, decodeNs, useNs };
};

export const applyTextEdits = (
  content: string,
  edits: FlatbuffersTextEdit[],
): ApplyTextEditsResult => applyTextEditsBase(content, edits);

const withDefaultFlatbuffersGuards = (
  constraints: PlannerConstraintSpec[],
): PlannerConstraintSpec[] => {
  const out = [...constraints];
  if (!out.some((row) => row.key === 'buildFailures')) {
    out.push({
      key: 'buildFailures',
      comparator: 'eq',
      value: 0,
      symbol: 'metric_flatbuffers',
    });
  }
  if (!out.some((row) => row.key === 'decodeNs')) {
    out.push({
      key: 'decodeNs',
      comparator: 'lte',
      value: 1.03,
      source: 'ratio',
      symbol: 'metric_flatbuffers',
    });
  }
  if (!out.some((row) => row.key === 'useNs')) {
    out.push({
      key: 'useNs',
      comparator: 'lte',
      value: 1.03,
      source: 'ratio',
      symbol: 'metric_flatbuffers',
    });
  }
  return out;
};

const pickAggregate = (rows: unknown[], names: string[]): number => {
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      Array.isArray(row)
    ) {
      continue;
    }
    const item = row as Record<string, unknown>;
    if (typeof item.name !== 'string' || !names.includes(item.name)) {
      continue;
    }
    const value = item.real_time;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    break;
  }
  throw new Error(`benchmark aggregate not found: ${names.join('|')}`);
};
