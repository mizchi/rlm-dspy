export type DocFormat = 'text' | 'markdown' | 'csv';
export type ParseDocFormat = DocFormat | 'auto';

export interface ParseDocOptions {
  format?: ParseDocFormat;
  delimiter?: string;
}

interface StructuredDocumentBase {
  format: DocFormat;
  lineCount: number;
  rawLength: number;
}

export interface MarkdownSection {
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  body: string;
}

export interface MarkdownDocument extends StructuredDocumentBase {
  format: 'markdown';
  sections: MarkdownSection[];
}

export interface CsvDocument extends StructuredDocumentBase {
  format: 'csv';
  delimiter: string;
  headers: string[];
  rows: string[][];
}

export interface CsvProjection {
  headers: string[];
  rows: string[][];
  indices: number[];
}

export type CsvRowComparator =
  | 'eq'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface TextDocument extends StructuredDocumentBase {
  format: 'text';
  lines: string[];
}

export type StructuredDocument = MarkdownDocument | CsvDocument | TextDocument;

export const parseStructuredDocument = (
  prompt: string,
  options: ParseDocOptions = {},
): StructuredDocument => {
  const format = options.format ?? 'auto';
  const delimiter = options.delimiter ?? ',';

  switch (format) {
    case 'markdown':
      return parseMarkdown(prompt);
    case 'csv':
      return parseCsv(prompt, delimiter);
    case 'text':
      return parseText(prompt);
    case 'auto':
      return detectAndParse(prompt, delimiter);
    default:
      throw new Error(`unknown doc format: ${String(format)}`);
  }
};

export const isStructuredDocument = (input: unknown): input is StructuredDocument => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const row = input as Record<string, unknown>;
  if (typeof row.format !== 'string') {
    return false;
  }
  if (typeof row.lineCount !== 'number' || !Number.isFinite(row.lineCount)) {
    return false;
  }
  if (typeof row.rawLength !== 'number' || !Number.isFinite(row.rawLength)) {
    return false;
  }
  return row.format === 'text' || row.format === 'markdown' || row.format === 'csv';
};

export const findMarkdownSection = (
  doc: MarkdownDocument,
  title: string,
): MarkdownSection | undefined => {
  const exact = doc.sections.find((section) => section.title === title);
  if (exact !== undefined) {
    return exact;
  }
  const lowered = title.toLowerCase();
  return doc.sections.find((section) => section.title.toLowerCase() === lowered);
};

export const resolveCsvColumnIndex = (
  doc: CsvDocument,
  column: number | string,
): number => {
  if (typeof column === 'number') {
    if (!Number.isInteger(column) || column < 0) {
      throw new Error('doc_table_sum.column must be non-negative integer');
    }
    return column;
  }

  const exact = doc.headers.findIndex((header) => header === column);
  if (exact >= 0) {
    return exact;
  }
  const lowered = column.toLowerCase();
  const fuzzy = doc.headers.findIndex((header) => header.toLowerCase() === lowered);
  if (fuzzy >= 0) {
    return fuzzy;
  }

  throw new Error(`csv column not found: ${column}`);
};

export const filterCsvRows = (
  doc: CsvDocument,
  column: number | string,
  condition: {
    comparator?: CsvRowComparator;
    value: string | number | boolean | null;
  },
): CsvDocument => {
  const idx = resolveCsvColumnIndex(doc, column);
  const comparator = condition.comparator ?? 'eq';
  const expected = normalizeScalar(condition.value);
  const rows = doc.rows
    .filter((row) => compareScalar(normalizeScalar(row[idx] ?? ''), expected, comparator))
    .map((row) => [...row]);

  return {
    ...doc,
    rows,
  };
};

export const projectCsvColumns = (
  doc: CsvDocument,
  columns: readonly (number | string)[],
): CsvProjection => {
  if (columns.length === 0) {
    throw new Error('doc_project_columns.columns must be non-empty');
  }
  const indices = columns.map((column) => resolveCsvColumnIndex(doc, column));
  const headers = indices.map((idx) => doc.headers[idx] ?? `col${idx}`);
  const rows = doc.rows.map((row) => indices.map((idx) => row[idx] ?? ''));
  return { headers, rows, indices };
};

const detectAndParse = (prompt: string, delimiter: string): StructuredDocument => {
  if (looksLikeMarkdown(prompt)) {
    return parseMarkdown(prompt);
  }
  if (looksLikeCsv(prompt, delimiter)) {
    return parseCsv(prompt, delimiter);
  }
  return parseText(prompt);
};

