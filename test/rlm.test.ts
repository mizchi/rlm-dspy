import { describe, expect, test } from 'vitest';
import { BudgetExceeded } from '../src/budget/Budget.ts';
import { MockLLMProvider } from '../src/llm/MockLLMProvider.ts';
import { rlm } from '../src/index.ts';

const dsl = (v: unknown): string => JSON.stringify(v);

describe('rlm', () => {
  test('prompt本文を会話履歴に入れない', async () => {
    const prompt = 'SECRET-LONG-PROMPT-1234567890';
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'set', path: 'scratch.answer', value: 'ok' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
    });

    const out = await rlm(prompt, llm);

    expect(out.final).toBe('ok');
    for (const call of llm.calls) {
      for (const message of call.messages) {
        expect(message.content.includes(prompt)).toBe(false);
      }
    }
  });

  test('task はメタデータとして会話履歴に渡る', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'set', path: 'scratch.answer', value: 'ok' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
    });

    await rlm('prompt', llm, { task: 'beta を返す' });

    const firstUser = llm.calls[0]?.messages.find((m) => m.role === 'user');
    expect(firstUser).toBeDefined();
    expect(firstUser?.content.includes('beta を返す')).toBe(true);
  });

  test('maxSteps 超過で停止する', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [dsl({ op: 'set', path: 'scratch.tmp', value: 'x' })],
      },
      fallbackByDepth: {
        0: dsl({ op: 'set', path: 'scratch.tmp', value: 'x' }),
      },
    });

    await expect(
      rlm('p', llm, {
        budget: { maxSteps: 2 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
  });

  test('maxSubCalls 超過で停止する', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'chunk_newlines', maxLines: 1, out: 'chunks' }),
          dsl({ op: 'sub_map', in: 'chunks', queryTemplate: 'sum: {{item}}', out: 'parts' }),
        ],
        1: [
          dsl({ op: 'set', path: 'scratch.answer', value: 'sub' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
      fallbackByDepth: {
        0: dsl({ op: 'set', path: 'scratch.tmp', value: 'x' }),
        1: dsl({ op: 'finalize', from: 'answer' }),
      },
    });

    await expect(
      rlm('a\nb', llm, {
        budget: { maxSubCalls: 1 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
  });

  test('cache が効いて重複 subcall を抑制する', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'chunk_newlines', maxLines: 1, out: 'chunks' }),
          dsl({ op: 'sub_map', in: 'chunks', queryTemplate: 'sum: {{item}}', out: 'parts' }),
          dsl({ op: 'reduce_join', in: 'parts', sep: '|', out: 'joined' }),
          dsl({ op: 'finalize', from: 'joined' }),
        ],
        1: [
          dsl({ op: 'set', path: 'scratch.answer', value: 'sub' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
      fallbackByDepth: {
        1: dsl({ op: 'finalize', from: 'answer' }),
      },
    });

    const out = await rlm('dup\ndup', llm);

    expect(out.final).toBe('sub|sub');
    expect(llm.getCallCountByDepth(1)).toBe(2);
    expect(out.trace.some((e) => e.t === 'sub_call' && e.cached === true)).toBe(true);
  });

  test('trace が root_step/repl_exec/sub_call を記録する', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'chunk_newlines', maxLines: 1, out: 'chunks' }),
          dsl({ op: 'sub_map', in: 'chunks', queryTemplate: 'sum: {{item}}', out: 'parts', limit: 1 }),
          dsl({ op: 'reduce_join', in: 'parts', sep: '|', out: 'joined' }),
          dsl({ op: 'finalize', from: 'joined' }),
        ],
        1: [
          dsl({ op: 'set', path: 'scratch.answer', value: 'sub' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
    });

    const out = await rlm('x\ny', llm);

    expect(out.trace.some((e) => e.t === 'root_step')).toBe(true);
    expect(out.trace.some((e) => e.t === 'repl_exec')).toBe(true);
    expect(out.trace.some((e) => e.t === 'sub_call')).toBe(true);
  });

  test('不正DSL時はエラーメタを返して次ステップで回復できる', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'slice_prompt', start: 0, end: 1 }),
          dsl({ op: 'set', path: 'scratch.answer', value: 'ok' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
    });

    const out = await rlm('abc', llm, { budget: { maxSteps: 5 } });

    expect(out.final).toBe('ok');
    expect(llm.calls).toHaveLength(3);
  });

  test('ヒューリスティック後処理で TOKEN 値を補正できる', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'set', path: 'scratch.answer', value: 'wrong' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
    });

    const out = await rlm('header\nTOKEN=NEBULA-42\nfooter', llm, {
      task: 'TOKEN の値だけ返して',
      enableHeuristicPostprocess: true,
    });

    expect(out.final).toBe('NEBULA-42');
  });

  test('早期終了ヒューリスティックで set 後に即終了できる', async () => {
    const llm = new MockLLMProvider({
      scriptsByDepth: {
        0: [
          dsl({ op: 'set', path: 'scratch.answer', value: 'ok' }),
          dsl({ op: 'finalize', from: 'answer' }),
        ],
      },
    });

    const out = await rlm('prompt', llm, {
      enableEarlyStopHeuristic: true,
    });

    expect(out.final).toBe('ok');
    expect(llm.calls).toHaveLength(1);
  });
});
