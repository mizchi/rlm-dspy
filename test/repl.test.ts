import { describe, expect, test } from 'vitest';
import { defaultBudget } from '../src/budget/Budget.ts';
import { DSLRepl } from '../src/repl/DSLRepl.ts';
import type { RLMEnv } from '../src/rlm/types.ts';
import { InMemoryDocStore } from '../src/doc/DocStore.ts';

const makeEnv = (prompt: string): RLMEnv => ({
  prompt,
  promptId: 'prompt-id',
  docStore: InMemoryDocStore.fromSingle('prompt-id', prompt),
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

  test('doc_parse + doc_select_section で Markdown セクションを抽出できる', async () => {
    const prompt = ['# Intro', 'hello', '', '## Data', 'alpha', 'beta', '', '# End', 'done'].join('\n');
    const env = makeEnv(prompt);
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'doc_parse', format: 'markdown', out: 'doc' }, 1);
    await repl.exec(
      { op: 'doc_select_section', in: 'doc', title: 'Data', out: 'picked' },
      2,
    );
    await repl.exec({ op: 'finalize', from: 'picked' }, 3);

    expect(env.final).toBe('alpha\nbeta');
    expect(env.budget.promptReadCharsUsed).toBe(prompt.length);
  });

  test('doc_parse + doc_table_sum で CSV のヘッダ列を合計できる', async () => {
    const prompt = ['name,score', 'alice,3', 'bob,5'].join('\n');
    const env = makeEnv(prompt);
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'doc_parse', format: 'csv', out: 'doc' }, 1);
    await repl.exec(
      { op: 'doc_table_sum', in: 'doc', column: 'score', out: 'total' },
      2,
    );
    await repl.exec({ op: 'finalize', from: 'total' }, 3);

    expect(env.final).toBe('8');
    expect(env.budget.promptReadCharsUsed).toBe(prompt.length);
  });

  test('doc_select_rows + doc_project_columns で条件行の列を抽出できる', async () => {
    const prompt = ['name,score,team', 'alice,3,a', 'bob,5,b', 'alice,7,c'].join('\n');
    const env = makeEnv(prompt);
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'doc_parse', format: 'csv', out: 'doc' }, 1);
    await repl.exec(
      { op: 'doc_select_rows', in: 'doc', column: 'name', equals: 'alice', out: 'rows' },
      2,
    );
    await repl.exec(
      { op: 'doc_project_columns', in: 'rows', columns: ['score'], out: 'scores' },
      3,
    );
    await repl.exec({ op: 'reduce_join', in: 'scores', sep: '|', out: 'answer' }, 4);
    await repl.exec({ op: 'finalize', from: 'answer' }, 5);

    expect(env.final).toBe('3|7');
    expect(env.budget.promptReadCharsUsed).toBe(prompt.length);
  });

  test('doc_select_rows で gt 比較ができる', async () => {
    const prompt = ['name,score', 'alice,3', 'bob,5', 'carol,7'].join('\n');
    const env = makeEnv(prompt);
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'doc_parse', format: 'csv', out: 'doc' }, 1);
    await repl.exec(
      {
        op: 'doc_select_rows',
        in: 'doc',
        column: 'score',
        comparator: 'gt',
        value: 4,
        out: 'rows',
      },
      2,
    );
    await repl.exec(
      { op: 'doc_project_columns', in: 'rows', columns: ['name'], out: 'names' },
      3,
    );
    await repl.exec({ op: 'reduce_join', in: 'names', sep: '|', out: 'answer' }, 4);
    await repl.exec({ op: 'finalize', from: 'answer' }, 5);

    expect(env.final).toBe('bob|carol');
  });

  test('doc_select_rows で contains 比較ができる', async () => {
    const prompt = ['name,note', 'alice,core-team', 'bob,contractor'].join('\n');
    const env = makeEnv(prompt);
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'doc_parse', format: 'csv', out: 'doc' }, 1);
    await repl.exec(
      {
        op: 'doc_select_rows',
        in: 'doc',
        column: 'note',
        comparator: 'contains',
        value: 'team',
        out: 'rows',
      },
      2,
    );
    await repl.exec(
      { op: 'doc_project_columns', in: 'rows', columns: ['name'], out: 'names' },
      3,
    );
    await repl.exec({ op: 'reduce_join', in: 'names', sep: '', out: 'answer' }, 4);
    await repl.exec({ op: 'finalize', from: 'answer' }, 5);

    expect(env.final).toBe('alice');
  });

  test('sub_map は concurrency 指定で並列実行しつつ順序を維持する', async () => {
    const env = makeEnv('a\nb\nc');
    let inflight = 0;
    let maxInflight = 0;
    const repl = new DSLRepl(env, {
      subRLM: async (_query, options) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inflight -= 1;
        return String(options?.prompt ?? '');
      },
    });

    await repl.exec({ op: 'chunk_newlines', maxLines: 1, out: 'chunks' }, 1);
    await repl.exec(
      {
        op: 'sub_map',
        in: 'chunks',
        queryTemplate: 'Q: {{item}}',
        out: 'mapped',
        concurrency: 2,
      },
      2,
    );

    expect(maxInflight).toBe(2);
    expect(env.scratch.mapped).toEqual(['a', 'b', 'c']);
  });

  test('chunk_tokens で単語数ベースに分割できる', async () => {
    const env = makeEnv('aa bb cc dd ee');
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec({ op: 'chunk_tokens', maxTokens: 2, out: 'chunks' } as never, 1);

    expect(env.scratch.chunks).toEqual(['aa bb', 'cc dd', 'ee']);
    expect(env.budget.promptReadCharsUsed).toBe('aa bb cc dd ee'.length);
  });

  test('chunk_tokens は overlap で前後文脈を重ねられる', async () => {
    const env = makeEnv('a b c d e');
    const repl = new DSLRepl(env, {
      subRLM: async () => 'unused',
    });

    await repl.exec(
      { op: 'chunk_tokens', maxTokens: 3, overlap: 1, out: 'chunks' } as never,
      1,
    );

    expect(env.scratch.chunks).toEqual(['a b c', 'c d e']);
  });
});