const parseText = (prompt: string): TextDocument => {
  const lines = prompt.split(/\r?\n/u);
  return {
    format: 'text',
    lineCount: lines.length,
    rawLength: prompt.length,
    lines,
  };
};

const parseMarkdown = (prompt: string): MarkdownDocument => {
  const lines = prompt.split(/\r?\n/u);
  const headings = lines
    .map((line, index) => {
      const matched = line.match(/^(#{1,6})\s+(.+?)\s*$/u);
      if (matched === null) {
        return undefined;
      }
      const hashes = matched[1];
      const title = matched[2];
      if (hashes === undefined || title === undefined) {
        return undefined;
      }
      return { lineIndex: index, level: hashes.length, title: title.trim() };
    })
    .filter((row): row is { lineIndex: number; level: number; title: string } => row !== undefined);

  const sections: MarkdownSection[] = headings.map((heading, index) => {
    const endLineIndexExclusive =
      headings
        .slice(index + 1)
        .find((candidate) => candidate.level <= heading.level)?.lineIndex ??
      lines.length;

    const bodyLines = trimBlankEdges(lines.slice(heading.lineIndex + 1, endLineIndexExclusive));
    return {
      title: heading.title,
      level: heading.level,
      startLine: heading.lineIndex + 1,
      endLine: endLineIndexExclusive,
      body: bodyLines.join('\n'),
    };
  });

  return {
    format: 'markdown',
    lineCount: lines.length,
    rawLength: prompt.length,
    sections,
  };
};

const parseCsv = (prompt: string, delimiter: string): CsvDocument => {
  const lines = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const rows = lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));
  const [first, second] = rows;
  const hasHeaderByNumericHint =
    first !== undefined &&
    second !== undefined &&
    first.some((cell, index) => {
      const next = second[index];
      if (next === undefined) {
        return false;
      }
      return !looksNumeric(cell) && looksNumeric(next);
    });
  const hasHeaderByNameHint =
    first !== undefined &&
    second !== undefined &&
    first.length > 0 &&
    first.every((cell) => isLikelyHeaderCell(cell));
  const hasHeader = hasHeaderByNumericHint || hasHeaderByNameHint;

  const headers =
    hasHeader && first !== undefined
      ? first
      : Array.from({ length: first?.length ?? 0 }, (_, index) => `col${index}`);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return {
    format: 'csv',
    lineCount: lines.length,
    rawLength: prompt.length,
    delimiter,
    headers,
    rows: dataRows,
  };
};

const looksLikeMarkdown = (prompt: string): boolean =>
  prompt.split(/\r?\n/u).some((line) => /^(#{1,6})\s+.+$/u.test(line));

const looksLikeCsv = (prompt: string, delimiter: string): boolean => {
  const lines = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return false;
  }
  const counts = lines.map((line) => line.split(delimiter).length);
  const first = counts[0];
  if (first === undefined || first <= 1) {
    return false;
  }
  return counts.every((count) => count === first);
};

const looksNumeric = (input: string): boolean => {
  const normalized = input.trim();
  if (normalized.length === 0) {
    return false;
  }
  return Number.isFinite(Number(normalized));
};

const isLikelyHeaderCell = (input: string): boolean => {
  const normalized = input.trim();
  if (normalized.length === 0) {
    return false;
  }
  if (looksNumeric(normalized)) {
    return false;
  }
  return /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(normalized);
};

const normalizeScalar = (
  value: string | number | boolean | null,
): string => {
  if (value === null) {
    return '';
  }
  return String(value).trim();
};

const compareScalar = (
  actual: string,
  expected: string,
  comparator: CsvRowComparator,
): boolean => {
  switch (comparator) {
    case 'eq':
      return actual === expected;
    case 'contains':
      return actual.includes(expected);
    case 'gt':
      return compareNumeric(actual, expected, (a, b) => a > b);
    case 'gte':
      return compareNumeric(actual, expected, (a, b) => a >= b);
    case 'lt':
      return compareNumeric(actual, expected, (a, b) => a < b);
    case 'lte':
      return compareNumeric(actual, expected, (a, b) => a <= b);
    default:
      return false;
  }
};

const compareNumeric = (
  actual: string,
  expected: string,
  predicate: (a: number, b: number) => boolean,
): boolean => {
  const a = Number(actual);
  const b = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }
  return predicate(a, b);
};

const trimBlankEdges = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1;
  }
  return lines.slice(start, end);
};
