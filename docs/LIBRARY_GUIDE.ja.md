# rlm/dspy ライブラリガイド

このガイドは、`rlm/dspy` を「ライブラリとして使う人」向けの説明です。

## 1. これは何をやっているライブラリか

`rlm/dspy` は、RLM (Recursive Language Models) の考え方を TypeScript で実装したランタイムです。

このライブラリの核心は次の3点です。

1. 大きい文書 (`prompt`) を LLM の会話履歴に直接入れない
2. LLM には「次に実行する JSON DSL 1ステップ」だけを出させる
3. 実データ参照・集約・再帰呼び出しはローカルの REPL (`DSLRepl`) 側で実行する

結果として、文書処理を「LLMの自由生成」ではなく「制御可能な手続き」に寄せられます。

## 2. 実行の流れ

1. `rlm(prompt, llm, opts)` を呼ぶ
2. `runRLM` が LLM に JSON DSL を要求する
3. `DSLRepl` が DSL を実行して `env.scratch` を更新する
4. `finalize` が実行されると `env.final` が確定して終了する

補助機能:

- Budget: 手数・再帰深さ・読み取り量を上限管理
- Trace: 各ステップの DSL / stdout メタデータを記録
- Cache: 重複 sub-call を抑制

## 3. 最小利用例

```ts
import { rlm, OpenAIProvider, buildProfileRLMOptions } from './src/index.ts';

const llm = new OpenAIProvider({ model: 'gpt-4.1-mini' });
const profile = buildProfileRLMOptions('hybrid');

const prompt = 'name,score\nalice,3\nbob,5\ncarol,7';
const out = await rlm(prompt, llm, {
  ...profile,
  task: 'score が 4 より大きい name を | 連結で返して',
  budget: {
    ...(profile.budget ?? {}),
    maxSteps: 20,
  },
});

console.log(out.final);
console.log(out.budget);
console.log(out.trace.slice(-5));
```

## 4. 主な公開API

`src/index.ts` から以下を利用できます。

- 実行:
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
- 評価支援:
  - `buildProfileRLMOptions('pure' | 'hybrid')`
  - `evaluateCases`
- 指標駆動改善:
  - `runImprovementLoop`
  - `scoreSnapshot`
  - `runLongImprovementLoop`
  - `buildPolicyFromMetricSymbols`
  - `collectMetricSnapshotBySymbols`
- Planner:
  - `createRLMPlan`
  - `runPlannedRLM`
  - `compilePlanToRLMOptions`

## 5. 何が得意か

- 構造がある文書処理:
  - 抽出 (`find`, `slice_prompt`, `doc_select_section`)
  - 集計 (`doc_table_sum`, `sum_csv_column`)
  - 行フィルタ (`doc_select_rows` with `eq/contains/gt/gte/lt/lte`)
  - 射影 (`doc_project_columns`)
  - 分割 (`chunk_newlines`, `chunk_tokens`)
  - 再帰 map (`sub_map`, `concurrency` 指定可)

## 6. DocStore と MCP 連携

`prompt` の読み取り元は `RLMOptions.docStoreFactory` で差し替えできます。

```ts
import { rlm, OpenAIProvider, MCPDocStore, buildProfileRLMOptions } from './src/index.ts';

const llm = new OpenAIProvider({ model: 'gpt-4.1-mini' });
const profile = buildProfileRLMOptions('hybrid');

const out = await rlm('doc://contracts/2026-01', llm, {
  ...profile,
  task: 'Data セクション本文を返して',
  docStoreFactory: ({ prompt }) =>
    new MCPDocStore({
      readDocument: async ({ start, end }) => {
        // あなたのMCPクライアント呼び出しに置き換える
        return readDocumentViaMcp({ docId: prompt, start, end });
      },
    }),
});
```

注記:

- 現在のAPIでは `rlm(prompt, ...)` の `prompt` は必須です
- 外部文書IDを使う場合は、上例のように `prompt` をID文字列として扱うのが簡単です

