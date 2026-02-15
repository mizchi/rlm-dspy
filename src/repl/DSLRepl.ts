import { consumePromptChars } from '../budget/Budget.ts';
import { makeStdoutMeta } from '../trace/Trace.ts';
import type { DSL } from './DSL.ts';
import type { RLMEnv, SubRLMFn } from '../rlm/types.ts';
import {
  filterCsvRows,
  findMarkdownSection,
  isStructuredDocument,
  parseStructuredDocument,
  projectCsvColumns,
  resolveCsvColumnIndex,
} from '../doc/StructuredDocument.ts';

interface DSLReplHooks {
  subRLM: SubRLMFn;
}

interface DSLReplOptions {
  metaPreviewChars?: number;
  requirePromptReadBeforeFinalize?: boolean;
}

export class DSLRepl {
  private readonly env: RLMEnv;
  private readonly hooks: DSLReplHooks;
  private readonly metaPreviewChars: number;
  private readonly requirePromptReadBeforeFinalize: boolean;
  private promptCache: string | undefined;

  constructor(env: RLMEnv, hooks: DSLReplHooks, options: DSLReplOptions = {}) {
    this.env = env;
    this.hooks = hooks;
    this.metaPreviewChars = options.metaPreviewChars ?? 200;
    this.requirePromptReadBeforeFinalize =
      options.requirePromptReadBeforeFinalize ?? false;
  }

  private async readPromptAll(): Promise<string> {
    if (this.promptCache !== undefined) {
      return this.promptCache;
    }
    const prompt = await this.env.docStore.readAll(this.env.promptId);
    this.promptCache = prompt;
    return prompt;
  }

  private async readPromptSlice(start: number, end: number): Promise<string> {
    if (this.promptCache !== undefined) {
      return this.promptCache.slice(start, end);
    }
    return this.env.docStore.readSlice(this.env.promptId, start, end);
  }

  async exec(dsl: DSL, step: number): Promise<string> {
    const stdout = await this.execInner(dsl);
    const stdoutMeta = makeStdoutMeta(
      stdout,
      this.env.scratch,
      this.metaPreviewChars,
    );
    this.env.trace.push({
      t: 'repl_exec',
      step,
      dsl,
      stdout,
      stdoutMeta,
    });
    return stdout;
  }

