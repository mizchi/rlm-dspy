set shell := ["zsh", "-cu"]

default:
  @just --list

install:
  pnpm install

test:
  pnpm test

check:
  pnpm check

eval *args:
  pnpm node scripts/eval.ts {{args}}

ci: test check
