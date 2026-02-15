import {
  consumeRootStep,
  defaultBudget,
  type BudgetState,
} from '../budget/Budget.ts';
import type {
  ChatMessage,
  LLMCompleteOptions,
  LLMProvider,
  LLMResponseFormat,
} from '../llm/LLMProvider.ts';
import { DSLRepl } from '../repl/DSLRepl.ts';
import type { DSL } from '../repl/DSL.ts';
import { makePromptMeta, makeStdoutMeta } from '../trace/Trace.ts';
import { parseOneJSON } from '../util/json.ts';
import { hashString } from '../util/hash.ts';
import { createSubRLMRunner } from './subRLM.ts';
import type { RLMEnv, RLMOptions, RLMResultPack, SubRLMOptions } from './types.ts';
import { InMemoryDocStore } from '../doc/DocStore.ts';

const DEFAULT_SYSTEM_PROMPT = [
  'You are an RLM root controller.',
  'Output exactly one JSON object and nothing else.',
  'Allowed ops: prompt_meta, doc_parse, doc_select_section, doc_table_sum, doc_select_rows, doc_project_columns, slice_prompt, find, chunk_newlines, sum_csv_column, pick_word, sub_map, reduce_join, set, finalize.',
  'Required fields by op must be present and correctly typed.',
  'Do not invent fields like env, action, tool, code.',
  'To finish, first put final text in scratch via set, then call {"op":"finalize","from":"<key>"} exactly.',
  'env.prompt body is hidden; read via DSL ops only.',
  'If the task asks sum/合計 of CSV numeric column, prefer sum_csv_column then finalize.',
  'If the task asks CSV row filtering, use doc_select_rows with comparator/value, then doc_project_columns.',
  'If the task asks 文中の単語を一つ, prefer pick_word(index=1) then finalize.',
  'If the task asks extract TOKEN=value style text, prefer find + slice_prompt + finalize.',
  'Few-shot example A (extract token):',
  '1) {"op":"slice_prompt","start":0,"end":400,"out":"w"}',
  '2) {"op":"set","path":"scratch.answer","value":"NEBULA-42"}',
  '3) {"op":"finalize","from":"answer"}',
  'Few-shot example B (csv aggregate):',
  '1) {"op":"sum_csv_column","column":1,"delimiter":",","out":"total"}',
  '2) {"op":"finalize","from":"total"}',
  'Few-shot example C (pick one word):',
  '1) {"op":"pick_word","index":1,"out":"picked"}',
  '2) {"op":"finalize","from":"picked"}',
  'Few-shot example D (markdown section extraction):',
  '1) {"op":"doc_parse","format":"markdown","out":"doc"}',
  '2) {"op":"doc_select_section","in":"doc","title":"Data","out":"answer"}',
  '3) {"op":"finalize","from":"answer"}',
  'Few-shot example E (csv filter + project):',
  '1) {"op":"doc_parse","format":"csv","out":"doc"}',
  '2) {"op":"doc_select_rows","in":"doc","column":"name","equals":"alice","out":"rows"}',
  '3) {"op":"doc_project_columns","in":"rows","columns":["score"],"out":"scores"}',
  '4) {"op":"reduce_join","in":"scores","sep":"|","out":"answer"}',
  '5) {"op":"finalize","from":"answer"}',
].join(' ');

const DSL_RESPONSE_FORMAT: LLMResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'rlm_dsl',
    strict: false,
    schema: {
      type: 'object',
      required: ['op'],
      additionalProperties: true,
      properties: {
        op: {
          type: 'string',
          enum: [
            'prompt_meta',
            'doc_parse',
            'doc_select_section',
            'doc_table_sum',
            'doc_select_rows',
            'doc_project_columns',
            'slice_prompt',
            'find',
            'chunk_newlines',
            'sum_csv_column',
            'pick_word',
            'sub_map',
            'reduce_join',
            'set',
            'finalize',
          ],
        },
        start: { type: ['number', 'string', 'null'] },
        end: { type: ['number', 'string', 'null'] },
        out: { type: ['string', 'null'] },
        format: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        columns: {
          type: ['array', 'null'],
          items: {
            type: ['string', 'number'],
          },
        },
        equals: {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
          ],
        },
        comparator: { type: ['string', 'null'] },
        includeHeader: { type: ['boolean', 'null'] },
        separator: { type: ['string', 'null'] },
        needle: { type: ['string', 'null'] },
        from: { type: ['number', 'string', 'null'] },
        maxLines: { type: ['number', 'string', 'null'] },
        column: { type: ['number', 'string', 'null'] },
        delimiter: { type: ['string', 'null'] },
        index: { type: ['number', 'string', 'null'] },
        in: { type: ['string', 'null'] },
        queryTemplate: { type: ['string', 'null'] },
        limit: { type: ['number', 'string', 'null'] },
        sep: { type: ['string', 'null'] },
        path: { type: ['string', 'null'] },
        value: {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
          ],
        },
      },
    },
  },
};