  private async execInner(dsl: DSL): Promise<string> {
    switch (dsl.op) {
      case 'prompt_meta': {
        const prompt = await this.readPromptAll();
        return JSON.stringify({
          promptId: this.env.promptId,
          length: prompt.length,
        });
      }

      case 'doc_parse': {
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('doc_parse.out must be non-empty string');
        }
        if (
          dsl.format !== undefined &&
          dsl.format !== 'auto' &&
          dsl.format !== 'text' &&
          dsl.format !== 'markdown' &&
          dsl.format !== 'csv'
        ) {
          throw new Error('doc_parse.format must be auto|text|markdown|csv');
        }
        if (dsl.delimiter !== undefined && typeof dsl.delimiter !== 'string') {
          throw new Error('doc_parse.delimiter must be string');
        }

        const prompt = await this.readPromptAll();
        consumePromptChars(this.env.budget, prompt.length);
        const doc = parseStructuredDocument(prompt, {
          format: dsl.format ?? 'auto',
          ...(dsl.delimiter !== undefined ? { delimiter: dsl.delimiter } : {}),
        });
        this.env.scratch[dsl.out] = doc;

        return JSON.stringify({
          out: dsl.out,
          format: doc.format,
          lineCount: doc.lineCount,
          sectionCount: doc.format === 'markdown' ? doc.sections.length : undefined,
          rowCount: doc.format === 'csv' ? doc.rows.length : undefined,
        });
      }

      case 'doc_select_section': {
        if (typeof dsl.in !== 'string' || dsl.in === '') {
          throw new Error('doc_select_section.in must be non-empty string');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('doc_select_section.out must be non-empty string');
        }
        if (typeof dsl.title !== 'string' || dsl.title === '') {
          throw new Error('doc_select_section.title must be non-empty string');
        }

        const source = this.env.scratch[dsl.in];
        if (!isStructuredDocument(source)) {
          throw new Error(`scratch.${dsl.in} is not a structured document`);
        }
        if (source.format !== 'markdown') {
          throw new Error(`scratch.${dsl.in} is not markdown document`);
        }
        const section = findMarkdownSection(source, dsl.title);
        if (section === undefined) {
          throw new Error(`markdown section not found: ${dsl.title}`);
        }
        this.env.scratch[dsl.out] = section.body;
        return JSON.stringify({
          out: dsl.out,
          title: section.title,
          level: section.level,
          length: section.body.length,
          preview: section.body.slice(0, 200),
        });
      }

      case 'doc_table_sum': {
        if (typeof dsl.in !== 'string' || dsl.in === '') {
          throw new Error('doc_table_sum.in must be non-empty string');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('doc_table_sum.out must be non-empty string');
        }
        if (typeof dsl.column !== 'number' && typeof dsl.column !== 'string') {
          throw new Error('doc_table_sum.column must be number|string');
        }

        const source = this.env.scratch[dsl.in];
        if (!isStructuredDocument(source)) {
          throw new Error(`scratch.${dsl.in} is not a structured document`);
        }
        if (source.format !== 'csv') {
          throw new Error(`scratch.${dsl.in} is not csv document`);
        }

        const columnIndex = resolveCsvColumnIndex(source, dsl.column);
        let sum = 0;
        let used = 0;
        for (const row of source.rows) {
          const raw = row[columnIndex];
          if (raw === undefined || raw.trim() === '') {
            continue;
          }
          const value = Number(raw);
          if (!Number.isFinite(value)) {
            continue;
          }
          sum += value;
          used += 1;
        }
        this.env.scratch[dsl.out] = String(sum);
        return JSON.stringify({
          out: dsl.out,
          sum,
          used,
          columnIndex,
        });
      }

      case 'doc_select_rows': {
        if (typeof dsl.in !== 'string' || dsl.in === '') {
          throw new Error('doc_select_rows.in must be non-empty string');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('doc_select_rows.out must be non-empty string');
        }
        if (typeof dsl.column !== 'number' && typeof dsl.column !== 'string') {
          throw new Error('doc_select_rows.column must be number|string');
        }
        const comparator = normalizeCsvComparator(dsl.comparator);
        const target = dsl.value ?? dsl.equals ?? null;
        if (
          target !== null &&
          typeof target !== 'string' &&
          typeof target !== 'number' &&
          typeof target !== 'boolean'
        ) {
          throw new Error('doc_select_rows.value/equals must be scalar');
        }

        const source = this.env.scratch[dsl.in];
        if (!isStructuredDocument(source)) {
          throw new Error(`scratch.${dsl.in} is not a structured document`);
        }
        if (source.format !== 'csv') {
          throw new Error(`scratch.${dsl.in} is not csv document`);
        }
        const columnIndex = resolveCsvColumnIndex(source, dsl.column);
        const filtered = filterCsvRows(source, dsl.column, {
          comparator,
          value: target,
        });
        this.env.scratch[dsl.out] = filtered;
        return JSON.stringify({
          out: dsl.out,
          rowCount: filtered.rows.length,
          columnIndex,
          comparator,
          expected: target,
        });
      }

      case 'doc_project_columns': {
        if (typeof dsl.in !== 'string' || dsl.in === '') {
          throw new Error('doc_project_columns.in must be non-empty string');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('doc_project_columns.out must be non-empty string');
        }
        if (!Array.isArray(dsl.columns) || dsl.columns.length === 0) {
          throw new Error('doc_project_columns.columns must be non-empty array');
        }
        if (dsl.separator !== undefined && typeof dsl.separator !== 'string') {
          throw new Error('doc_project_columns.separator must be string');
        }
        if (
          dsl.includeHeader !== undefined &&
          typeof dsl.includeHeader !== 'boolean'
        ) {
          throw new Error('doc_project_columns.includeHeader must be boolean');
        }

        const source = this.env.scratch[dsl.in];
        if (!isStructuredDocument(source)) {
          throw new Error(`scratch.${dsl.in} is not a structured document`);
        }
        if (source.format !== 'csv') {
          throw new Error(`scratch.${dsl.in} is not csv document`);
        }

        const separator = dsl.separator ?? ',';
        const projected = projectCsvColumns(source, dsl.columns);
        const lines = projected.rows.map((row) => row.join(separator));
        if (dsl.includeHeader) {
          lines.unshift(projected.headers.join(separator));
        }
        this.env.scratch[dsl.out] = lines;
        return JSON.stringify({
          out: dsl.out,
          count: lines.length,
          columns: projected.headers,
          firstLine: lines[0] ?? '',
        });
      }

      case 'slice_prompt': {
        if (!Number.isFinite(dsl.start) || !Number.isFinite(dsl.end)) {
          throw new Error('slice_prompt.start/end must be numbers');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('slice_prompt.out must be non-empty string');
        }
        const start = Math.max(0, dsl.start);
        const end = Math.max(start, dsl.end);
        consumePromptChars(this.env.budget, end - start);
        const value = await this.readPromptSlice(start, end);
        this.env.scratch[dsl.out] = value;
        return JSON.stringify({
          out: dsl.out,
          length: value.length,
          preview: value.slice(0, 200),
        });
      }

      case 'find': {
        if (typeof dsl.needle !== 'string') {
          throw new Error('find.needle must be string');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('find.out must be non-empty string');
        }
        const prompt = await this.readPromptAll();
        consumePromptChars(this.env.budget, prompt.length);
        const from = Math.max(0, dsl.from ?? 0);
        const hits: number[] = [];
        let cursor = from;
        while (cursor <= prompt.length) {
          const idx = prompt.indexOf(dsl.needle, cursor);
          if (idx < 0) {
            break;
          }
          hits.push(idx);
          cursor = idx + Math.max(1, dsl.needle.length);
        }
        this.env.scratch[dsl.out] = hits;
        return JSON.stringify({
          out: dsl.out,
          count: hits.length,
          firstHits: hits.slice(0, 8),
        });
      }

      case 'chunk_newlines': {
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('chunk_newlines.out must be non-empty string');
        }
        if (dsl.maxLines <= 0) {
          throw new Error('chunk_newlines.maxLines must be > 0');
        }
        const prompt = await this.readPromptAll();
        consumePromptChars(this.env.budget, prompt.length);
        const lines = prompt.split(/\r?\n/u);
        const chunks: string[] = [];
        for (let i = 0; i < lines.length; i += dsl.maxLines) {
          chunks.push(lines.slice(i, i + dsl.maxLines).join('\n'));
        }
        this.env.scratch[dsl.out] = chunks;
        return JSON.stringify({
          out: dsl.out,
          count: chunks.length,
          firstChunkPreview: (chunks[0] ?? '').slice(0, 200),
        });
      }

