import type { EvalCase, EvalMetric } from './types.ts';

const isMetric = (v: unknown): v is EvalMetric =>
  v === 'exact' || v === 'contains';

export const parseEvalJSONL = (input: string): EvalCase[] => {
  const lines = input.split(/\r?\n/u);
  const out: EvalCase[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i]?.trim() ?? '';
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new Error(
        `Invalid JSONL at line ${lineNo}: ${(cause as Error).message}`,
      );
    }

    out.push(validateEvalCase(parsed, lineNo));
  }

  return out;
};

const validateEvalCase = (input: unknown, lineNo: number): EvalCase => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`Line ${lineNo}: object required`);
  }

  const row = input as Record<string, unknown>;

  const id = toStringField(row, 'id', lineNo);
  const prompt = toStringField(row, 'prompt', lineNo);
  const query = toStringField(row, 'query', lineNo);
  const expected = toStringField(row, 'expected', lineNo);

  const metricRaw = row.metric;
  if (metricRaw !== undefined && !isMetric(metricRaw)) {
    throw new Error(`Line ${lineNo}: metric must be 'exact' or 'contains'`);
  }

  const tagsRaw = row.tags;
  if (
    tagsRaw !== undefined &&
    (!Array.isArray(tagsRaw) || tagsRaw.some((v) => typeof v !== 'string'))
  ) {
    throw new Error(`Line ${lineNo}: tags must be string[]`);
  }

  const budgetRaw = row.budget;
  if (
    budgetRaw !== undefined &&
    (typeof budgetRaw !== 'object' || budgetRaw === null || Array.isArray(budgetRaw))
  ) {
    throw new Error(`Line ${lineNo}: budget must be an object`);
  }

  const base: EvalCase = {
    id,
    prompt,
    query,
    expected,
  };

  if (metricRaw !== undefined) {
    base.metric = metricRaw;
  }
  if (tagsRaw !== undefined) {
    base.tags = tagsRaw as string[];
  }
  if (budgetRaw !== undefined) {
    base.budget = budgetRaw as NonNullable<EvalCase['budget']>;
  }

  return base;
};

const toStringField = (
  row: Record<string, unknown>,
  key: string,
  lineNo: number,
): string => {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Line ${lineNo}: ${key} must be string`);
  }
  return value;
};