interface RuntimeContext {
  llm: LLMProvider;
  opts: RLMOptions;
  metaPreviewChars: number;
  systemPrompt: string;
  sharedCache: Map<string, string>;
}

interface RunInternalArgs {
  prompt: string;
  depth: number;
  budgetOverride: Partial<BudgetState> | undefined;
  runtime: RuntimeContext;
}

export const runRLM = async (
  prompt: string,
  llm: LLMProvider,
  opts: RLMOptions = {},
): Promise<RLMResultPack> => {
  const runtime: RuntimeContext = {
    llm,
    opts,
    metaPreviewChars: opts.metaPreviewChars ?? 200,
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    sharedCache: new Map<string, string>(),
  };

  return runInternal({
    prompt,
    depth: 0,
    budgetOverride: opts.budget,
    runtime,
  });
};

const runInternal = async (args: RunInternalArgs): Promise<RLMResultPack> => {
  const { prompt, depth, budgetOverride, runtime } = args;
  const env = initEnv({
    prompt,
    depth,
    budgetOverride,
    sharedCache: runtime.sharedCache,
    docStoreFactory: runtime.opts.docStoreFactory,
  });

  const subRLM = createSubRLMRunner({
    env,
    metaPreviewChars: runtime.metaPreviewChars,
    runChild: async ({ prompt: subPrompt, query, options }) => {
      const childBudget = makeChildBudget({
        parent: env.budget,
        subBudget: runtime.opts.subBudget,
        override: options?.budget,
      });
      const childRuntime: RuntimeContext = {
        ...runtime,
        opts: {
          ...runtime.opts,
          task: query,
        },
      };
      const child = await runInternal({
        prompt: subPrompt,
        depth: env.budget.depth + 1,
        budgetOverride: childBudget,
        runtime: childRuntime,
      });
      return child.final;
    },
  });

  const repl = new DSLRepl(env, { subRLM }, {
    metaPreviewChars: runtime.metaPreviewChars,
    requirePromptReadBeforeFinalize:
      runtime.opts.requirePromptReadBeforeFinalize ?? false,
  });

  const history: ChatMessage[] = [
    {
      role: 'system',
      content: runtime.systemPrompt,
    },
    {
      role: 'user',
      content: JSON.stringify(buildInitialMetadata(env, runtime.opts)),
    },
  ];
  let consecutiveErrors = 0;

  while (env.final === undefined) {
    consumeRootStep(env.budget);

    const res = await runtime.llm.complete(
      history,
      buildLLMCompleteOptions(runtime.opts.llm),
    );
    history.push({ role: 'assistant', content: res.text });

    try {
      const rawDSL = parseOneJSON<unknown>(res.text);
      const dsl = coerceDSL(rawDSL);
      const stdout = await repl.exec(dsl, env.budget.stepsUsed);
      consecutiveErrors = 0;

      history.push({
        role: 'user',
        content: JSON.stringify(buildStdoutMetadata(env, stdout, runtime.metaPreviewChars)),
      });

      env.trace.push({
        t: 'root_step',
        step: env.budget.stepsUsed,
        promptMeta: makePromptMeta(env.promptId, env.prompt, runtime.metaPreviewChars),
        stdoutMeta: makeStdoutMeta(stdout, env.scratch, runtime.metaPreviewChars),
        ...(res.usage !== undefined ? { llmUsage: res.usage } : {}),
      });

      const early = maybeAutoFinalizeFromScratch(env, runtime.opts);
      if (early !== undefined) {
        env.final = early;
      }
    } catch (cause) {
      const errorText = (cause as Error).message;
      const errorStdout = `ERROR:${errorText}`;
      consecutiveErrors += 1;
      history.push({
        role: 'user',
        content: JSON.stringify(buildErrorMetadata(env, errorText)),
      });
      env.trace.push({
        t: 'root_step',
        step: env.budget.stepsUsed,
        promptMeta: makePromptMeta(env.promptId, env.prompt, runtime.metaPreviewChars),
        stdoutMeta: makeStdoutMeta(errorStdout, env.scratch, runtime.metaPreviewChars),
        ...(res.usage !== undefined ? { llmUsage: res.usage } : {}),
      });

      const maxConsecutiveErrors =
        runtime.opts.maxConsecutiveErrorsForEarlyStop ?? 2;
      if (
        runtime.opts.enableEarlyStopHeuristic &&
        consecutiveErrors >= maxConsecutiveErrors
      ) {
        const fallback = heuristicSolveByTask(env.prompt, runtime.opts.task);
        if (fallback !== undefined) {
          env.final = fallback;
        }
      }
    }
  }

  return {
    final: postprocessFinal({
      final: env.final,
      prompt: env.prompt,
      task: runtime.opts.task,
      enabled: runtime.opts.enableHeuristicPostprocess ?? false,
    }),
    trace: env.trace,
    budget: env.budget,
  };
};

