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
- 外部注入シンボルを `call_symbol` で DSL から呼び出し可能
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

`constraints[].source` は `absolute | delta | ratio | delta_ratio` を使えます。
`ratio` は `metric / baseline`、`delta_ratio` は `(metric - baseline) / baseline` です。

### 共通ハーネス（一般化）

`flatbuffers` と `lint` の long-run スクリプト共通部分は、以下に切り出しています。

- `runLongRunProgram`:
  - long-run の実行サイクル（planner -> candidate 反復 -> report 出力）を共通化
- `createMetricSymbol`:
  - `metricKey` と `candidate` を受けて、評価関数を呼び、数値メトリクスを返す
  - candidate ごとのキャッシュにも対応
- `selectUntriedCandidates`:
  - 既に評価済みの candidate id を除外して次ラウンド候補を作る
- `parseCLIKeyValues` / `parsePlannerProvider` / `parsePositiveInt`:
  - CLI引数パースの共通化

## Plan Mode（追加）

既存エージェントと組み合わせる場合は `runPlannedRLM` で、

1. 入力を LLM で `RLMPlannerPlan` に変換  
2. plan に従って `runRLM` または `runLongImprovementLoop` を実行

できます。

```ts
import { runPlannedRLM, OpenAIProvider } from './src/index.ts';

const planner = new OpenAIProvider({ model: 'gpt-4.1-mini' });
const executor = new OpenAIProvider({ model: 'gpt-4.1-mini' });

const out = await runPlannedRLM({
  input: 'GitHub issue数を返して',
  prompt: 'ignored',
  plannerLLM: planner,
  executorLLM: executor,
  symbols: {
    github_open_issues: async () => 42,
  },
});

if (out.mode === 'single') {
  console.log(out.result.final);
}
```

### FlatBuffers で long-run を試す

```bash
pnpm flatbuffers:longrun
```

明示指定する場合:

```bash
pnpm node scripts/flatbuffers_long_run.ts \
  --planner-provider mock \
  --repo /Users/mz/ghq/github.com/google/flatbuffers \
  --candidate-limit 2 \
  --max-iterations 2 \
  --repetitions 2 \
  --out eval/report.flatbuffers.longrun.mock.json
```

長時間ラン（例: GitHub open issue を減らす）では `runLongImprovementLoop` を使います。

```ts
import {
  buildPolicyFromMetricSymbols,
  collectMetricSnapshotBySymbols,
  runLongImprovementLoop,
} from './src/index.ts';

const objectives = [
  {
    key: 'openIssues',
    direction: 'minimize' as const,
    read: async ({ state }: { state: { repo: string } }) =>
      getOpenIssues(state.repo),
  },
];
const policy = buildPolicyFromMetricSymbols({
  objectives,
  minScoreDelta: 1,
});

const report = await runLongImprovementLoop({
  baseline: { metrics: { openIssues: await getOpenIssues('mizchi/rlm-dspy') } },
  policy,
  initialState: { repo: 'mizchi/rlm-dspy' },
  maxIterations: 30,
  stopWhenNoAccept: true,
  generateCandidates: async () => proposeCandidatesFromAgent(),
  evaluate: async (candidate, ctx) =>
    collectMetricSnapshotBySymbols({
      candidate,
      iteration: ctx.iteration,
      state: ctx.state,
      objectives,
    }),
});
```

### Lint 修正で long-run を試す

```bash
pnpm lint:longrun -- \
  --repo /path/to/your/repo \
  --lint-command "pnpm exec eslint . --format json" \
  --test-command "pnpm test" \
  --candidate-limit 4 \
  --max-iterations 2 \
  --out eval/report.lint.longrun.json
```

候補を外部定義する場合（`--candidates-file`）:

```json
[
  {
    "id": "eslint-fix",
    "description": "default --fix",
    "commands": ["pnpm exec eslint . --fix"]
  },
  {
    "id": "eslint-fix-problem",
    "description": "problem only",
    "commands": ["pnpm exec eslint . --fix --fix-type problem"]
  }
]
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
