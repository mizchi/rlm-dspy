export type DSL =
  | { op: 'prompt_meta' }
  | {
      op: 'doc_parse';
      format?: 'auto' | 'text' | 'markdown' | 'csv';
      delimiter?: string;
      out: string;
    }
  | {
      op: 'doc_select_section';
      in: string;
      title: string;
      out: string;
    }
  | {
      op: 'doc_table_sum';
      in: string;
      column: number | string;
      out: string;
    }
  | {
      op: 'doc_select_rows';
      in: string;
      column: number | string;
      comparator?: 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
      value?: string | number | boolean | null;
      equals?: string | number | boolean | null;
      out: string;
    }
  | {
      op: 'doc_project_columns';
      in: string;
      columns: (number | string)[];
      out: string;
      separator?: string;
      includeHeader?: boolean;
    }
  | { op: 'slice_prompt'; start: number; end: number; out: string }
  | { op: 'find'; needle: string; from?: number; out: string }
  | { op: 'chunk_newlines'; maxLines: number; out: string }
  | {
      op: 'chunk_tokens';
      maxTokens: number;
      overlap?: number;
      out: string;
    }
  | {
      op: 'sum_csv_column';
      column: number;
      delimiter?: string;
      out: string;
    }
  | {
      op: 'pick_word';
      index?: number;
      out: string;
    }
  | {
      op: 'call_symbol';
      symbol: string;
      out: string;
      args?: Record<string, unknown>;
      input?: unknown;
    }
  | {
      op: 'sub_map';
      in: string;
      queryTemplate: string;
      out: string;
      limit?: number;
      concurrency?: number;
    }
  | { op: 'reduce_join'; in: string; sep: string; out: string }
  | { op: 'set'; path: string; value: unknown }
  | { op: 'finalize'; from: string };
