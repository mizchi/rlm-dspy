import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import {
  makeDefaultFlatbuffersCandidates,
  buildFlatbuffersConfigureArgs,
  extractFlatbuffersBenchmarkSummary,
  sanitizeCandidateId,
} from '../src/integrations/flatbuffers.ts';
import { MockLLMProvider } from '../src/llm/MockLLMProvider.ts';
import { OpenAIProvider } from '../src/llm/OpenAIProvider.ts';
import {
  createRLMPlan,
  runPlannedRLM,
  type RLMPlannerPlan,
} from '../src/planner/index.ts';
import { parseOneJSON } from '../src/util/json.ts';
import type { ExternalSymbolFn } from '../src/rlm/types.ts';

const execFileAsync = promisify(execFile);

interface CLIArgs {
  repoDir: string;
  buildRootDir: string;
  plannerProvider: 'mock' | 'openai';
  model: string;
  goal: string;
  maxIterations: number;
  repetitions: number;
  jobs: number;
  candidateLimit: number;
  benchmarkFilter: string;
  outPath?: string;
}

interface FlatbuffersCandidateInput {
  id: string;
  description: string;
  cmakeArgs: string[];
}

interface CandidateMetrics {
  encodeNs: number;
  decodeNs: number;
  useNs: number;
  buildFailures: number;
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const plannerLLM =
    args.plannerProvider === 'openai'
      ? new OpenAIProvider({ model: args.model })
      : new MockLLMProvider({
          scriptsByDepth: {
            0: [JSON.stringify(makeMockLongRunPlan(args.goal, args.maxIterations))],
          },
        });

  const pool = makeDefaultFlatbuffersCandidates();
  const metricsCache = new Map<string, CandidateMetrics>();

  const evaluateCandidate = async (
    candidate: FlatbuffersCandidateInput,
  ): Promise<CandidateMetrics> => {
    const key = JSON.stringify(candidate);
    const cached = metricsCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const buildDir = join(args.buildRootDir, sanitizeCandidateId(candidate.id));
    process.stdout.write(
      `[candidate] ${candidate.id} configure+build+bench at ${buildDir}\n`,
    );

    try {
      await runCommand('cmake', buildFlatbuffersConfigureArgs({
        sourceDir: args.repoDir,
        buildDir,
        candidateCMakeArgs: candidate.cmakeArgs,
      }));
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
      const metrics: CandidateMetrics = {
        ...summary,
        buildFailures: 0,
      };
      metricsCache.set(key, metrics);
      return metrics;
    } catch (cause) {
      process.stderr.write(
        `[candidate] ${candidate.id} failed: ${(cause as Error).message}\n`,
      );
      const failed: CandidateMetrics = {
        encodeNs: Number.POSITIVE_INFINITY,
        decodeNs: Number.POSITIVE_INFINITY,
        useNs: Number.POSITIVE_INFINITY,
        buildFailures: 1,
      };
      metricsCache.set(key, failed);
      return failed;
    }
  };

  const baselineInput: FlatbuffersCandidateInput = {
    id: 'baseline-release',
    description: 'Baseline release flags',
    cmakeArgs: [],
  };
  const baseline = await evaluateCandidate(baselineInput);
  process.stdout.write(
    `[baseline] encode=${fmt(baseline.encodeNs)} decode=${fmt(baseline.decodeNs)} use=${fmt(baseline.useNs)} buildFailures=${baseline.buildFailures}\n`,
  );

  const symbols: Record<string, ExternalSymbolFn> = {
    metric_flatbuffers: async (call) => {
      const argsRow = asRecord(call.args);
      const metricKey = asString(argsRow.metricKey, 'metricKey');
      const candidate = coerceCandidateInput(
        argsRow.candidate ?? call.input ?? baselineInput,
      );
      const metrics = await evaluateCandidate(candidate);
      return pickMetric(metrics, metricKey);
    },
  };