const initEnv = (args: {
  prompt: string;
  depth: number;
  budgetOverride: Partial<BudgetState> | undefined;
  sharedCache: Map<string, string>;
  docStoreFactory: RLMOptions['docStoreFactory'];
}): RLMEnv => {
  const promptId = hashString(args.prompt);
  const budget = defaultBudget({
    ...(args.budgetOverride ?? {}),
    depth: args.depth,
    startedAt: args.budgetOverride?.startedAt ?? Date.now(),
  });
  const docStore =
    args.docStoreFactory?.({
      prompt: args.prompt,
      promptId,
      depth: args.depth,
    }) ?? InMemoryDocStore.fromSingle(promptId, args.prompt);

  return {
    prompt: args.prompt,
    promptId,
    docStore,
    scratch: {},
    cache: args.sharedCache,
    budget,
    trace: [],
  };
};

const makeChildBudget = (args: {
  parent: BudgetState;
  subBudget: Partial<BudgetState> | undefined;
  override: Partial<BudgetState> | undefined;
}): Partial<BudgetState> => ({
  ...(args.subBudget ?? {}),
  ...(args.override ?? {}),
  maxDepth: args.override?.maxDepth ?? args.parent.maxDepth,
  startedAt: args.override?.startedAt ?? Date.now(),
});

const buildInitialMetadata = (
  env: RLMEnv,
  opts: RLMOptions,
): Record<string, unknown> => {
  const meta: Record<string, unknown> = {
    kind: 'rlm_init',
    depth: env.budget.depth,
    prompt: {
      promptId: env.promptId,
      length: env.prompt.length,
    },
    budget: {
      maxSteps: env.budget.maxSteps,
      maxSubCalls: env.budget.maxSubCalls,
      maxDepth: env.budget.maxDepth,
      maxPromptReadChars: env.budget.maxPromptReadChars,
      maxTimeMs: env.budget.maxTimeMs,
    },
  };
  if (opts.task !== undefined) {
    meta.task = opts.task;
  }
  meta.hints = {
    docParse: { op: 'doc_parse', format: 'auto', out: 'doc' },
    docSelectSection: {
      op: 'doc_select_section',
      in: 'doc',
      title: 'Data',
      out: 'answer',
    },
    docTableSum: { op: 'doc_table_sum', in: 'doc', column: 'score', out: 'total' },
    docSelectRows: {
      op: 'doc_select_rows',
      in: 'doc',
      column: 'name',
      comparator: 'eq',
      value: 'alice',
      out: 'rows',
    },
    docProjectColumns: {
      op: 'doc_project_columns',
      in: 'rows',
      columns: ['score'],
      out: 'lines',
    },
    sumCsv: { op: 'sum_csv_column', column: 1, delimiter: ',', out: 'total' },
    pickWord: { op: 'pick_word', index: 1, out: 'picked' },
    extractToken: { op: 'find', needle: 'TOKEN=', out: 'hits' },
    finalize: { op: 'finalize', from: 'answer_or_total' },
  };
  return meta;
};

