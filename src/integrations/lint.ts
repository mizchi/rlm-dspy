import type {
  PlannerConstraintSpec,
  RLMPlannerPlan,
} from '../planner/index.ts';
import type { TextEdit } from '../util/textEdits.ts';

export interface LintMetricSummary {
  lintErrors: number;
  lintWarnings: number;
  fixableErrors: number;
  fixableWarnings: number;
  filesWithProblems: number;
}

export type LintTextEdit = TextEdit;

export interface LintCandidate {
  id: string;
  description: string;
  commands: string[];
  edits?: LintTextEdit[];
}

export const sanitizeCandidateId = (input: string): string => {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'candidate' : slug;
};

export const makeDefaultLintCandidates = (): LintCandidate[] => [
  {
    id: 'eslint-fix',
    description: 'Run eslint --fix',
    commands: ['pnpm exec eslint . --fix'],
  },
  {
    id: 'eslint-fix-problem',
    description: 'Run eslint --fix --fix-type problem',
    commands: ['pnpm exec eslint . --fix --fix-type problem'],
  },
  {
    id: 'eslint-fix-suggestion',
    description: 'Run eslint --fix --fix-type suggestion',
    commands: ['pnpm exec eslint . --fix --fix-type suggestion'],
  },
  {
    id: 'eslint-fix-layout',
    description: 'Run eslint --fix --fix-type layout',
    commands: ['pnpm exec eslint . --fix --fix-type layout'],
  },
];

export const makeDefaultLintLongRunPlan = (
  goal: string,
  maxIterations: number,
  symbol = 'metric_lint',
): RLMPlannerPlan => ({
  kind: 'rlm_plan',
  version: 1,
  mode: 'long_run',
  task: goal,
  profile: 'hybrid',
  symbols: [symbol],
  longRun: {
    objectives: [
      {
        key: 'lintErrors',
        direction: 'minimize',
        symbol,
        weight: 1,
      },
      {
        key: 'lintWarnings',
        direction: 'minimize',
        symbol,
        weight: 0.25,
      },
    ],
    constraints: [
      {
        key: 'testFailures',
        comparator: 'eq',
        value: 0,
        symbol,
      },
      {
        key: 'commandFailures',
        comparator: 'eq',
        value: 0,
        symbol,
      },
      {
        key: 'lintWarnings',
        comparator: 'lte',
        value: 1.1,
        source: 'ratio',
        symbol,
      },
    ],
    maxIterations,
    stopWhenNoAccept: true,
    minScoreDelta: 0.1,
  },
});

export const normalizeLintPlan = (
  plan: RLMPlannerPlan,
  goal: string,
  maxIterations: number,
  symbol = 'metric_lint',
): RLMPlannerPlan => {
  if (plan.mode !== 'long_run' || plan.longRun === undefined) {
    return makeDefaultLintLongRunPlan(goal, maxIterations, symbol);
  }

  const supportedKeys = new Set<string>([
    'lintErrors',
    'lintWarnings',
    'testFailures',
    'commandFailures',
  ]);
  const objectives = plan.longRun.objectives.filter((row) =>
    supportedKeys.has(row.key),
  );
  if (objectives.length === 0) {
    return makeDefaultLintLongRunPlan(goal, maxIterations, symbol);
  }
  const constraints = (plan.longRun.constraints ?? [])
    .filter((row) => supportedKeys.has(row.key))
    .map((row) => ({
      ...row,
      symbol: row.symbol ?? symbol,
    }));
  const guardedConstraints = withDefaultLintGuards(constraints, symbol);

  return {
    ...plan,
    mode: 'long_run',
    symbols: [symbol],
    longRun: {
      ...plan.longRun,
      objectives: objectives.map((row) => ({
        ...row,
        symbol,
      })),
      constraints: guardedConstraints,
      maxIterations: plan.longRun.maxIterations ?? maxIterations,
    },
  };
};

export const extractESLintSummary = (json: unknown): LintMetricSummary => {
  const rows = extractResultRows(json);

  let lintErrors = 0;
  let lintWarnings = 0;
  let fixableErrors = 0;
  let fixableWarnings = 0;
  let filesWithProblems = 0;

  for (const row of rows) {
    const errorCount = numberOrZero(row.errorCount);
    const warningCount = numberOrZero(row.warningCount);
    const fixableErrorCount = numberOrZero(row.fixableErrorCount);
    const fixableWarningCount = numberOrZero(row.fixableWarningCount);

    lintErrors += errorCount;
    lintWarnings += warningCount;
    fixableErrors += fixableErrorCount;
    fixableWarnings += fixableWarningCount;
    if (errorCount > 0 || warningCount > 0) {
      filesWithProblems += 1;
    }
  }

  return {
    lintErrors,
    lintWarnings,
    fixableErrors,
    fixableWarnings,
    filesWithProblems,
  };
};

const withDefaultLintGuards = (
  constraints: PlannerConstraintSpec[],
  symbol: string,
): PlannerConstraintSpec[] => {
  const out = [...constraints];
  if (!out.some((row) => row.key === 'testFailures')) {
    out.push({
      key: 'testFailures',
      comparator: 'eq',
      value: 0,
      symbol,
    });
  }
  if (!out.some((row) => row.key === 'commandFailures')) {
    out.push({
      key: 'commandFailures',
      comparator: 'eq',
      value: 0,
      symbol,
    });
  }
  if (!out.some((row) => row.key === 'lintWarnings')) {
    out.push({
      key: 'lintWarnings',
      comparator: 'lte',
      value: 1.1,
      source: 'ratio',
      symbol,
    });
  }
  return out;
};

const extractResultRows = (json: unknown): Record<string, unknown>[] => {
  if (Array.isArray(json)) {
    return json.filter(isRecord);
  }
  if (isRecord(json)) {
    const rows = json.results;
    if (Array.isArray(rows)) {
      return rows.filter(isRecord);
    }
  }
  throw new Error('eslint json must be array or object with results[]');
};

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);
