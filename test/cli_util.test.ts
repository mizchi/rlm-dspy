import { describe, expect, test } from 'vitest';
import {
  parseCLIKeyValues,
  parsePlannerProvider,
  parsePositiveInt,
} from '../src/util/cli.ts';

describe('cli util', () => {
  test('parseCLIKeyValues は --k=v と --k v を扱える', () => {
    const kv = parseCLIKeyValues([
      '--planner-provider=mock',
      '--max-iterations',
      '3',
      '--flag',
    ]);
    expect(kv.get('planner-provider')).toBe('mock');
    expect(kv.get('max-iterations')).toBe('3');
    expect(kv.get('flag')).toBe('true');
  });

  test('parsePlannerProvider は mock/openai のみ許可する', () => {
    expect(parsePlannerProvider('mock')).toBe('mock');
    expect(parsePlannerProvider('openai')).toBe('openai');
    expect(() => parsePlannerProvider('x')).toThrowError(
      /--planner-provider must be mock\|openai/,
    );
  });

  test('parsePositiveInt は正整数を返し不正値は例外', () => {
    expect(parsePositiveInt('3', 1)).toBe(3);
    expect(parsePositiveInt(undefined, 2)).toBe(2);
    expect(() => parsePositiveInt('0', 1)).toThrowError(/invalid positive number/);
    expect(() => parsePositiveInt('x', 1)).toThrowError(/invalid positive number/);
  });
});
