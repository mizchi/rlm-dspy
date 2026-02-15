import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateCases } from '../src/eval/evaluate.ts';
import { parseEvalJSONL } from '../src/eval/jsonl.ts';
import { buildProfileRLMOptions, parseRLMProfile, type RLMProfile } from '../src/eval/profile.ts';
import type { EvalCase, EvalReport } from '../src/eval/types.ts';
import { MockLLMProvider } from '../src/llm/MockLLMProvider.ts';
import { OpenAIProvider } from '../src/llm/OpenAIProvider.ts';

interface CLIArgs {
  provider: 'mock' | 'openai';
  casesPath: string;
  model: string;
  runs: number;
  profiles: RLMProfile[];
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadCases(args.casesPath);

  const reportsByProfile = new Map<RLMProfile, EvalReport[]>();
  for (const profile of args.profiles) {
    reportsByProfile.set(profile, []);
  }

  for (let run = 1; run <= args.runs; run += 1) {
    for (const profile of args.profiles) {
      const report = await evaluateCases(cases, {
        providerFactory: (mode, evalCase) =>
          makeProvider(args, profile, mode, evalCase),
        baselineLLMOptions: {
          temperature: 0,
        },
        rlmOptions: buildProfileRLMOptions(profile),
      });
      reportsByProfile.get(profile)?.push(report);
      printRunSummary(run, profile, report);
    }
  }

  printAggregateSummary(reportsByProfile, args.runs);
};

const parseArgs = (argv: string[]): CLIArgs => {
  const kv = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const eq = token.indexOf('=');
    if (eq >= 0) {
      kv.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      kv.set(key, next);
      i += 1;
    } else {
      kv.set(key, 'true');
    }
  }

  const provider = kv.get('provider') ?? 'mock';
  if (provider !== 'mock' && provider !== 'openai') {
    throw new Error(`--provider must be mock|openai, got: ${provider}`);
  }

  const runs = Number(kv.get('runs') ?? '1');
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`--runs must be positive integer, got: ${runs}`);
  }

  const profilesRaw = kv.get('profiles') ?? 'pure,hybrid';
  const profiles = profilesRaw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => parseRLMProfile(v));

  return {
    provider,
    casesPath: kv.get('cases') ?? 'eval/cases.sample.jsonl',
    model: kv.get('model') ?? 'gpt-4.1-mini',
    runs,
    profiles,
  };
};

const loadCases = async (casesPath: string): Promise<EvalCase[]> => {
  const text = await readFile(resolve(casesPath), 'utf8');
  return parseEvalJSONL(text);
};

const makeProvider = (
  args: CLIArgs,
  profile: RLMProfile,
  mode: 'baseline' | 'rlm',
  evalCase: EvalCase,
) => {
  if (args.provider === 'mock') {
    if (mode === 'baseline') {
      return new MockLLMProvider({
        scriptsByDepth: {
          0: [evalCase.expected],
        },
      });
    }

    return new MockLLMProvider({
      scriptsByDepth: {
        0:
          profile === 'hybrid'
            ? [
                JSON.stringify({
                  op: 'slice_prompt',
                  start: 0,
                  end: 1,
                  out: 'probe',
                }),
                JSON.stringify({
                  op: 'set',
                  path: 'scratch.answer',
                  value: evalCase.expected,
                }),
                JSON.stringify({ op: 'finalize', from: 'answer' }),
              ]
            : [
                JSON.stringify({
                  op: 'set',
                  path: 'scratch.answer',
                  value: evalCase.expected,
                }),
                JSON.stringify({ op: 'finalize', from: 'answer' }),
              ],
      },
    });
  }

  return new OpenAIProvider({ model: args.model });
};

const printRunSummary = (run: number, profile: RLMProfile, report: EvalReport): void => {
  const s = report.summary;
  console.log(
    `[run=${run}] profile=${profile} baseline=${pct(s.baseline.accuracy)} rlm=${pct(s.rlm.accuracy)} calls=${s.rlm.usage.calls} avgMs=${s.rlm.avgLatencyMs.toFixed(1)}`,
  );
};

const printAggregateSummary = (
  reportsByProfile: Map<RLMProfile, EvalReport[]>,
  runs: number,
): void => {
  console.log('=== Ablation Summary ===');
  for (const [profile, reports] of reportsByProfile) {
    const rlmAcc = mean(reports.map((r) => r.summary.rlm.accuracy));
    const rlmCalls = mean(reports.map((r) => r.summary.rlm.usage.calls));
    const rlmMs = mean(reports.map((r) => r.summary.rlm.avgLatencyMs));
    const baseAcc = mean(reports.map((r) => r.summary.baseline.accuracy));
    const delta = rlmAcc - baseAcc;

    console.log(
      `${profile}: runs=${runs} acc=${pct(rlmAcc)} delta=${(delta * 100).toFixed(1)}pt calls=${rlmCalls.toFixed(1)} avgMs=${rlmMs.toFixed(1)}`,
    );
  }
};

const mean = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
