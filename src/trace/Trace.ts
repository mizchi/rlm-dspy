import type { LLMUsage } from '../llm/LLMProvider.ts';

export interface PromptMeta {
  promptId: string;
  length: number;
  previewHead: string;
}

export interface StdoutMeta {
  length: number;
  preview: string;
  keys?: string[];
}

export type TraceEvent =
  | {
      t: 'root_step';
      step: number;
      promptMeta: PromptMeta;
      stdoutMeta: StdoutMeta;
      llmUsage?: LLMUsage;
    }
  | {
      t: 'repl_exec';
      step: number;
      dsl: unknown;
      stdout: string;
      stdoutMeta: StdoutMeta;
    }
  | {
      t: 'sub_call';
      depth: number;
      query: string;
      resultMeta: StdoutMeta;
      cached: boolean;
    };

const cut = (value: string, maxChars: number): string => {
  if (maxChars <= 0) {
    return '';
  }
  return value.slice(0, maxChars);
};

export const makePromptMeta = (
  promptId: string,
  prompt: string,
  maxChars: number,
): PromptMeta => ({
  promptId,
  length: prompt.length,
  previewHead: cut(prompt, maxChars),
});

export const makeStdoutMeta = (
  stdout: string,
  scratch: Record<string, unknown>,
  maxChars: number,
): StdoutMeta => ({
  length: stdout.length,
  preview: cut(stdout, maxChars),
  keys: Object.keys(scratch).slice(0, 16),
});
