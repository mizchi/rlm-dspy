# rlm_dspy_moonbit

MoonBit port of `rlm/dspy` semantics (improvement loop + RLM runtime + planner/eval utility layer).

## Scope

- `run_improvement_loop`: single-round candidate evaluation
- `run_long_improvement_loop`: iterative baseline update loop
- `run_program`: plan(`single` / `long_run`)に基づく実行ハーネス
- `select_untried_candidates`: tried-id filtering helper
- `create_metric_symbol`: 外部評価関数を `call_symbol` 互換へ変換する helper
- `build_policy_from_metric_symbols`: symbol spec から policy を合成
- `collect_metric_snapshot_by_symbols`: symbol spec から snapshot を収集
- `run_rlm`: prompt本文を履歴外に置く最小RLMループ（DSL実行 + budget + trace）
- `run_rlm_from_json`: JSON文字列 DSL を coercion して実行（先頭 JSON 抽出付き）
- `run_rlm_with_provider`: `mizchi/llm` Provider で JSON DSL ループを駆動
- `run_rlm_with_openai`: `mizchi/llm/openai` を使って OpenAI 互換 API で実行
- `create_plan_with_provider`: planner LLM 出力(JSON)を plan へ coercion
- `run_planned_rlm_with_provider(s)`: planner + executor provider で plan 実行
- `run_planned_rlm_with_openai`: OpenAI で planner/executor をまとめて実行
- `coerce_planner_plan_from_json`: JSON plan を MoonBit plan 型へ coercion
- `compile_plan_to_rlm_options`: plan/profile/budget patch から実行 options を生成
- `run_planned_rlm`: plan mode(single/long_run) で実行
- `score_answer`: `exact/contains` 評価
- `parse_eval_jsonl`: JSONL ケースをパース
- `parse_rlm_profile` / `build_profile_rlm_options`: profile ユーティリティ

The MoonBit port keeps the same acceptance/constraint semantics as the TypeScript implementation.

## Files

- `src/types.mbt`: semantic data model
- `src/improvement.mbt`: score + accept/reject semantics
- `src/long_run.mbt`: long-run iterative loop
- `src/harness.mbt`: candidate selection helper
- `src/program.mbt`: single/long_run統合ハーネス
- `src/planner_types.mbt`: planner data model
- `src/planner.mbt`: plan coercion / compile / dispatch
- `src/rlm_types.mbt`: RLM runtime data model / DSL / options
- `src/rlm_run.mbt`: RLM runtime loop and DSL executor
- `src/openai_adapter.mbt`: `mizchi/llm` / OpenAI adapter
- `src/eval_types.mbt`: eval data model
- `src/eval_jsonl.mbt`: JSONL parser
- `src/eval_profile.mbt`: profile parser / option builder
- `src/eval_scoring.mbt`: answer scoring
- `src/rlm_wbtest.mbt`: RLM DSL/budget/doc/json-runner tests
- `src/public_api.mbt`: public constructors and accessors

## Commands

```bash
moon -C moonbit check
moon -C moonbit test
moon -C moonbit fmt
moon -C moonbit info
```

## OpenAI Adapter Example

```moonbit
let out = run_rlm_with_openai(
  "TOKEN=NEBULA-42",
  "sk-...",
  openai_options=default_rlm_openai_options(model="gpt-4.1-mini"),
)
```

```moonbit
let out = run_planned_rlm_with_openai(
  "CSVのscoreを最小化する候補を反復評価して",
  "name,score\nalice,3\nbob,5",
  "sk-...",
)
```
