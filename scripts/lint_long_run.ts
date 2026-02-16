import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MockLLMProvider } from '../src/llm/MockLLMProvider.ts';
import { OpenAIProvider } from '../src/llm/OpenAIProvider.ts';
import {
  extractESLintSummary,
  makeDefaultLintCandidates,
  makeDefaultLintLongRunPlan,
  normalizeLintPlan,
  sanitizeCandidateId,
  type LintCandidate,
  type LintTextEdit,
} from '../src/integrations/lint.ts';
import {
  createRLMPlan,
  runPlannedRLM,
  type RLMPlannerPlan,
} from '../src/planner/index.ts';
import {
  createMetricSymbol,
  selectUntriedCandidates,
} from '../src/improve/harness.ts';
import { parseOneJSON } from '../src/util/json.ts';
import {
  parseCLIKeyValues,
  parsePlannerProvider,
  parsePositiveInt,
  type PlannerProvider,
} from '../src/util/cli.ts';
import { applyTextEdits } from '../src/util/textEdits.ts';
import {
  cleanupDetachedWorktree,
  prepareDetachedWorktree,
} from '../src/util/worktree.ts';
import type { ExternalSymbolFn } from '../src/rlm/types.ts';

const execFileAsync = promisify(execFile);

interface CLIArgs {
  repoDir: string;
  buildRootDir: string;
  plannerProvider: PlannerProvider;
  model: string;
  goal: string;
  maxIterations: number;
  candidateLimit: number;
  lintCommand: string;
  testCommand?: string;
  candidatesFile?: string;
  outPath?: string;
}

interface LintMetrics {
  lintErrors: number;
  lintWarnings: number;
  fixableErrors: number;
  fixableWarnings: number;
  filesWithProblems: number;
  testFailures: number;
  commandFailures: number;
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

  const pool = await loadCandidates(args);
  const metricsCache = new Map<string, LintMetrics>();

  const evaluateCandidate = async (candidate: LintCandidate): Promise<LintMetrics> => {
    const key = JSON.stringify(candidate);
    const cached = metricsCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    process.stdout.write(`[candidate] ${candidate.id} evaluate\n`);
    const sourceDir = join(
      args.buildRootDir,
      `_wt_${sanitizeCandidateId(candidate.id)}`,
    );

    let commandFailures = 0;
    try {
      await prepareWorktree({
        repoDir: args.repoDir,
        sourceDir,
      });
      await applyCandidateEdits(sourceDir, candidate.edits ?? []);

      for (const command of candidate.commands) {
        const run = await runShell(command, sourceDir);
        if (run.exitCode !== 0) {
          commandFailures += 1;
          process.stderr.write(
            `[candidate] ${candidate.id} command failed (${run.exitCode}): ${command}\n`,
          );
        }
      }

      const lintRun = await runShell(args.lintCommand, sourceDir);
      const lintSummary = parseLintSummary(lintRun);
      if (lintSummary === undefined) {
        commandFailures += 1;
      }
      const testFailures = await evaluateTestFailures(args.testCommand, sourceDir);
      const metrics: LintMetrics = {
        lintErrors: lintSummary?.lintErrors ?? Number.POSITIVE_INFINITY,
        lintWarnings: lintSummary?.lintWarnings ?? Number.POSITIVE_INFINITY,
        fixableErrors: lintSummary?.fixableErrors ?? Number.POSITIVE_INFINITY,
        fixableWarnings: lintSummary?.fixableWarnings ?? Number.POSITIVE_INFINITY,
        filesWithProblems: lintSummary?.filesWithProblems ?? Number.POSITIVE_INFINITY,
        testFailures,
        commandFailures,
      };
      metricsCache.set(key, metrics);
      return metrics;
    } finally {
      await cleanupWorktree(args.repoDir, sourceDir);
    }
  };

