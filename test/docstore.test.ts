import { describe, expect, test } from 'vitest';
import { MCPDocStore } from '../src/doc/DocStore.ts';

describe('MCPDocStore', () => {
  test('readAll/readSlice で client.readDocument を呼べる', async () => {
    const calls: Array<{ docId: string; start?: number; end?: number }> = [];
    const store = new MCPDocStore({
      readDocument: async (args) => {
        calls.push(args);
        return `doc:${args.docId}:${args.start ?? 'all'}:${args.end ?? 'all'}`;
      },
    });

    const all = await store.readAll('d1');
    const part = await store.readSlice('d1', 2, 5);

    expect(all).toBe('doc:d1:all:all');
    expect(part).toBe('doc:d1:2:5');
    expect(calls).toEqual([
      { docId: 'd1' },
      { docId: 'd1', start: 2, end: 5 },
    ]);
  });
});
