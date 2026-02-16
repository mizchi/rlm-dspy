import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
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
  runLongRunProgram,
  type LongRunCommonArgs,
} from '../src/improve/program.ts';
import type { RLMPlannerPlan } from '../src/planner/index.ts';
import { parseOneJSON } from '../src/util/json.ts';
import {
  parseCLIKeyValues,
  parsePlannerProvider,
  parsePositiveInt,
} from '../src/util/cli.ts';
import { applyTextEdits } from '../src/util/textEdits.ts';
import {
  cleanupDetachedWorktree,
  prepareDetachedWorktree,
} from '../src/util/worktree.ts';

const execFileAsync = promisify(execFile);

interface CLIArgs extends LongRunCommonArgs {
  repoDir: string;
  buildRootDir: string;
  lintCommand: string;
  testCommand?: string;
  candidatesFile?: string;
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
  await runLongRunProgram<
    CLIArgs,
    LintCandidate,
    LintCandidate,
    LintMetrics,
    { repoDir: string }
  >(
    {
      symbolName: 'metric_lint',
      parseArgs,
      createMockPlan: makeMockLongRunPlan,
      normalizePlan: (plan, goal, maxIterations) =>
        normalizeLintPlan(plan, goal, maxIterations, 'metric_lint'),
      buildPrompt: (args) =>
        [
          `repoDir=${args.repoDir}`,
          'task=optimize lint metrics by applying candidate commands on a worktree',
          `lintCommand=${args.lintCommand}`,
          ...(args.testCommand !== undefined
            ? [`testCommand=${args.testCommand}`]
            : []),
        ].join('\n'),
      loadPool: loadCandidates,
      toCandidate: (row) => ({
        id: row.id,
        input: row,
      }),
      baselineCandidate: () => ({
        id: 'baseline',
        description: 'No transform',
        commands: [],
      }),
      coerceCandidate,
      evaluateCandidate,
      pickMetric,
      initialState: (args) => ({ repoDir: args.repoDir }),
      formatMetrics: formatLintMetrics,
      cacheKey: (candidate) => JSON.stringify(candidate),
      stopWhenNoAccept: () => true,
    },
    process.argv.slice(2),
  );
};

const makeMockLongRunPlan = (
  goal: string,
  maxIterations: number,
): RLMPlannerPlan =>
  makeDefaultLintLongRunPlan(goal, maxIterations, 'metric_lint');

const parseArgs = (argv: string[]): CLIArgs => {
  const kv = parseCLIKeyValues(argv);
  const plannerProvider = parsePlannerProvider(kv.get('planner-provider'));

  return {
    repoDir: resolve(kv.get('repo') ?? process.cwd()),
    buildRootDir: resolve(
      kv.get('build-root') ?? join(process.cwd(), '.rlm-worktrees'),
    ),
    plannerProvider,
    model: kv.get('model') ?? 'gpt-4.1-mini',
    goal:
      kv.get('goal') ??
      'lint errors と warnings を減らしつつ test failures を 0 に保つ',
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

const evaluateCandidate = async (
  args: CLIArgs,
  candidate: LintCandidate,
  io: { writer: (line: string) => void; errorWriter: (line: string) => void },
): Promise<LintMetrics> => {
  io.writer(`[candidate] ${candidate.id} evaluate`);
  const sourceDir = join(args.buildRootDir, `_wt_${sanitizeCandidateId(candidate.id)}`);

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
        io.errorWriter(
          `[candidate] ${candidate.id} command failed (${run.exitCode}): ${command}`,
        );
      }
    }

    const lintRun = await runShell(args.lintCommand, sourceDir);
    const lintSummary = parseLintSummary(lintRun);
    if (lintSummary === undefined) {
      commandFailures += 1;
    }

    const testFailures = await evaluateTestFailures(args.testCommand, sourceDir);
    return {
      lintErrors: lintSummary?.lintErrors ?? Number.POSITIVE_INFINITY,
      lintWarnings: lintSummary?.lintWarnings ?? Number.POSITIVE_INFINITY,
      fixableErrors: lintSummary?.fixableErrors ?? Number.POSITIVE_INFINITY,
      fixableWarnings: lintSummary?.fixableWarnings ?? Number.POSITIVE_INFINITY,
      filesWithProblems:
        lintSummary?.filesWithProblems ?? Number.POSITIVE_INFINITY,
      testFailures,
      commandFailures,
    };
  } finally {
    await cleanupWorktree(args.repoDir, sourceDir);
  }
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

const cleanupWorktree = async (
  repoDir: string,
  sourceDir: string,
): Promise<void> => {
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

const formatLintMetrics = (metrics: Record<string, number>): string =>
  [
    `lintErrors=${fmt(metrics.lintErrors)}`,
    `lintWarnings=${fmt(metrics.lintWarnings)}`,
    `testFailures=${fmtInt(metrics.testFailures)}`,
    `commandFailures=${fmtInt(metrics.commandFailures)}`,
  ].join(' ');

const fmt = (value: number): string =>
  Number.isFinite(value) ? value.toFixed(4) : String(value);

const fmtInt = (value: number): string =>
  Number.isFinite(value) ? String(Math.trunc(value)) : String(value);

await main();