## 7. よくあるエラーと対処

`BudgetExceeded: maxSteps`

- 意味: ループ手数上限に達した
- 対処: `budget.maxSteps` を増やす

`BudgetExceeded: maxSubCalls`

- 意味: 再帰呼び出し数が上限超過
- 対処: `budget.maxSubCalls` を増やすか、`sub_map.limit` を下げる

`must read prompt before finalize`

- 意味: `requirePromptReadBeforeFinalize` が有効なのに文書未参照で終了しようとした
- 対処: `slice/find/doc_parse` などの読み取りopを先に実行する

## 8. デバッグの基本

1. まず `out.trace` の末尾を見る
2. `root_step` の `stdoutMeta` / `repl_exec` の `dsl` を確認する
3. エラー時は Budget と `stepsUsed` を見る

実行時に `trace` を直接表示する例:

```ts
console.log(JSON.stringify(out.trace.slice(-10), null, 2));
```

## 9. プロファイルの使い分け

- `pure`:
  - ヒューリスティックなし
  - 動作比較や素の挙動検証向け
- `hybrid`:
  - 早期終了・後処理ヒューリスティックあり
  - 実運用寄り

## 10. 現状の制約

- 本実装は RLM の実用プロトタイプであり、一般生成タスクで常に強いわけではない
- `chunk_tokens` は近似（単語分割ベース）で、モデル厳密トークン数ではない
- MCP連携は `DocStore` 抽象で対応可能だが、実際のMCPサーバ実装は利用者側で用意が必要

## 11. 実指標での改善ループ（refactor / lint 一般化）

`runImprovementLoop` は、候補ごとのメトリクスを採点して採用可否を返す共通ハーネスです。

- `objectives`: 最適化したい指標（`minimize` / `maximize`）
- `constraints`: 破ってはいけない制約（例: `testFailures == 0`）
- `minScoreDelta`: 採用に必要な最小改善量

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
  candidates: [{ id: 'cand-a', input: '...' }],
  evaluate: async (candidate) => {
    // 実際の benchmark/lint/test を走らせて数値化する
    return { metrics: await collectMetrics(candidate) };
  },
});

console.log(report.bestAccepted?.candidate.id);
```

## 12. 外部シンボル注入（DSL）と長時間ラン

`RLMOptions.symbols` に外部関数を注入すると、DSL の `call_symbol` から呼べます。

```ts
const out = await rlm('ignored', llm, {
  symbols: {
    github_open_issues: async () => 123,
  },
});
// LLM側DSL: {"op":"call_symbol","symbol":"github_open_issues","out":"issues"}
```

長時間で改善を回す場合は `runLongImprovementLoop` を使い、`minimize/maximize` 方向を維持しながら反復します。

## 13. Plan Mode（エージェント接続）

`runPlannedRLM` は、自然言語入力をいったん `RLMPlannerPlan` に落としてから実行に入るため、
既存エージェントの「計画フェーズ」と RLM ランタイムを接続しやすくします。

```ts
import { runPlannedRLM } from './src/index.ts';

const out = await runPlannedRLM({
  input: 'open issue を減らす方向で回したい',
  prompt: 'ignored',
  plannerLLM,
  symbols,
  longRun: {
    baseline: { metrics: { openIssues: 100 } },
    initialState: { repo: 'mizchi/rlm-dspy' },
    generateCandidates: async () => proposeCandidates(),
  },
});
```

FlatBuffers 実験用の実行スクリプト:

```bash
pnpm flatbuffers:longrun
```

Lint 修正の長時間ラン実行スクリプト:

```bash
pnpm lint:longrun -- \
  --repo /path/to/repo \
  --lint-command "pnpm exec eslint . --format json" \
  --test-command "pnpm test" \
  --candidate-limit 4 \
  --max-iterations 2 \
  --out eval/report.lint.longrun.json
```
