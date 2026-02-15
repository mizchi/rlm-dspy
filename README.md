# rlm/dspy

RLM (Recursive Language Models) の TypeScript 仮実装です。

## 目的

- prompt 本文を LLM 履歴に入れず、REPL 環境に保持する
- LLM は JSON DSL を 1 ステップずつ返し、`env.final` で終了する
- 再帰 (`subRLM`)、Budget、Trace、評価パイプラインまでを動作させる

## 現在の設計

- `runRLM` で Root ループを実行
- `DSLRepl` が `slice/find/chunk/sub_map/reduce_join/finalize` などを実行
- `LLMProvider` 抽象 + `OpenAIProvider` / `MockLLMProvider`
- `response_format (json_schema)` を利用し、DSL 出力を強制
- 不正 DSL は `coerce` とエラーメタで回復
- 早期終了ヒューリスティック（評価時有効）

## 追加した実運用向け対策

- DSL coercion（軽微な非準拠 JSON を補正）
- `sum_csv_column` / `pick_word` など検証可能 op の追加
- `enableHeuristicPostprocess`（TOKEN 抽出 / CSV 合計 / 単語抽出）
- `enableEarlyStopHeuristic`（不要ステップ削減）
- OpenAI 呼び出しタイムアウト

## 検証結果（OpenAI, gpt-4.1-mini）

日付: 2026-02-15

最終設定（早期終了あり）での直近実行:

- baseline: `2/3` (66.7%), calls=3
- rlm: `3/3` (100.0%), calls=6
- delta: `+33.3pt`

保存レポート:

- `eval/report.openai.earlystop.json`

## このアプローチは正しいか

現段階では **方向性は妥当**。

- 妥当な点:
  - RLM の中核（prompt 本文を履歴外に置く）を維持
  - DSL + Budget + Trace で制御可能
  - 構造化タスク（抽出・検索・集計）に強い
- 注意点:
  - 現在は Pure RLM ではなく `RLM + task-specific ops + heuristics` のハイブリッド
  - 一般生成タスクへの直接一般化はまだ弱い

## 一般化可能性

- しやすい:
  - ルール/構造があるタスク（needle 検索、表形式集計、定型抽出）
- 追加設計が必要:
  - 自由記述生成・高い推論一貫性が必要なタスク

## セットアップ

```bash
pnpm install
pnpm test
pnpm check
```

## 評価実行

### 1) ローカル確認（mock）

```bash
pnpm eval
```

### 2) OpenAI で実評価

```bash
export OPENAI_API_KEY=...
pnpm eval:openai
```

詳細レポート保存:

```bash
pnpm node scripts/eval.ts \
  --provider openai \
  --model gpt-4.1-mini \
  --cases eval/cases.sample.jsonl \
  --out eval/report.json
```

## ケース形式（JSONL）

1行1ケース。

```json
{"id":"needle-1","prompt":"...","query":"...","expected":"...","metric":"exact"}
```

フィールド:

- `id`: ケースID
- `prompt`: 入力文書
- `query`: 質問
- `expected`: 期待解
- `metric`: `exact` または `contains`（省略時 `exact`）
- `budget`: RLM のケース別 budget 上書き（任意）
