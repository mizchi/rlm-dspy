# rlm/dspy

RLM (Recursive Language Models) の TypeScript 仮実装です。

利用者向けガイド:

- index: `docs/LIBRARY_GUIDE.md`
- 日本語: `docs/LIBRARY_GUIDE.ja.md`
- English: `docs/LIBRARY_GUIDE.en.md`

## 目的

- prompt 本文を LLM 履歴に入れず、REPL 環境に保持する
- LLM は JSON DSL を 1 ステップずつ返し、`env.final` で終了する
- 再帰 (`subRLM`)、Budget、Trace、評価パイプラインまでを動作させる

## 現在の設計

- `runRLM` で Root ループを実行
- `DSLRepl` が `doc_parse/doc_select_section/doc_table_sum/doc_select_rows/doc_project_columns` と `slice/find/chunk/sub_map/reduce_join/finalize` を実行
- `LLMProvider` 抽象 + `OpenAIProvider` / `MockLLMProvider`
- 文書I/Oは `DocStore` 抽象で差し替え可能（`InMemoryDocStore` / `MCPDocStore`）
- `response_format (json_schema)` を利用し、DSL 出力を強制
- 不正 DSL は `coerce` とエラーメタで回復
- 早期終了ヒューリスティック（評価時有効）

## 追加した実運用向け対策

- DSL coercion（軽微な非準拠 JSON を補正）
- `sum_csv_column` / `pick_word` など検証可能 op の追加
- `StructuredDocument` 層（Markdown/CSV/Text）を導入し、文書を構造化して再利用
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

## 構造化文書IR（追加）

- `doc_parse`:
  - `env.prompt` を `StructuredDocument`（`markdown` / `csv` / `text`）として scratch に載せる
- `doc_select_section`:
  - Markdown セクションをタイトルで抽出
- `doc_table_sum`:
  - CSV の列（index または header 名）を合計
- `doc_select_rows`:
  - CSV の条件一致行だけを絞り込む（列名/列index対応、`eq/contains/gt/gte/lt/lte`）
- `doc_project_columns`:
  - CSV から指定列だけを射影し、配列化して後段 (`reduce_join` など) で利用
- `chunk_tokens`:
  - 単語ベースの近似トークン分割（`maxTokens` と `overlap` 指定）
- `sub_map`:
  - `concurrency` 指定で subRLM 呼び出しを並列化（出力順は入力順を維持）

これにより、`slice/find` の都度全文スキャンではなく、1回の parse 後に構造アクセスを繰り返せる。

## DocStore 抽象

- `RLMOptions.docStoreFactory` で文書バックエンドを差し替え可能
- デフォルトは `InMemoryDocStore`
- MCP 経由で外部文書を読む場合は `MCPDocStore` 実装を利用

## 一般化可能性

- しやすい:
  - ルール/構造があるタスク（needle 検索、表形式集計、定型抽出）
- 追加設計が必要:
  - 自由記述生成・高い推論一貫性が必要なタスク

## 指標駆動の改善ループ（追加）

`runImprovementLoop` を使うと、次のようなタスクを同じパターンで扱えます。

- 実ベンチ指標を使ったリファクタリング候補の比較
- 大規模 lint 修正候補の採用/棄却（テスト失敗を制約でブロック）

```ts
import {
  runImprovementLoop,
  type ImprovementPolicy,
  type MetricSnapshot,
} from './src/index.ts';

const policy: ImprovementPolicy = {
  objectives: [
    { key: 'latencyP95', direction: 'minimize', weight: 1 },
    { key: 'throughput', direction: 'maximize', weight: 0.2 },
    { key: 'lintErrors', direction: 'minimize', weight: 2 },
  ],
  constraints: [{ key: 'testFailures', comparator: 'eq', value: 0 }],
  minScoreDelta: 1,
};

const baseline: MetricSnapshot = {
  metrics: {
    latencyP95: 120,
    throughput: 100,
    lintErrors: 80,
    testFailures: 0,
  },
};

const report = await runImprovementLoop({
  baseline,
  policy,
  candidates: [{ id: 'cand-a', input: '...' }, { id: 'cand-b', input: '...' }],
  evaluate: async (candidate) => {
    // ここで実際に benchmark/lint/test を実行して metrics を返す
    return {
      metrics: await collectMetricsForCandidate(candidate),
    };
  },
});

console.log(report.bestAccepted?.candidate.id);
```

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
pnpm eval:pure
```

### 2) OpenAI で実評価

```bash
export OPENAI_API_KEY=...
pnpm eval:openai
pnpm eval:openai:pure
```

詳細レポート保存:

```bash
pnpm node scripts/eval.ts \
  --provider openai \
  --model gpt-4.1-mini \
  --cases eval/cases.sample.jsonl \
  --profile hybrid \
  --out eval/report.json
```

### 3) アブレーション（pure vs hybrid）

```bash
pnpm eval:ablation
pnpm eval:ablation:openai
```

- `pure`: ヒューリスティック無し
- `hybrid`: 後処理・早期終了ヒューリスティック有り

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