      case 'sum_csv_column': {
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('sum_csv_column.out must be non-empty string');
        }
        if (!Number.isFinite(dsl.column) || dsl.column < 0) {
          throw new Error('sum_csv_column.column must be >= 0');
        }
        const delimiter = dsl.delimiter ?? ',';
        const prompt = await this.readPromptAll();
        consumePromptChars(this.env.budget, prompt.length);
        const lines = prompt
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        let sum = 0;
        let used = 0;
        for (const line of lines) {
          const cols = line.split(delimiter).map((v) => v.trim());
          const raw = cols[dsl.column];
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

        this.env.scratch[dsl.out] = String(sum);
        return JSON.stringify({
          out: dsl.out,
          sum,
          used,
        });
      }

      case 'pick_word': {
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('pick_word.out must be non-empty string');
        }
        const requested = dsl.index ?? 1;
        if (!Number.isFinite(requested)) {
          throw new Error('pick_word.index must be finite');
        }
        const prompt = await this.readPromptAll();
        consumePromptChars(this.env.budget, prompt.length);

        const words = prompt
          .split(/[^\p{L}\p{N}_-]+/u)
          .map((word) => word.trim())
          .filter((word) => word.length > 0);
        if (words.length === 0) {
          this.env.scratch[dsl.out] = '';
          return JSON.stringify({ out: dsl.out, word: '', count: 0 });
        }