  const baselineInput: LintCandidate = {
    id: 'baseline',
    description: 'No transform',
    commands: [],
  };
  const baseline = await evaluateCandidate(baselineInput);
  process.stdout.write(
    `[baseline] lintErrors=${fmt(baseline.lintErrors)} lintWarnings=${fmt(baseline.lintWarnings)} testFailures=${baseline.testFailures} commandFailures=${baseline.commandFailures}\n`,
  );

  const symbols: Record<string, ExternalSymbolFn> = {
    metric_lint: createMetricSymbol({
      baselineInput,
      coerceCandidate,
      evaluateCandidate,
      pickMetric,
      cache: metricsCache,
      cacheKey: (candidate) => JSON.stringify(candidate),
    }),
  };

  const prompt = [
    `repoDir=${args.repoDir}`,
    'task=optimize lint metrics by applying candidate commands on a worktree',
    `lintCommand=${args.lintCommand}`,
    ...(args.testCommand !== undefined ? [`testCommand=${args.testCommand}`] : []),
  ].join('\n');

  const planned = await createRLMPlan({
    input: args.goal,
    prompt,
    llm: plannerLLM,
    availableSymbols: ['metric_lint'],
  });
  const plan = normalizeLintPlan(planned, args.goal, args.maxIterations, 'metric_lint');

  const result = await runPlannedRLM<LintCandidate, { repoDir: string }>({
    input: args.goal,
    prompt,
    plannerLLM,
    planOverride: plan,
    symbols,
    longRun: {
      baseline: {
        metrics: {
          lintErrors: baseline.lintErrors,
          lintWarnings: baseline.lintWarnings,
          testFailures: baseline.testFailures,
          commandFailures: baseline.commandFailures,
        },
      },
      initialState: { repoDir: args.repoDir },
      maxIterations: args.maxIterations,
      stopWhenNoAccept: true,
      generateCandidates: async (ctx) => {
        const out = selectUntriedCandidates({
          pool,
          rounds: ctx.rounds,
          candidateLimit: args.candidateLimit,
          toInput: (row) => ({
            id: row.id,
            input: row,
          }),
        });
        process.stdout.write(
          `[round ${ctx.iteration}] candidates=${out.map((v) => v.id).join(',') || '(none)'}\n`,
        );
        return out;
      },
    },
  });

