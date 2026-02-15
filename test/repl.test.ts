import { describe, expect, test } from 'vitest';
import { defaultBudget } from '../src/budget/Budget.ts';
import { DSLRepl } from '../src/repl/DSLRepl.ts';
import type { RLMEnv } from '../src/rlm/types.ts';

const makeEnv = (prompt: string): RLMEnv => ({
  prompt,
  promptId: 'prompt-id',
  scratch: {},
  cache: new Map(),
  budget: defaultBudget(),
  trace: [],
});

describe('DSLRepl', () => {
  test('slice/find/set/finalize が動く', async () => {
    const env = makeEnv('alpha\nbeta\ngamma');
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'find', needle: 'beta', out: 'hits' }, 1);
    await repl.exec({ op: 'slice_prompt', start: 6, end: 10, out: 'word' }, 2);
    await repl.exec({ op: 'set', path: 'scratch.answer', value: 'done' }, 3);
    await repl.exec({ op: 'finalize', from: 'answer' }, 4);

    expect(env.scratch.hits).toEqual([6]);
    expect(env.scratch.word).toBe('beta');
    expect(env.final).toBe('done');
  });

  test('chunk_newlines/sub_map/reduce_join が動く', async () => {
    const env = makeEnv('a\nb\nc');
    const repl = new DSLRepl(env, {
      subRLM: async (query, options) => `${query}|${options?.prompt}`,
    });

    await repl.exec({ op: 'chunk_newlines', maxLines: 1, out: 'chunks' }, 1);
    await repl.exec(
      {
        op: 'sub_map',
        in: 'chunks',
        queryTemplate: 'Q: {{item}}',
        out: 'mapped',
      },
      2,
    );
    await repl.exec({ op: 'reduce_join', in: 'mapped', sep: '\n', out: 'joined' }, 3);

    expect(env.scratch.chunks).toEqual(['a', 'b', 'c']);
    expect(env.scratch.mapped).toEqual([
      'Q: a|a',
      'Q: b|b',
      'Q: c|c',
    ]);
    expect(env.scratch.joined).toContain('Q: b|b');
  });

  test('sum_csv_column で列合計を計算できる', async () => {
    const env = makeEnv('apple,3\nbanana,4\ncherry,2');
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'sum_csv_column', column: 1, delimiter: ',', out: 'total' }, 1);
    await repl.exec({ op: 'finalize', from: 'total' }, 2);

    expect(env.scratch.total).toBe('9');
    expect(env.final).toBe('9');
  });

  test('pick_word で単語抽出できる', async () => {
    const env = makeEnv('alpha beta gamma');
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'pick_word', index: 1, out: 'picked' }, 1);
    await repl.exec({ op: 'finalize', from: 'picked' }, 2);

    expect(env.scratch.picked).toBe('beta');
    expect(env.final).toBe('beta');
  });

  test('finalize が env.final 形式でも動く', async () => {
    const env = makeEnv('ignored');
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    const compat = { op: 'finalize', env: { final: 'compat' } } as unknown as Parameters<typeof repl.exec>[0];
    await repl.exec(compat, 1);

    expect(env.final).toBe('compat');
  });

  test('finalize が scratch. 接頭辞つき from を受け取れる', async () => {
    const env = makeEnv('ignored');
    env.scratch.answer = 'ok';
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'finalize', from: 'scratch.answer' }, 1);
    expect(env.final).toBe('ok');
  });
});