  const planned = await createRLMPlan({
    input: args.goal,
    prompt: [
      `repoDir=${args.repoDir}`,
      'task=optimize flatbuffers C++ benchmark by trying build candidates',
      `benchmarkFilter=${args.benchmarkFilter}`,
    ].join('\n'),
    llm: plannerLLM,
    availableSymbols: ['metric_flatbuffers'],
  });
  const plan = normalizePlanForFlatbuffers(
    planned,
    args.goal,
    args.maxIterations,
  );

  const result = await runPlannedRLM<FlatbuffersCandidateInput, { repoDir: string }>({
    input: args.goal,
    prompt: [
      `repoDir=${args.repoDir}`,
      'task=optimize flatbuffers C++ benchmark by trying build candidates',
      `benchmarkFilter=${args.benchmarkFilter}`,
    ].join('\n'),
    plannerLLM,
    planOverride: plan,
    symbols,
    longRun: {
      baseline: {
        metrics: {
          encodeNs: baseline.encodeNs,
          decodeNs: baseline.decodeNs,
          useNs: baseline.useNs,
          buildFailures: baseline.buildFailures,
        },
      },
      initialState: { repoDir: args.repoDir },
      maxIterations: args.maxIterations,
      stopWhenNoAccept: true,
      generateCandidates: async (ctx) => {
        const tried = new Set<string>();
        for (const round of ctx.rounds) {
          for (const row of round.results) {
            tried.add(row.candidate.id);
          }
        }
        const out = pool
          .filter((row) => !tried.has(row.id))
          .slice(0, args.candidateLimit)
          .map((row) => ({
            id: row.id,
            input: {
              id: row.id,
              description: row.description,
              cmakeArgs: row.cmakeArgs,
            },
          }));
        process.stdout.write(
          `[round ${ctx.iteration}] candidates=${out.map((v) => v.id).join(',') || '(none)'}\n`,
        );
        return out;
      },
    },
  });

  if (result.mode === 'single') {
    process.stdout.write(
      `planner selected single mode. final="${result.result.final}"\n`,
    );
    if (args.outPath !== undefined) {
      const outPath = resolve(args.outPath);
      await writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
      process.stdout.write(`saved report: ${outPath}\n`);
    }
    return;
  }

  const rounds = result.result.rounds;
  process.stdout.write(
    `completed rounds=${rounds.length} accepted=${result.result.acceptedHistory.length}\n`,
  );
  for (const [roundIndex, round] of rounds.entries()) {
    process.stdout.write(`- round ${roundIndex}\n`);
    for (const row of round.results) {
      const summary =
        row.snapshot === undefined
          ? 'no-snapshot'
          : `encode=${fmt(row.snapshot.metrics.encodeNs)} decode=${fmt(row.snapshot.metrics.decodeNs)} use=${fmt(row.snapshot.metrics.useNs)} buildFailures=${row.snapshot.metrics.buildFailures}`;
      process.stdout.write(
        `  ${row.candidate.id}: ${row.accepted ? 'accepted' : 'rejected'} ${summary} reasons=${row.reasons.join('|')}\n`,
      );
    }
  }

  const best = result.result.acceptedHistory.at(-1);
  if (best !== undefined) {
    process.stdout.write(`best accepted candidate: ${best.candidate.id}\n`);
  } else {
    process.stdout.write('no accepted candidate\n');
  }
  process.stdout.write(
    `final baseline: encode=${fmt(result.result.finalBaseline.metrics.encodeNs)} decode=${fmt(result.result.finalBaseline.metrics.decodeNs)} use=${fmt(result.result.finalBaseline.metrics.useNs)} buildFailures=${result.result.finalBaseline.metrics.buildFailures}\n`,
  );

  if (args.outPath !== undefined) {
    const outPath = resolve(args.outPath);
    await writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
    process.stdout.write(`saved report: ${outPath}\n`);
  }
};