const buildStdoutMetadata = (
  env: RLMEnv,
  stdout: string,
  maxChars: number,
): Record<string, unknown> => ({
  kind: 'rlm_stdout',
  depth: env.budget.depth,
  stdout: makeStdoutMeta(stdout, env.scratch, maxChars),
  budgetUsed: {
    stepsUsed: env.budget.stepsUsed,
    subCallsUsed: env.budget.subCallsUsed,
    promptReadCharsUsed: env.budget.promptReadCharsUsed,
  },
});

const buildErrorMetadata = (
  env: RLMEnv,
  error: string,
): Record<string, unknown> => ({
  kind: 'rlm_error',
  depth: env.budget.depth,
  error,
  required: {
    output: 'single_json_object',
    finalize: { op: 'finalize', from: 'scratch_key' },
    set: { op: 'set', path: 'scratch.answer', value: '...' },
  },
  budgetUsed: {
    stepsUsed: env.budget.stepsUsed,
    subCallsUsed: env.budget.subCallsUsed,
    promptReadCharsUsed: env.budget.promptReadCharsUsed,
  },
});

const buildLLMCompleteOptions = (
  options: LLMCompleteOptions | undefined,
): LLMCompleteOptions => ({
  ...(options ?? {}),
  responseFormat: options?.responseFormat ?? DSL_RESPONSE_FORMAT,
});

