export interface BudgetState {
  maxSteps: number;
  maxSubCalls: number;
  maxDepth: number;
  maxPromptReadChars: number;
  maxTimeMs: number;
  stepsUsed: number;
  subCallsUsed: number;
  depth: number;
  promptReadCharsUsed: number;
  startedAt: number;
}

type BudgetKind =
  | 'maxSteps'
  | 'maxSubCalls'
  | 'maxDepth'
  | 'maxPromptReadChars'
  | 'maxTimeMs';

export class BudgetExceeded extends Error {
  readonly kind: BudgetKind;
  readonly budget: BudgetState;

  constructor(kind: BudgetKind, budget: BudgetState, message?: string) {
    super(message ?? `Budget exceeded: ${kind}`);
    this.name = 'BudgetExceeded';
    this.kind = kind;
    this.budget = budget;
  }
}

const DEFAULT_BUDGET: Omit<BudgetState, 'startedAt'> = {
  maxSteps: 32,
  maxSubCalls: 32,
  maxDepth: 4,
  maxPromptReadChars: 200_000,
  maxTimeMs: 30_000,
  stepsUsed: 0,
  subCallsUsed: 0,
  depth: 0,
  promptReadCharsUsed: 0,
};

export const defaultBudget = (
  override: Partial<BudgetState> = {},
): BudgetState => ({
  ...DEFAULT_BUDGET,
  ...override,
  startedAt: override.startedAt ?? Date.now(),
});

export const ensureTimeBudget = (budget: BudgetState): void => {
  const elapsed = Date.now() - budget.startedAt;
  if (elapsed > budget.maxTimeMs) {
    throw new BudgetExceeded('maxTimeMs', budget);
  }
};

export const consumeRootStep = (budget: BudgetState): void => {
  ensureTimeBudget(budget);
  if (budget.stepsUsed + 1 > budget.maxSteps) {
    throw new BudgetExceeded('maxSteps', budget);
  }
  budget.stepsUsed += 1;
};

export const consumeSubCall = (budget: BudgetState): void => {
  ensureTimeBudget(budget);
  if (budget.subCallsUsed + 1 > budget.maxSubCalls) {
    throw new BudgetExceeded('maxSubCalls', budget);
  }
  budget.subCallsUsed += 1;
};

export const ensureNextDepth = (budget: BudgetState): void => {
  if (budget.depth + 1 > budget.maxDepth) {
    throw new BudgetExceeded('maxDepth', budget);
  }
};

export const consumePromptChars = (
  budget: BudgetState,
  chars: number,
): void => {
  if (chars <= 0) {
    return;
  }
  ensureTimeBudget(budget);
  if (budget.promptReadCharsUsed + chars > budget.maxPromptReadChars) {
    throw new BudgetExceeded('maxPromptReadChars', budget);
  }
  budget.promptReadCharsUsed += chars;
};