const makeMockLongRunPlan = (
  goal: string,
  maxIterations: number,
) => ({
  kind: 'rlm_plan',
  version: 1,
  mode: 'long_run',
  task: goal,
  profile: 'hybrid',
  symbols: ['metric_flatbuffers'],
  longRun: {
    objectives: [
      { key: 'encodeNs', direction: 'minimize', symbol: 'metric_flatbuffers', weight: 1 },
      { key: 'decodeNs', direction: 'minimize', symbol: 'metric_flatbuffers', weight: 0.25 },
      { key: 'useNs', direction: 'minimize', symbol: 'metric_flatbuffers', weight: 0.25 },
    ],
    constraints: [
      { key: 'buildFailures', comparator: 'eq', value: 0, symbol: 'metric_flatbuffers' },
    ],
    maxIterations,
    stopWhenNoAccept: true,
    minScoreDelta: 0.01,
  },
}) satisfies RLMPlannerPlan;

const normalizePlanForFlatbuffers = (
  plan: RLMPlannerPlan,
  goal: string,
  maxIterations: number,
): RLMPlannerPlan => {
  if (plan.mode !== 'long_run') {
    return plan;
  }
  if (plan.longRun === undefined) {
    return makeMockLongRunPlan(goal, maxIterations);
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
    return makeMockLongRunPlan(goal, maxIterations);
  }

  const constraints = (plan.longRun.constraints ?? [])
    .filter((row) => supportedKeys.has(row.key))
    .map((row) => ({
      ...row,
      symbol: row.symbol ?? 'metric_flatbuffers',
    }));

  return {
    ...plan,
    symbols: ['metric_flatbuffers'],
    longRun: {
      ...plan.longRun,
      objectives: objectives.map((row) => ({
        ...row,
        symbol: 'metric_flatbuffers',
      })),
      constraints:
        constraints.length > 0
          ? constraints
          : [
              {
                key: 'buildFailures',
                comparator: 'eq',
                value: 0,
                symbol: 'metric_flatbuffers',
              },
            ],
      maxIterations: plan.longRun.maxIterations ?? maxIterations,
    },
  };
};

const parseArgs = (argv: string[]): CLIArgs => {
  const kv = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      kv.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      kv.set(key, next);
      i += 1;
    } else {
      kv.set(key, 'true');
    }
  }

  const plannerProvider = kv.get('planner-provider') ?? 'mock';
  if (plannerProvider !== 'mock' && plannerProvider !== 'openai') {
    throw new Error(`--planner-provider must be mock|openai, got: ${plannerProvider}`);
  }

  const parsePositive = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) {
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`invalid positive number: ${raw}`);
    }
    return Math.floor(n);
  };

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
    maxIterations: parsePositive(kv.get('max-iterations'), 2),
    repetitions: parsePositive(kv.get('repetitions'), 3),
    jobs: parsePositive(kv.get('jobs'), 8),
    candidateLimit: parsePositive(kv.get('candidate-limit'), 3),
    benchmarkFilter:
      kv.get('benchmark-filter') ??
      'BM_Flatbuffers_Encode|BM_Flatbuffers_Decode|BM_Flatbuffers_Use',
    ...(kv.get('out') !== undefined ? { outPath: kv.get('out') } : {}),
  };
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

const asRecord = (input: unknown): Record<string, unknown> => {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
};

const asString = (input: unknown, label: string): string => {
  if (typeof input === 'string' && input !== '') {
    return input;
  }
  throw new Error(`${label} must be string`);
};

const coerceCandidateInput = (input: unknown): FlatbuffersCandidateInput => {
  const row = asRecord(input);
  const id = typeof row.id === 'string' ? row.id : 'unknown';
  const description =
    typeof row.description === 'string' ? row.description : id;
  const cmakeArgs = Array.isArray(row.cmakeArgs)
    ? row.cmakeArgs.filter((v): v is string => typeof v === 'string')
    : [];
  return {
    id,
    description,
    cmakeArgs,
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

const fmt = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : String(v);

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
