# RLM/DSPLongRun セマンティクス（整理）

この文書は `src/improve/*.ts` 系の「指標駆動改善ループ」の意味論を固定するための仕様です。

## 1. スコア

- 目的関数は `objectives` の線形和。
- `direction=minimize` は符号反転（`-metric`）して加算。
- `direction=maximize` はそのまま加算。
- `weight` は正の実数を想定（未指定は `1`）。

式:

`score(snapshot) = Σ_i oriented(metric_i) * weight_i`

## 2. 制約

- 各 `constraints` は `comparator` で評価する。
- `source` は制約評価前の変換を定義する:
  - `absolute`: `target = metric`
  - `delta`: `target = metric - baseline`
  - `ratio`: `target = metric / baseline`
  - `delta_ratio`: `target = (metric - baseline) / baseline`
- `ratio` / `delta_ratio` で baseline が `0` の場合は `invalid_constraint_source`。

## 3. 判定理由（reasons）

- `metric_missing:<key>`: 必須メトリクス欠落
- `invalid_metric:<key>`: 非有限値
- `constraint_failed:<key>`: 制約不一致
- `gate_failed:<name>`: gate=false
- `invalid_snapshot`: snapshot 全体が無効
- `score_delta_too_small`: `score_delta < minScoreDelta`
- `evaluation_error`: 候補評価自体の失敗

`accepted` は `reasons.length == 0` のときのみ `true`。

## 4. 1ラウンド改善 (`run_improvement_loop`)

- 入力:
  - baseline snapshot
  - policy
  - candidates
  - evaluate(candidate, context)
- 各 candidate について:
  1. snapshot を得る
  2. `reasons` を計算
  3. スコア/差分を算出
  4. `accepted` を決定
- `best_accepted` は受理候補のうち最大スコア。

## 5. 長期改善 (`run_long_improvement_loop`)

- 各 iteration で候補集合を生成し、1ラウンド改善を実行。
- 受理候補があれば `best_accepted.snapshot` を新 baseline に更新。
- 受理候補が無く、`stopWhenNoAccept=true` なら終了。
- `generateCandidates` が空配列を返したら終了。

## 6. 候補選択ヘルパ (`select_untried_candidates`)

- 既出 candidate id を除外し、未試行から先頭 `candidate_limit` 件を返す。

## 7. 実行ハーネス (`run_program`)

- `ProgramPlan.mode`:
  - `single`: 1ラウンドだけ実行
  - `long_run`: 反復実行
- どちらのモードでも:
  - baseline ログ
  - ラウンド候補ログ
  - 候補ごとの accepted/rejected ログ
  - final baseline ログ
  を出力する。

- `long_run` は `run_long_improvement_loop` の停止条件に従う。
- `single` は `run_improvement_loop` 1回分の結果を `ProgramResult` に格納する。

## 8. MoonBit 版との対応

- TS: `src/improve/index.ts` -> MoonBit: `moonbit/src/improvement.mbt`
- TS: `src/improve/longRun.ts` -> MoonBit: `moonbit/src/long_run.mbt`
- TS: `src/improve/harness.ts` -> MoonBit: `moonbit/src/harness.mbt`
- TS: `src/improve/program.ts` -> MoonBit: `moonbit/src/program.mbt`

MoonBit 側は同じ意味論を、同期関数 + `Result` ベースで実装している。
