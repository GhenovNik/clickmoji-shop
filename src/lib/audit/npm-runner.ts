import { spawn, type ChildProcess } from 'node:child_process';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const NPM_TIMEOUT_MS = 120_000;
export const NPM_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface RunnerResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
  readonly stdout: string;
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

function terminate(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

export function createNpmAuditRunner(options: SpawnRunnerOptions = {}): AuditRunner {
  const command = options.command ?? 'npm';
  const maxOutputBytes = options.maxOutputBytes ?? NPM_MAX_OUTPUT_BYTES;

  return (args, env, timeoutMs) =>
    new Promise<RunnerResult>((resolve) => {
      let settled = false;
      let stdout = '';
      let outputBytes = 0;
      let timedOut = false;
      let overflow = false;

      let child: ChildProcess;
      try {
        child = spawn(command, [...args], {
          env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({
          status: null,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
          stdout: '',
          timedOut: false,
          overflow: false,
          limitBytes: maxOutputBytes,
          outputBytes: 0,
        });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, timeoutMs);

      const finish = (result: RunnerResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        outputBytes += Buffer.byteLength(chunk, 'utf8');
        if (outputBytes > maxOutputBytes) {
          overflow = true;
          terminate(child);
        }
      });
      child.stderr?.resume();
      child.on('error', (error: Error) => {
        finish({
          status: null,
          signal: null,
          error,
          stdout,
          timedOut,
          overflow,
          limitBytes: maxOutputBytes,
          outputBytes,
        });
      });
      child.on('close', (status, signal) => {
        finish({
          status,
          signal: signal ?? null,
          error: null,
          stdout,
          timedOut,
          overflow,
          limitBytes: maxOutputBytes,
          outputBytes,
        });
      });
    });
}