const coerceDSL = (raw: unknown): DSL => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('DSL must be object');
  }
  const row = raw as Record<string, unknown>;
  const op = asString(row.op, 'op');

  switch (op) {
    case 'prompt_meta':
      return { op };

    case 'doc_parse': {
      const format =
        row.format !== undefined && row.format !== null
          ? asDocParseFormat(row.format, 'doc_parse.format')
          : undefined;
      return {
        op,
        ...(format !== undefined ? { format } : {}),
        ...(row.delimiter !== undefined && row.delimiter !== null
          ? { delimiter: asString(row.delimiter, 'doc_parse.delimiter') }
          : {}),
        out: asString(row.out ?? 'doc', 'doc_parse.out'),
      };
    }

    case 'doc_select_section':
      return {
        op,
        in: asString(row.in ?? 'doc', 'doc_select_section.in'),
        title: asString(row.title ?? row.section ?? 'Introduction', 'doc_select_section.title'),
        out: asString(row.out ?? 'answer', 'doc_select_section.out'),
      };

    case 'doc_table_sum':
      return {
        op,
        in: asString(row.in ?? 'doc', 'doc_table_sum.in'),
        column: asStringOrNumber(row.column ?? 1, 'doc_table_sum.column'),
        out: asString(row.out ?? 'total', 'doc_table_sum.out'),
      };

    case 'doc_select_rows':
      return {
        op,
        in: asString(row.in ?? 'doc', 'doc_select_rows.in'),
        column: asStringOrNumber(
          row.column ?? row.whereColumn ?? 0,
          'doc_select_rows.column',
        ),
        ...(row.comparator !== undefined && row.comparator !== null
          ? { comparator: asCsvComparator(row.comparator, 'doc_select_rows.comparator') }
          : row.operator !== undefined && row.operator !== null
            ? { comparator: asCsvComparator(row.operator, 'doc_select_rows.operator') }
            : {}),
        value: asScalar(
          row.equals ?? row.value ?? row.match ?? '',
          'doc_select_rows.value',
        ),
        out: asString(row.out ?? 'rows', 'doc_select_rows.out'),
      };

    case 'doc_project_columns':
      return {
        op,
        in: asString(row.in ?? 'doc', 'doc_project_columns.in'),
        columns: asColumnList(
          row.columns ?? row.cols ?? [0],
          'doc_project_columns.columns',
        ),
        out: asString(row.out ?? 'lines', 'doc_project_columns.out'),
        ...(row.separator !== undefined && row.separator !== null
          ? { separator: asString(row.separator, 'doc_project_columns.separator') }
          : row.sep !== undefined && row.sep !== null
            ? { separator: asString(row.sep, 'doc_project_columns.sep') }
            : {}),
        ...(row.includeHeader !== undefined && row.includeHeader !== null
          ? { includeHeader: asBoolean(row.includeHeader, 'doc_project_columns.includeHeader') }
          : {}),
      };

    case 'slice_prompt':
      return {
        op,
        start: asNumber(row.start, 'slice_prompt.start'),
        end: asNumber(row.end, 'slice_prompt.end'),
        out: asString(row.out ?? row.from ?? 'chunk', 'slice_prompt.out'),
      };

    case 'find':
      return {
        op,
        needle: asString(row.needle, 'find.needle'),
        ...(row.from !== undefined && row.from !== null
          ? { from: asNumber(row.from, 'find.from') }
          : {}),
        out: asString(row.out ?? 'hits', 'find.out'),
      };

    case 'chunk_newlines':
      return {
        op,
        maxLines: asNumber(row.maxLines ?? 20, 'chunk_newlines.maxLines'),
        out: asString(row.out ?? 'chunks', 'chunk_newlines.out'),
      };

    case 'sub_map':
      return {
        op,
        in: asString(row.in ?? 'chunks', 'sub_map.in'),
        queryTemplate: asString(
          row.queryTemplate ?? row.template ?? '{{item}}',
          'sub_map.queryTemplate',
        ),
        out: asString(row.out ?? 'mapped', 'sub_map.out'),
        ...(row.limit !== undefined && row.limit !== null
          ? { limit: asNumber(row.limit, 'sub_map.limit') }
          : {}),
      };

    case 'sum_csv_column':
      return {
        op,
        column: asNumber(row.column ?? 1, 'sum_csv_column.column'),
        ...(row.delimiter !== undefined && row.delimiter !== null
          ? { delimiter: asString(row.delimiter, 'sum_csv_column.delimiter') }
          : {}),
        out: asString(row.out ?? 'total', 'sum_csv_column.out'),
      };

    case 'pick_word':
      return {
        op,
        ...(row.index !== undefined && row.index !== null
          ? { index: asNumber(row.index, 'pick_word.index') }
          : {}),
        out: asString(row.out ?? 'picked', 'pick_word.out'),
      };

    case 'reduce_join':
      return {
        op,
        in: asString(row.in ?? 'mapped', 'reduce_join.in'),
        sep: asString(row.sep ?? '\n', 'reduce_join.sep'),
        out: asString(row.out ?? 'joined', 'reduce_join.out'),
      };

    case 'set': {
      const path =
        row.path !== undefined && row.path !== null
          ? asString(row.path, 'set.path')
          : `scratch.${asString(row.key ?? 'answer', 'set.key')}`;
      return {
        op,
        path,
        value: row.value ?? row.answer ?? row.result ?? '',
      };
    }

    case 'finalize':
      return {
        op,
        from: asString(row.from ?? row.path ?? row.key ?? 'answer', 'finalize.from'),
      };

    default:
      throw new Error(`unknown op: ${op}`);
  }
};

const asString = (input: unknown, label: string): string => {
  if (typeof input !== 'string') {
    throw new Error(`${label} must be string`);
  }
  return input;
};

const asNumber = (input: unknown, label: string): number => {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === 'string' && input.trim() !== '') {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${label} must be number`);
};

const asStringOrNumber = (
  input: unknown,
  label: string,
): string | number => {
  if (typeof input === 'string' && input.trim() !== '') {
    return input;
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  throw new Error(`${label} must be string or number`);
};

const asDocParseFormat = (
  input: unknown,
  label: string,
): 'auto' | 'text' | 'markdown' | 'csv' => {
  const value = asString(input, label);
  if (value === 'auto' || value === 'text' || value === 'markdown' || value === 'csv') {
    return value;
  }
  throw new Error(`${label} must be auto|text|markdown|csv`);
};

const asScalar = (
  input: unknown,
  label: string,
): string | number | boolean | null => {
  if (input === null) {
    return null;
  }
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  throw new Error(`${label} must be string|number|boolean|null`);
};

const asBoolean = (input: unknown, label: string): boolean => {
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'string') {
    if (input === 'true') {
      return true;
    }
    if (input === 'false') {
      return false;
    }
  }
  throw new Error(`${label} must be boolean`);
};

const asColumnList = (
  input: unknown,
  label: string,
): (string | number)[] => {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${label} must be non-empty array`);
  }
  return input.map((item, index) =>
    asStringOrNumber(item, `${label}[${index}]`),
  );
};

