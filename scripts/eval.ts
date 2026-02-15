import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateCases } from '../src/eval/evaluate.ts';
import { parseEvalJSONL } from '../src/eval/jsonl.ts';
import { buildProfileRLMOptions, parseRLMProfile } from '../src/eval/profile.ts';
import type { EvalCase } from '../src/eval/types.ts';
import { MockLLMProvider } from '../src/llm/MockLLMProvider.ts';
import { OpenAIProvider } from '../src/llm/OpenAIProvider.ts';

interface CLIArgs {
  provider: 'mock' | 'openai';
  casesPath: string;
  model: string;
  outPath?: string;
  profile: 'pure' | 'hybrid';
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadCases(args.casesPath);

  const report = await evaluateCases(cases, {
    providerFactory: (mode, evalCase) => makeProvider(args, mode, evalCase),
    rlmOptions: buildProfileRLMOptions(args.profile),
    baselineLLMOptions: {
      temperature: 0,
    },
  });

  printSummary(report);

  if (args.outPath !== undefined) {
    const outPath = resolve(args.outPath);
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`saved: ${outPath}`);
  }
};

const parseArgs = (argv: string[]): CLIArgs => {
  const kv = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const eqIndex = token.indexOf('=');
    if (eqIndex >= 0) {
      const k = token.slice(2, eqIndex);
      const v = token.slice(eqIndex + 1);
      kv.set(k, v);
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

  const providerRaw = kv.get('provider') ?? 'mock';
  if (providerRaw !== 'mock' && providerRaw !== 'openai') {
    throw new Error(`--provider must be mock|openai, got: ${providerRaw}`);
  }

  return {
    provider: providerRaw,
    casesPath: kv.get('cases') ?? 'eval/cases.sample.jsonl',
    model: kv.get('model') ?? 'gpt-4.1-mini',
    outPath: kv.get('out'),
    profile: parseRLMProfile(kv.get('profile')),
  };
};

const loadCases = async (casesPath: string): Promise<EvalCase[]> => {
  const text = await readFile(resolve(casesPath), 'utf8');
  const cases = parseEvalJSONL(text);
  if (cases.length === 0) {
    throw new Error(`no cases found: ${casesPath}`);
  }
  return cases;
};

const makeProvider = (
  args: CLIArgs,
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
        0: [
          JSON.stringify({ op: 'set', path: 'scratch.answer', value: evalCase.expected }),
          JSON.stringify({ op: 'finalize', from: 'answer' }),
        ],
      },
    });
  }

  return new OpenAIProvider({ model: args.model });
};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

const printSummary = (report: Awaited<ReturnType<typeof evaluateCases>>): void => {
  const s = report.summary;
  console.log('=== Eval Summary ===');
  console.log(`cases: ${s.totalCases}`);
  console.log(
    `baseline: ${s.baseline.correct}/${s.totalCases} (${pct(s.baseline.accuracy)}), calls=${s.baseline.usage.calls}, avgLatencyMs=${s.baseline.avgLatencyMs.toFixed(1)}`,
  );
  console.log(
    `rlm:      ${s.rlm.correct}/${s.totalCases} (${pct(s.rlm.accuracy)}), calls=${s.rlm.usage.calls}, avgLatencyMs=${s.rlm.avgLatencyMs.toFixed(1)}`,
  );
  console.log(`delta(rlm-baseline): ${(s.accuracyDelta * 100).toFixed(1)}pt`);

  for (const row of report.results) {
    console.log(
      `- ${row.caseId}: base=${row.baseline.correct ? 'ok' : 'ng'} rlm=${row.rlm.correct ? 'ok' : 'ng'}`,
    );
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
