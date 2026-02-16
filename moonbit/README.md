# rlm_dspy_moonbit

MoonBit port of core `improve/*` semantics from `rlm/dspy`.

## Scope

- `run_improvement_loop`: single-round candidate evaluation
- `run_long_improvement_loop`: iterative baseline update loop
- `run_program`: plan(`single` / `long_run`)に基づく実行ハーネス
- `select_untried_candidates`: tried-id filtering helper

The MoonBit port keeps the same acceptance/constraint semantics as the TypeScript implementation.

## Files

- `src/types.mbt`: semantic data model
- `src/improvement.mbt`: score + accept/reject semantics
- `src/long_run.mbt`: long-run iterative loop
- `src/harness.mbt`: candidate selection helper
- `src/program.mbt`: single/long_run統合ハーネス
- `src/public_api.mbt`: public constructors and accessors

## Commands

```bash
moon -C moonbit check
moon -C moonbit test
moon -C moonbit fmt
moon -C moonbit info
```
