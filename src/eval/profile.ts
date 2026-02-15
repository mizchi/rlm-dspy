import type { RLMOptions } from '../rlm/types.ts';

export type RLMProfile = 'pure' | 'hybrid';

export const parseRLMProfile = (input: string | undefined): RLMProfile => {
  if (input === undefined || input === '') {
    return 'hybrid';
  }
  if (input === 'pure' || input === 'hybrid') {
    return input;
  }
  throw new Error(`unknown profile: ${input}`);
};

export const buildProfileRLMOptions = (profile: RLMProfile): RLMOptions => {
  switch (profile) {
    case 'pure':
      return {
        llm: {
          temperature: 0,
        },
        enableHeuristicPostprocess: false,
        enableEarlyStopHeuristic: false,
        requirePromptReadBeforeFinalize: false,
        budget: {
          maxSteps: 6,
          maxSubCalls: 16,
          maxDepth: 4,
        },
        subBudget: {
          maxSteps: 3,
          maxSubCalls: 0,
        },
      };

    case 'hybrid':
      return {
        llm: {
          temperature: 0,
        },
        enableHeuristicPostprocess: true,
        enableEarlyStopHeuristic: true,
        maxConsecutiveErrorsForEarlyStop: 2,
        requirePromptReadBeforeFinalize: true,
        budget: {
          maxSteps: 6,
          maxSubCalls: 16,
          maxDepth: 4,
        },
        subBudget: {
          maxSteps: 3,
          maxSubCalls: 0,
        },
      };

    default: {
      const never: never = profile;
      throw new Error(`unreachable profile: ${String(never)}`);
    }
  }
};
