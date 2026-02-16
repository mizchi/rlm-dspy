export type PlannerProvider = 'mock' | 'openai';

export const parseCLIKeyValues = (argv: string[]): Map<string, string> => {
  const kv = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) {
      continue;
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      kv.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      kv.set(key, next);
      i += 1;
    } else {
      kv.set(key, 'true');
    }
  }
  return kv;
};

export const parsePlannerProvider = (
  raw: string | undefined,
): PlannerProvider => {
  const plannerProvider = raw ?? 'mock';
  if (plannerProvider !== 'mock' && plannerProvider !== 'openai') {
    throw new Error(
      `--planner-provider must be mock|openai, got: ${plannerProvider}`,
    );
  }
  return plannerProvider;
};

export const parsePositiveInt = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid positive number: ${raw}`);
  }
  return Math.floor(n);
};
