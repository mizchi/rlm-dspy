import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  applyTextEdits,
  makeDefaultFlatbuffersLongRunPlan,
  makeDefaultFlatbuffersCandidates,
  buildFlatbuffersConfigureArgs,
  extractFlatbuffersBenchmarkSummary,
  normalizeFlatbuffersPlan,
  sanitizeCandidateId,
  type FlatbuffersCandidate,
  type FlatbuffersTextEdit,
} from '../src/integrations/flatbuffers.ts';
import { runLongRunProgram, type LongRunCommonArgs } from '../src/improve/program.ts';
import type { RLMPlannerPlan } from '../src/planner/index.ts';
import { parseOneJSON } from '../src/util/json.ts';
import {
  parseCLIKeyValues,
  parsePlannerProvider,
  parsePositiveInt,
} from '../src/util/cli.ts';
import {
  cleanupDetachedWorktree,
  prepareDetachedWorktree,
} from '../src/util/worktree.ts';

const execFileAsync = promisify(execFile);

interface CLIArgs extends LongRunCommonArgs {
  repoDir: string;
  buildRootDir: string;
  repetitions: number;
  jobs: number;
  benchmarkFilter: string;
}

interface CandidateMetrics {
  encodeNs: number;
  decodeNs: number;
  useNs: number;
  buildFailures: number;
}

const main = async (): Promise<void> => {
  await runLongRunProgram<
    CLIArgs,
    FlatbuffersCandidate,
    FlatbuffersCandidate,
    CandidateMetrics,
    { repoDir: string }
  >(
    {
      symbolName: 'metric_flatbuffers',
      parseArgs,
      createMockPlan: makeMockLongRunPlan,
      normalizePlan: normalizePlanForFlatbuffers,
      buildPrompt: (args) =>
        [
          `repoDir=${args.repoDir}`,
          'task=optimize flatbuffers C++ benchmark by trying build candidates',
          `benchmarkFilter=${args.benchmarkFilter}`,
        ].join('\n'),
      loadPool: async () => makeDefaultFlatbuffersCandidates(),
      toCandidate: (row) => ({
        id: row.id,
        input: {
          id: row.id,
          description: row.description,
          cmakeArgs: row.cmakeArgs,
          ...(row.edits !== undefined ? { edits: row.edits } : {}),
        },
      }),
      baselineCandidate: () => ({
        id: 'baseline-release',
        description: 'Baseline release flags',
        cmakeArgs: [],
      }),
      coerceCandidate: coerceCandidateInput,
      evaluateCandidate,
      pickMetric,
      initialState: (args) => ({ repoDir: args.repoDir }),
      formatMetrics: formatFlatbuffersMetrics,
      cacheKey: (candidate) => JSON.stringify(candidate),
      stopWhenNoAccept: () => true,
    },
    process.argv.slice(2),
  );
};

const makeMockLongRunPlan = (
  goal: string,
  maxIterations: number,
): RLMPlannerPlan => makeDefaultFlatbuffersLongRunPlan(goal, maxIterations);

const normalizePlanForFlatbuffers = (
  plan: RLMPlannerPlan,
  goal: string,
  maxIterations: number,
): RLMPlannerPlan => normalizeFlatbuffersPlan(plan, goal, maxIterations);

const parseArgs = (argv: string[]): CLIArgs => {
  const kv = parseCLIKeyValues(argv);
  const plannerProvider = parsePlannerProvider(kv.get('planner-provider'));

  return {
    repoDir: resolve(kv.get('repo') ?? '/Users/mz/ghq/github.com/google/flatbuffers'),
    buildRootDir: resolve(
      kv.get('build-root') ??
        '/Users/mz/ghq/github.com/google/flatbuffers/build-rlm-candidates',
    ),
    plannerProvider,
    model: kv.get('model') ?? 'gpt-4.1-mini',
    goal:
      kv.get('goal') ??
      'flatbuffers C++ benchmark を改善したい。encode/decode/use を小さくする',
    maxIterations: parsePositiveInt(kv.get('max-iterations'), 2),
    repetitions: parsePositiveInt(kv.get('repetitions'), 3),
    jobs: parsePositiveInt(kv.get('jobs'), 8),
    candidateLimit: parsePositiveInt(kv.get('candidate-limit'), 3),
    benchmarkFilter:
      kv.get('benchmark-filter') ??
      'BM_Flatbuffers_Encode|BM_Flatbuffers_Decode|BM_Flatbuffers_Use',
    ...(kv.get('out') !== undefined ? { outPath: kv.get('out') } : {}),
  };
};

