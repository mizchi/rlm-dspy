# rlm/dspy Library Guide

This guide is for people using `rlm/dspy` as a library.

## 1. What this library does

`rlm/dspy` is a TypeScript runtime that implements the core ideas of RLM (Recursive Language Models).

The core model is:

1. Do not put the full document (`prompt`) into LLM chat history.
2. Ask the LLM to output exactly one JSON DSL action per step.
3. Execute data access, aggregation, and recursive calls locally in the REPL (`DSLRepl`).

This shifts document processing from free-form generation to controlled procedures.

## 2. Execution flow

1. Call `rlm(prompt, llm, opts)`.
2. `runRLM` asks the LLM for one JSON DSL action.
3. `DSLRepl` executes the action and updates `env.scratch`.
4. When `finalize` runs, `env.final` is set and execution ends.

Support features:

- Budget: limits steps, depth, and prompt reads.
- Trace: records per-step DSL/stdout metadata.
- Cache: suppresses duplicate sub-calls.

## 3. Minimal usage

```ts
import { rlm, OpenAIProvider, buildProfileRLMOptions } from './src/index.ts';

const llm = new OpenAIProvider({ model: 'gpt-4.1-mini' });
const profile = buildProfileRLMOptions('hybrid');

const prompt = 'name,score\nalice,3\nbob,5\ncarol,7';
const out = await rlm(prompt, llm, {
  ...profile,
  task: 'Return names whose score is greater than 4, joined by |',
  budget: {
    ...(profile.budget ?? {}),
    maxSteps: 20,
  },
});

console.log(out.final);
console.log(out.budget);
console.log(out.trace.slice(-5));
```

## 4. Main public APIs

From `src/index.ts`:

- Run:
  - `rlm(prompt, llm, opts)`
- LLM:
  - `OpenAIProvider`
  - `MockLLMProvider`
  - `LLMProvider` (interface)
- Budget:
  - `BudgetExceeded`
  - `BudgetState`
- DocStore:
  - `DocStore`
  - `InMemoryDocStore`
  - `MCPDocStore`
- Evaluation helpers:
  - `buildProfileRLMOptions('pure' | 'hybrid')`
  - `evaluateCases`

## 5. What it is good at

- Structured document tasks:
  - Extraction (`find`, `slice_prompt`, `doc_select_section`)
  - Aggregation (`doc_table_sum`, `sum_csv_column`)
  - Row filtering (`doc_select_rows` with `eq/contains/gt/gte/lt/lte`)
  - Projection (`doc_project_columns`)
  - Chunking (`chunk_newlines`, `chunk_tokens`)
  - Recursive map (`sub_map`, optional `concurrency`)

## 6. DocStore and MCP integration

You can swap the prompt backend using `RLMOptions.docStoreFactory`.

```ts
import { rlm, OpenAIProvider, MCPDocStore, buildProfileRLMOptions } from './src/index.ts';

const llm = new OpenAIProvider({ model: 'gpt-4.1-mini' });
const profile = buildProfileRLMOptions('hybrid');

const out = await rlm('doc://contracts/2026-01', llm, {
  ...profile,
  task: 'Return the body of the Data section',
  docStoreFactory: ({ prompt }) =>
    new MCPDocStore({
      readDocument: async ({ start, end }) => {
        // Replace with your MCP client call
        return readDocumentViaMcp({ docId: prompt, start, end });
      },
    }),
});
```

Notes:

- In the current API, `rlm(prompt, ...)` requires `prompt`.
- For external docs, using a document ID string as `prompt` is the simplest pattern.

## 7. Common errors and fixes

`BudgetExceeded: maxSteps`

- Meaning: step limit reached.
- Fix: increase `budget.maxSteps`.

`BudgetExceeded: maxSubCalls`

- Meaning: sub-call limit reached.
- Fix: increase `budget.maxSubCalls` or reduce `sub_map.limit`.

`must read prompt before finalize`

- Meaning: `requirePromptReadBeforeFinalize` is enabled but no read op was executed.
- Fix: run a read op first (`slice/find/doc_parse`).

## 8. Debugging basics

1. Inspect the tail of `out.trace`.
2. Check `root_step.stdoutMeta` and `repl_exec.dsl`.
3. For failures, check Budget and `stepsUsed`.

Example:

```ts
console.log(JSON.stringify(out.trace.slice(-10), null, 2));
```

## 9. Profile guidance

- `pure`:
  - no heuristics
  - useful for behavior comparison
- `hybrid`:
  - early-stop and postprocess heuristics enabled
  - better default for practical use

## 10. Current limitations

- This is a practical RLM prototype, not a fully general text generation framework.
- `chunk_tokens` is approximate (word-based), not model-exact token counting.
- MCP integration is abstracted via `DocStore`, but the real MCP server/client wiring is up to the user.