        const idx = Math.max(0, Math.min(Math.floor(requested), words.length - 1));
        const word = words[idx] ?? '';
        this.env.scratch[dsl.out] = word;
        return JSON.stringify({
          out: dsl.out,
          word,
          index: idx,
          count: words.length,
        });
      }

      case 'sub_map': {
        if (typeof dsl.in !== 'string' || dsl.in === '') {
          throw new Error('sub_map.in must be non-empty string');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('sub_map.out must be non-empty string');
        }
        if (typeof dsl.queryTemplate !== 'string') {
          throw new Error('sub_map.queryTemplate must be string');
        }
        const source = this.env.scratch[dsl.in];
        if (!Array.isArray(source)) {
          throw new Error(`scratch.${dsl.in} is not an array`);
        }
        const items = source.map((v) => String(v));
        const maxItems = Math.max(
          0,
          Math.min(dsl.limit ?? items.length, items.length),
        );
        const out: string[] = [];
        for (let i = 0; i < maxItems; i += 1) {
          const item = items[i] ?? '';
          const query = dsl.queryTemplate.replaceAll('{{item}}', item);
          const result = await this.hooks.subRLM(query, { prompt: item });
          out.push(result);
        }
        this.env.scratch[dsl.out] = out;
        return JSON.stringify({
          out: dsl.out,
          count: out.length,
          firstItemPreview: (out[0] ?? '').slice(0, 200),
        });
      }

      case 'reduce_join': {
        if (typeof dsl.in !== 'string' || dsl.in === '') {
          throw new Error('reduce_join.in must be non-empty string');
        }
        if (typeof dsl.out !== 'string' || dsl.out === '') {
          throw new Error('reduce_join.out must be non-empty string');
        }
        if (typeof dsl.sep !== 'string') {
          throw new Error('reduce_join.sep must be string');
        }
        const source = this.env.scratch[dsl.in];
        if (!Array.isArray(source)) {
          throw new Error(`scratch.${dsl.in} is not an array`);
        }
        const joined = source.map((v) => String(v)).join(dsl.sep);
        this.env.scratch[dsl.out] = joined;
        return JSON.stringify({
          out: dsl.out,
          length: joined.length,
          preview: joined.slice(0, 200),
        });
      }

      case 'set': {
        if (typeof dsl.path !== 'string' || dsl.path === '') {
          throw new Error('set.path must be non-empty string');
        }
        setByPath(this.env, dsl.path, dsl.value);
        return JSON.stringify({ path: dsl.path, ok: true });
      }

      case 'finalize': {
        if (
          this.requirePromptReadBeforeFinalize &&
          this.env.budget.promptReadCharsUsed <= 0
        ) {
          throw new Error('must read prompt before finalize');
        }
        if (typeof dsl.from === 'string' && dsl.from !== '') {
          const value = getScratchValue(this.env.scratch, dsl.from);
          if (value === undefined) {
            throw new Error(`scratch.${dsl.from} is undefined`);
          }
          this.env.final = String(value);
          return JSON.stringify({ finalLength: this.env.final.length });
        }

        // LLMが稀に {"op":"finalize","env":{"final":"..."}} を返すため互換吸収する。
        const fallback = extractFinalizeFallback(dsl as unknown);
        if (fallback === undefined) {
          throw new Error('finalize.from must be non-empty string');
        }
        this.env.final = String(fallback);
        return JSON.stringify({ finalLength: this.env.final.length });
      }

      default: {
        const never: never = dsl;
        throw new Error(`Unknown DSL op: ${(never as { op?: string }).op ?? ''}`);
      }
    }
  }
}

const normalizeCsvComparator = (
  input: unknown,
): 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' => {
  if (input === undefined) {
    return 'eq';
  }
  if (
    input === 'eq' ||
    input === 'contains' ||
    input === 'gt' ||
    input === 'gte' ||
    input === 'lt' ||
    input === 'lte'
  ) {
    return input;
  }
  throw new Error('doc_select_rows.comparator must be eq|contains|gt|gte|lt|lte');
};

const setByPath = (
  root: { scratch: Record<string, unknown>; final?: string },
  path: string,
  value: unknown,
): void => {
  if (path === 'final') {
    root.final = String(value ?? '');
    return;
  }

  const segs = path.split('.');
  if (segs.length === 0) {
    throw new Error('path is empty');
  }

  if (segs[0] === 'scratch') {
    segs.shift();
  }

  if (segs.length === 0) {
    throw new Error('path must target scratch.*');
  }

  let cursor: Record<string, unknown> = root.scratch;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const key = segs[i];
    if (key === undefined) {
      throw new Error('invalid path segment');
    }
    const next = cursor[key];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
      continue;
    }
    const created: Record<string, unknown> = {};
    cursor[key] = created;
    cursor = created;
  }

  const last = segs[segs.length - 1];
  if (last === undefined) {
    throw new Error('invalid path segment');
  }
  cursor[last] = value;
};

const extractFinalizeFallback = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const row = input as Record<string, unknown>;
  if (row.value !== undefined) {
    return row.value;
  }
  const env = row.env;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return undefined;
  }
  return (env as Record<string, unknown>).final;
};

const getScratchValue = (
  scratch: Record<string, unknown>,
  path: string,
): unknown => {
  const segs = path
    .split('.')
    .filter(Boolean)
    .filter((seg, index) => !(index === 0 && seg === 'scratch'));
  let cursor: unknown = scratch;
  for (const seg of segs) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
};
