import { describe, expect, test } from 'vitest';
import { buildProfileRLMOptions, parseRLMProfile } from '../src/eval/profile.ts';

describe('eval profile', () => {
  test('parseRLMProfile', () => {
    expect(parseRLMProfile('pure')).toBe('pure');
    expect(parseRLMProfile('hybrid')).toBe('hybrid');
    expect(parseRLMProfile(undefined)).toBe('hybrid');
  });

  test('pure は heuristic を無効化する', () => {
    const opts = buildProfileRLMOptions('pure');
    expect(opts.enableHeuristicPostprocess).toBe(false);
    expect(opts.enableEarlyStopHeuristic).toBe(false);
    expect(opts.requirePromptReadBeforeFinalize).toBe(false);
  });

  test('hybrid は heuristic と early stop を有効化する', () => {
    const opts = buildProfileRLMOptions('hybrid');
    expect(opts.enableHeuristicPostprocess).toBe(true);
    expect(opts.enableEarlyStopHeuristic).toBe(true);
    expect(opts.requirePromptReadBeforeFinalize).toBe(true);
  });
});
