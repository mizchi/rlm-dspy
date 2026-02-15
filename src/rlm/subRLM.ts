import { consumeSubCall, ensureNextDepth } from '../budget/Budget.ts';
import { makeStdoutMeta } from '../trace/Trace.ts';
import { hashString } from '../util/hash.ts';
import type { RunChildRLM, RLMEnv, SubRLMFn } from './types.ts';

export const createSubRLMRunner = (args: {
  env: RLMEnv;
  runChild: RunChildRLM;
  metaPreviewChars: number;
}): SubRLMFn => {
  const { env, runChild, metaPreviewChars } = args;

  return async (query, options) => {
    const subPrompt = options?.prompt ?? env.prompt;
    const cacheKey = hashString(
      JSON.stringify({
        promptId: env.promptId,
        query,
        subPrompt,
        options: options ?? {},
      }),
    );

    const cached = env.cache.get(cacheKey);
    if (cached !== undefined) {
      env.trace.push({
        t: 'sub_call',
        depth: env.budget.depth + 1,
        query,
        resultMeta: makeStdoutMeta(cached, {}, metaPreviewChars),
        cached: true,
      });
      return cached;
    }

    ensureNextDepth(env.budget);
    consumeSubCall(env.budget);

    const final =
      options === undefined
        ? await runChild({ prompt: subPrompt, query })
        : await runChild({ prompt: subPrompt, query, options });
    env.cache.set(cacheKey, final);

    env.trace.push({
      t: 'sub_call',
      depth: env.budget.depth + 1,
      query,
      resultMeta: makeStdoutMeta(final, {}, metaPreviewChars),
      cached: false,
    });

    return final;
  };
};