const asCsvComparator = (
  input: unknown,
  label: string,
): 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' => {
  const value = asString(input, label);
  if (
    value === 'eq' ||
    value === 'contains' ||
    value === 'gt' ||
    value === 'gte' ||
    value === 'lt' ||
    value === 'lte'
  ) {
    return value;
  }
  throw new Error(`${label} must be eq|contains|gt|gte|lt|lte`);
};

const maybeAutoFinalizeFromScratch = (
  env: RLMEnv,
  opts: RLMOptions,
): string | undefined => {
  if (!opts.enableEarlyStopHeuristic) {
    return undefined;
  }
  if (opts.requirePromptReadBeforeFinalize && env.budget.promptReadCharsUsed <= 0) {
    return undefined;
  }

  const task = opts.task?.toLowerCase() ?? '';
  const orderedKeys =
    task.includes('sum') || task.includes('合計')
      ? ['total', 'sum', 'answer', 'result', 'joined', 'picked']
      : task.includes('word') || task.includes('単語')
        ? ['picked', 'answer', 'result', 'joined', 'total']
        : ['answer', 'result', 'total', 'picked', 'joined'];

  for (const key of orderedKeys) {
    const raw = env.scratch[key];
    if (typeof raw !== 'string') {
      continue;
    }
    const candidate = raw.trim();
    if (candidate.length === 0) {
      continue;
    }
    return postprocessFinal({
      final: candidate,
      prompt: env.prompt,
      task: opts.task,
      enabled: opts.enableHeuristicPostprocess ?? false,
    });
  }
  return undefined;
};

const heuristicSolveByTask = (
  prompt: string,
  task: string | undefined,
): string | undefined => {
  if (task === undefined) {
    return undefined;
  }
  if (/token|値/i.test(task)) {
    return extractTokenValue(prompt);
  }
  if (/合計|sum/i.test(task)) {
    return sumCsvColumn(prompt, 1, ',');
  }
  if (/単語.*一つ|one word/i.test(task)) {
    return pickWord(prompt, 1);
  }
  return undefined;
};

const postprocessFinal = (args: {
  final: string;
  prompt: string;
  task: string | undefined;
  enabled: boolean;
}): string => {
  if (!args.enabled || args.task === undefined) {
    return args.final;
  }
  const task = args.task;

  if (/token|値/i.test(task)) {
    const token = extractTokenValue(args.prompt);
    if (token !== undefined) {
      return token;
    }
  }

  if (/合計|sum/i.test(task)) {
    const sum = sumCsvColumn(args.prompt, 1, ',');
    if (sum !== undefined) {
      return sum;
    }
  }

  if (/単語.*一つ|one word/i.test(task)) {
    const picked = pickWord(args.prompt, 1);
    if (picked !== undefined) {
      return picked;
    }
  }

  return args.final;
};

const extractTokenValue = (prompt: string): string | undefined => {
  const m = prompt.match(/(?:^|\n)\s*TOKEN\s*=\s*([^\s\n]+)/i);
  return m?.[1];
};

const sumCsvColumn = (
  prompt: string,
  column: number,
  delimiter: string,
): string | undefined => {
  const lines = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  let sum = 0;
  let used = 0;
  for (const line of lines) {
    const cols = line.split(delimiter).map((v) => v.trim());
    const raw = cols[column];
    if (raw === undefined || raw === '') {
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      continue;
    }
    sum += value;
    used += 1;
  }
  if (used === 0) {
    return undefined;
  }
  return String(sum);
};

const pickWord = (prompt: string, index: number): string | undefined => {
  const words = prompt
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return undefined;
  }
  const idx = Math.max(0, Math.min(index, words.length - 1));
  return words[idx];
};
