import { consumePromptChars } from '../budget/Budget.ts';
import { makeStdoutMeta } from '../trace/Trace.ts';
import type { DSL } from './DSL.ts';
import type { RLMEnv, SubRLMFn } from '../rlm/types.ts';

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

  constructor(env: RLMEnv, hooks: DSLReplHooks, options: DSLReplOptions = {}) {
    this.env = env;
    this.hooks = hooks;
    this.metaPreviewChars = options.metaPreviewChars ?? 200;
    this.requirePromptReadBeforeFinalize =
      options.requirePromptReadBeforeFinalize ?? false;
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
        return JSON.stringify({
          promptId: this.env.promptId,
          length: this.env.prompt.length,
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
        const value = this.env.prompt.slice(start, end);
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
        consumePromptChars(this.env.budget, this.env.prompt.length);
        const from = Math.max(0, dsl.from ?? 0);
        const hits: number[] = [];
        let cursor = from;
        while (cursor <= this.env.prompt.length) {
          const idx = this.env.prompt.indexOf(dsl.needle, cursor);
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
        consumePromptChars(this.env.budget, this.env.prompt.length);
        const lines = this.env.prompt.split(/\r?\n/u);
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
        consumePromptChars(this.env.budget, this.env.prompt.length);
        const lines = this.env.prompt
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
        consumePromptChars(this.env.budget, this.env.prompt.length);

        const words = this.env.prompt
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
