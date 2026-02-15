import type { EvalMetric } from './types.ts';

export const scoreAnswer = (
  expected: string,
  answer: string,
  metric: EvalMetric,
): boolean => {
  const exp = expected.trim();
  const act = answer.trim();

  if (metric === 'contains') {
    return act.includes(exp);
  }
  return act === exp;
};