  if (result.mode === 'single') {
    process.stdout.write(`planner selected single mode. final="${result.result.final}"\n`);
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
          : `lintErrors=${fmt(row.snapshot.metrics.lintErrors)} lintWarnings=${fmt(row.snapshot.metrics.lintWarnings)} testFailures=${row.snapshot.metrics.testFailures} commandFailures=${row.snapshot.metrics.commandFailures}`;
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
    `final baseline: lintErrors=${fmt(result.result.finalBaseline.metrics.lintErrors)} lintWarnings=${fmt(result.result.finalBaseline.metrics.lintWarnings)} testFailures=${result.result.finalBaseline.metrics.testFailures} commandFailures=${result.result.finalBaseline.metrics.commandFailures}\n`,
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
): RLMPlannerPlan => makeDefaultLintLongRunPlan(goal, maxIterations, 'metric_lint');

const loadCandidates = async (args: CLIArgs): Promise<LintCandidate[]> => {
  if (args.candidatesFile === undefined) {
    return makeDefaultLintCandidates();
  }
  const src = await readFile(args.candidatesFile, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(src);
  } catch {
    parsed = parseOneJSON<unknown>(src);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--candidates-file must be JSON array');
  }
  const out = parsed.map(coerceCandidate).filter((v) => v.commands.length > 0);
  if (out.length === 0) {
    throw new Error('candidates file has no valid candidate');
  }
  return out;
};

const parseArgs = (argv: string[]): CLIArgs => {
  const kv = parseCLIKeyValues(argv);
  const plannerProvider = parsePlannerProvider(kv.get('planner-provider'));
  return {
    repoDir: resolve(kv.get('repo') ?? process.cwd()),
    buildRootDir: resolve(kv.get('build-root') ?? join(process.cwd(), '.rlm-worktrees')),
    plannerProvider,
    model: kv.get('model') ?? 'gpt-4.1-mini',
    goal: kv.get('goal') ?? 'lint errors と warnings を減らしつつ test failures を 0 に保つ',
    maxIterations: parsePositiveInt(kv.get('max-iterations'), 2),
    candidateLimit: parsePositiveInt(kv.get('candidate-limit'), 3),
    lintCommand: kv.get('lint-command') ?? 'pnpm exec eslint . --format json',
    ...(kv.get('test-command') !== undefined
      ? { testCommand: kv.get('test-command') }
      : {}),
    ...(kv.get('candidates-file') !== undefined
      ? { candidatesFile: resolve(kv.get('candidates-file') as string) }
      : {}),
    ...(kv.get('out') !== undefined ? { outPath: kv.get('out') } : {}),
  };
};

const prepareWorktree = async (args: {
  repoDir: string;
  sourceDir: string;
}): Promise<void> => {
  await prepareDetachedWorktree({
    runCommand,
    repoDir: args.repoDir,
    worktreeDir: args.sourceDir,
  });
};

const cleanupWorktree = async (repoDir: string, sourceDir: string): Promise<void> => {
  await cleanupDetachedWorktree({
    runCommand,
    repoDir,
    worktreeDir: sourceDir,
  });
};

const applyCandidateEdits = async (
  sourceDir: string,
  edits: LintTextEdit[],
): Promise<void> => {
  if (edits.length === 0) {
    return;
  }
  const byFile = new Map<string, LintTextEdit[]>();
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
};

const evaluateTestFailures = async (
  command: string | undefined,
  cwd: string,
): Promise<number> => {
  if (command === undefined) {
    return 0;
  }
  const run = await runShell(command, cwd);
  return run.exitCode === 0 ? 0 : 1;
};

const parseLintSummary = (
  run: { stdout: string; stderr: string; exitCode: number },
):
  | {
      lintErrors: number;
      lintWarnings: number;
      fixableErrors: number;
      fixableWarnings: number;
      filesWithProblems: number;
    }
  | undefined => {
  const merged = `${run.stdout}\n${run.stderr}`.trim();
  try {
    const parsed = JSON.parse(merged) as unknown;
    return extractESLintSummary(parsed);
  } catch {
    // fallback
  }
  try {
    const parsed = parseOneJSON<unknown>(merged);
    return extractESLintSummary(parsed);
  } catch {
    return undefined;
  }
};

const runShell = async (
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  try {
    const out = await execFileAsync('zsh', ['-lc', command], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      stdout: out.stdout,
      stderr: out.stderr,
      exitCode: 0,
    };
  } catch (cause) {
    const err = cause as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
};

const runCommand = async (
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

const asRecord = (input: unknown): Record<string, unknown> => {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
};

const coerceCandidate = (input: unknown): LintCandidate => {
  const row = asRecord(input);
  const id = typeof row.id === 'string' ? row.id : 'candidate';
  const description = typeof row.description === 'string' ? row.description : id;
  const commands = Array.isArray(row.commands)
    ? row.commands.filter((v): v is string => typeof v === 'string' && v !== '')
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
    commands,
    ...(edits.length > 0 ? { edits } : {}),
  };
};

const pickMetric = (metrics: LintMetrics, key: string): number => {
  switch (key) {
    case 'lintErrors':
      return metrics.lintErrors;
    case 'lintWarnings':
      return metrics.lintWarnings;
    case 'fixableErrors':
      return metrics.fixableErrors;
    case 'fixableWarnings':
      return metrics.fixableWarnings;
    case 'filesWithProblems':
      return metrics.filesWithProblems;
    case 'testFailures':
      return metrics.testFailures;
    case 'commandFailures':
      return metrics.commandFailures;
    default:
      return Number.POSITIVE_INFINITY;
  }
};

const fmt = (value: number): string =>
  Number.isFinite(value) ? value.toFixed(4) : String(value);

await main();
