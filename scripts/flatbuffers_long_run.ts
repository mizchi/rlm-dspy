import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import {
  applyTextEdits,
  makeDefaultFlatbuffersLongRunPlan,
  makeDefaultFlatbuffersCandidates,
  buildFlatbuffersConfigureArgs,
  extractFlatbuffersBenchmarkSummary,
  normalizeFlatbuffersPlan,
  sanitizeCandidateId,
  type FlatbuffersTextEdit,
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
  edits?: FlatbuffersTextEdit[];
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

    let cleanup = async (): Promise<void> => {};
    try {
      const setup = await prepareCandidateSource({
        repoDir: args.repoDir,
        buildRootDir: args.buildRootDir,
        candidate,
      });
      const sourceDir = setup.sourceDir;
      cleanup = setup.cleanup;

      await runCommand('cmake', buildFlatbuffersConfigureArgs({
        sourceDir,
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
    } finally {
      await cleanup();
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
              ...(row.edits !== undefined ? { edits: row.edits } : {}),
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

  const best = rounds.at(-1)?.bestAccepted;
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
) => makeDefaultFlatbuffersLongRunPlan(goal, maxIterations);

const normalizePlanForFlatbuffers = (
  plan: RLMPlannerPlan,
  goal: string,
  maxIterations: number,
): RLMPlannerPlan => normalizeFlatbuffersPlan(plan, goal, maxIterations);

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

const prepareCandidateSource = async (args: {
  repoDir: string;
  buildRootDir: string;
  candidate: FlatbuffersCandidateInput;
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
  // Stale worktree cleanup. Ignore errors here.
  try {
    await runCommand('git', ['-C', args.repoDir, 'worktree', 'remove', '--force', sourceDir]);
  } catch {
    // ignored
  }
  await rm(sourceDir, { recursive: true, force: true });
  await runCommand('git', ['-C', args.repoDir, 'worktree', 'add', '--detach', sourceDir, 'HEAD']);

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
    await runCommand('git', ['-C', args.repoDir, 'worktree', 'remove', '--force', sourceDir]).catch(() => {});
    await rm(sourceDir, { recursive: true, force: true });
    throw cause;
  }

  return {
    sourceDir,
    cleanup: async () => {
      await runCommand('git', ['-C', args.repoDir, 'worktree', 'remove', '--force', sourceDir]).catch(() => {});
      await rm(sourceDir, { recursive: true, force: true });
    },
  };
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

const fmt = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : String(v);

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
