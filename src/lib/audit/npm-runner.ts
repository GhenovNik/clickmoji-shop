import { spawn, type ChildProcess } from 'node:child_process';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const NPM_TIMEOUT_MS = 120_000;
export const NPM_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const NPM_MAX_STDERR_BYTES = 4096;
export const FORCE_FINISH_GRACE_MS = 250;

export interface RunnerResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly overflow: boolean;
  readonly limitBytes: number;
  readonly outputBytes: number;
}

export type AuditRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
) => Promise<RunnerResult>;

export interface AuditConfigFiles {
  readonly userConfigPath: string;
  readonly globalConfigPath: string;
}

export type AuditScope = 'full' | 'production';

export interface SpawnRunnerOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly maxOutputBytes?: number;
}

export function buildAuditArgs(scope: AuditScope, files: AuditConfigFiles): string[] {
  const scopeArgs = scope === 'full' ? ['--include=dev'] : ['--omit=dev'];

  return [
    'audit',
    '--json',
    ...scopeArgs,
    '--include=optional',
    '--include=peer',
    '--offline=false',
    `--registry=${NPM_REGISTRY}`,
    `--userconfig=${files.userConfigPath}`,
    `--globalconfig=${files.globalConfigPath}`,
  ];
}

export function buildIsolatedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(base)) {
    if (key === 'NODE_ENV' || /^npm_config_/i.test(key)) {
      continue;
    }
    env[key] = value;
  }

  return env as NodeJS.ProcessEnv;
}

/** A grandchild can keep the stdout pipe open after the direct child is gone, so the whole group is killed. */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // the group is already gone, the direct child may still be left
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
}

function terminate(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    killProcessGroup(child);
  }
}

export function createNpmAuditRunner(options: SpawnRunnerOptions = {}): AuditRunner {
  const command = options.command ?? 'npm';
  const cwd = options.cwd;
  const maxOutputBytes = options.maxOutputBytes ?? NPM_MAX_OUTPUT_BYTES;

  return (args, env, timeoutMs) =>
    new Promise<RunnerResult>((resolve) => {
      let settled = false;
      let forceTimer: NodeJS.Timeout | null = null;
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let timedOut = false;
      let overflow = false;

      let child: ChildProcess;
      try {
        child = spawn(command, [...args], {
          env,
          cwd,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({
          status: null,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
          stdout: '',
          stderr: '',
          timedOut: false,
          overflow: false,
          limitBytes: maxOutputBytes,
          outputBytes: 0,
        });
        return;
      }

      const buildResult = (
        status: number | null,
        signal: string | null,
        error: Error | null
      ): RunnerResult => ({
        status,
        signal,
        error,
        stdout,
        stderr,
        timedOut,
        overflow,
        limitBytes: maxOutputBytes,
        outputBytes,
      });

      const finish = (result: RunnerResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (forceTimer !== null) {
          clearTimeout(forceTimer);
        }
        resolve(result);
      };

      /** The pipe can stay open in a grandchild that outlives the kill, so the streams are dropped. */
      const forceFinish = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(buildResult(child.exitCode, child.signalCode, null));
      };

      const terminate = (): void => {
        killProcessGroup(child);
        if (forceTimer === null) {
          forceTimer = setTimeout(forceFinish, FORCE_FINISH_GRACE_MS);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        outputBytes += Buffer.byteLength(chunk, 'utf8');
        if (outputBytes > maxOutputBytes) {
          overflow = true;
          terminate();
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < NPM_MAX_STDERR_BYTES) {
          stderr = `${stderr}${chunk}`.slice(0, NPM_MAX_STDERR_BYTES);
        }
      });
      child.on('error', (error: Error) => {
        finish(buildResult(null, null, error));
      });
      child.on('close', (status, signal) => {
        finish(buildResult(status, signal ?? null, null));
      });
    });
}
