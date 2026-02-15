export type DSL =
  | { op: 'prompt_meta' }
  | { op: 'slice_prompt'; start: number; end: number; out: string }
  | { op: 'find'; needle: string; from?: number; out: string }
  | { op: 'chunk_newlines'; maxLines: number; out: string }
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
      op: 'sub_map';
      in: string;
      queryTemplate: string;
      out: string;
      limit?: number;
    }
  | { op: 'reduce_join'; in: string; sep: string; out: string }
  | { op: 'set'; path: string; value: unknown }
  | { op: 'finalize'; from: string };