const evaluateCandidate = async (
  args: CLIArgs,
  candidate: FlatbuffersCandidate,
  io: { writer: (line: string) => void; errorWriter: (line: string) => void },
): Promise<CandidateMetrics> => {
  const buildDir = join(args.buildRootDir, sanitizeCandidateId(candidate.id));
  io.writer(`[candidate] ${candidate.id} configure+build+bench at ${buildDir}`);

  let cleanup = async (): Promise<void> => {};
  try {
    const setup = await prepareCandidateSource({
      repoDir: args.repoDir,
      buildRootDir: args.buildRootDir,
      candidate,
    });
    const sourceDir = setup.sourceDir;
    cleanup = setup.cleanup;

    await runCommand('cmake',
      buildFlatbuffersConfigureArgs({
        sourceDir,
        buildDir,
        candidateCMakeArgs: candidate.cmakeArgs,
      }),
    );
    await runCommand('cmake', [
      '--build',
      buildDir,
      '--target',
      'flatbenchmark',
      `-j${args.jobs}`,
    ]);
    const benchBin = join(buildDir, 'flatbenchmark');
    const bench = await runCommand(benchBin, [
      `--benchmark_repetitions=${args.repetitions}`,
      '--benchmark_report_aggregates_only=true',
      '--benchmark_format=json',
      `--benchmark_filter=${args.benchmarkFilter}`,
    ]);

    const parsed = parseOneJSON<unknown>(`${bench.stdout}\n${bench.stderr}`);
    const summary = extractFlatbuffersBenchmarkSummary(parsed);
    return {
      ...summary,
      buildFailures: 0,
    };
  } catch (cause) {
    io.errorWriter(`[candidate] ${candidate.id} failed: ${(cause as Error).message}`);
    return {
      encodeNs: Number.POSITIVE_INFINITY,
      decodeNs: Number.POSITIVE_INFINITY,
      useNs: Number.POSITIVE_INFINITY,
      buildFailures: 1,
    };
  } finally {
    await cleanup();
  }
};

const runCommand = async (
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
};

const prepareCandidateSource = async (args: {
  repoDir: string;
  buildRootDir: string;
  candidate: FlatbuffersCandidate;
}): Promise<{ sourceDir: string; cleanup: () => Promise<void> }> => {
  const edits = args.candidate.edits ?? [];
  if (edits.length === 0) {
    return {
      sourceDir: args.repoDir,
      cleanup: async () => {},
    };
  }

  const sourceDir = join(
    args.buildRootDir,
    `_wt_${sanitizeCandidateId(args.candidate.id)}`,
  );
  await prepareDetachedWorktree({
    runCommand,
    repoDir: args.repoDir,
    worktreeDir: sourceDir,
  });

  try {
    const byFile = new Map<string, FlatbuffersTextEdit[]>();
    for (const edit of edits) {
      const list = byFile.get(edit.file) ?? [];
      list.push(edit);
      byFile.set(edit.file, list);
    }
    for (const [file, fileEdits] of byFile) {
      const fullPath = join(sourceDir, file);
      const src = await readFile(fullPath, 'utf8');
      const out = applyTextEdits(src, fileEdits);
      if (!out.changed) {
        throw new Error(`source edit had no effect: ${file}`);
      }
      await writeFile(fullPath, out.content, 'utf8');
    }
  } catch (cause) {
    await cleanupDetachedWorktree({
      runCommand,
      repoDir: args.repoDir,
      worktreeDir: sourceDir,
    });
    throw cause;
  }

  return {
    sourceDir,
    cleanup: async () => {
      await cleanupDetachedWorktree({
        runCommand,
        repoDir: args.repoDir,
        worktreeDir: sourceDir,
      });
    },
  };
};

const coerceCandidateInput = (input: unknown): FlatbuffersCandidate => {
  const row = asRecord(input);
  const id = typeof row.id === 'string' ? row.id : 'unknown';
  const description = typeof row.description === 'string' ? row.description : id;
  const cmakeArgs = Array.isArray(row.cmakeArgs)
    ? row.cmakeArgs.filter((v): v is string => typeof v === 'string')
    : [];
  const edits = Array.isArray(row.edits)
    ? row.edits
        .filter(
          (v): v is Record<string, unknown> =>
            typeof v === 'object' && v !== null && !Array.isArray(v),
        )
        .map((v) => ({
          file: typeof v.file === 'string' ? v.file : '',
          search: typeof v.search === 'string' ? v.search : '',
          replace: typeof v.replace === 'string' ? v.replace : '',
          ...(typeof v.all === 'boolean' ? { all: v.all } : {}),
        }))
        .filter((v) => v.file !== '' && v.search !== '')
    : [];

  return {
    id,
    description,
    cmakeArgs,
    ...(edits.length > 0 ? { edits } : {}),
  };
};

const pickMetric = (metrics: CandidateMetrics, key: string): number => {
  switch (key) {
    case 'encodeNs':
      return metrics.encodeNs;
    case 'decodeNs':
      return metrics.decodeNs;
    case 'useNs':
      return metrics.useNs;
    case 'buildFailures':
      return metrics.buildFailures;
    default:
      return Number.POSITIVE_INFINITY;
  }
};

const formatFlatbuffersMetrics = (metrics: Record<string, number>): string =>
  [
    `encode=${fmt(metrics.encodeNs)}`,
    `decode=${fmt(metrics.decodeNs)}`,
    `use=${fmt(metrics.useNs)}`,
    `buildFailures=${fmtInt(metrics.buildFailures)}`,
  ].join(' ');

const asRecord = (input: unknown): Record<string, unknown> => {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
};

const fmt = (value: number): string =>
  Number.isFinite(value) ? value.toFixed(4) : String(value);

const fmtInt = (value: number): string =>
  Number.isFinite(value) ? String(Math.trunc(value)) : String(value);

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
