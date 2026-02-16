export interface FlatbuffersBenchmarkSummary {
  encodeNs: number;
  decodeNs: number;
  useNs: number;
}

export interface FlatbuffersCandidate {
  id: string;
  description: string;
  cmakeArgs: string[];
}

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
];

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
