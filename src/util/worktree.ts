import { rm } from 'node:fs/promises';

export interface RunCommandFn {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface DetachedWorktreeArgs {
  runCommand: RunCommandFn;
  repoDir: string;
  worktreeDir: string;
  ref?: string;
}

export const prepareDetachedWorktree = async (
  args: DetachedWorktreeArgs,
): Promise<void> => {
  await args
    .runCommand('git', [
      '-C',
      args.repoDir,
      'worktree',
      'remove',
      '--force',
      args.worktreeDir,
    ])
    .catch(() => {});
  await rm(args.worktreeDir, { recursive: true, force: true });
  await args.runCommand('git', [
    '-C',
    args.repoDir,
    'worktree',
    'add',
    '--detach',
    args.worktreeDir,
    args.ref ?? 'HEAD',
  ]);
};

export const cleanupDetachedWorktree = async (
  args: DetachedWorktreeArgs,
): Promise<void> => {
  await args
    .runCommand('git', [
      '-C',
      args.repoDir,
      'worktree',
      'remove',
      '--force',
      args.worktreeDir,
    ])
    .catch(() => {});
  await rm(args.worktreeDir, { recursive: true, force: true });
};
