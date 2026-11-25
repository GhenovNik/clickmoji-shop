import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Environment for the Prisma CLI run by the disposable PostgreSQL runner.
// - CHECKPOINT_DISABLE stops the CLI from calling checkpoint.prisma.io (telemetry).
// - PRISMA_SCHEMA_ENGINE_BINARY pins the schema engine already installed in node_modules,
//   so the CLI never falls back to a download from binaries.prisma.sh.
export function buildOfflinePrismaEnv(
  baseEnv: Record<string, string | undefined>,
  databaseUrl: string,
  schemaEngineBinary: string
): NodeJS.ProcessEnv {
  // NodeJS.ProcessEnv declares NODE_ENV as required; the child env only forwards what is set.
  const env = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  env.DATABASE_URL = databaseUrl;
  env.INTEGRATION_DATABASE_URL = databaseUrl;
  env.CHECKPOINT_DISABLE = '1';
  env.PRISMA_SCHEMA_ENGINE_BINARY = schemaEngineBinary;
  return env;
}

// Finds the single schema engine that `npm install` placed in the Prisma engines directory.
// Fails closed: a missing or ambiguous engine is an error, never a download.
export function resolveLocalSchemaEngine(enginesDir: string): string {
  let names: string[];
  try {
    names = readdirSync(enginesDir);
  } catch {
    names = [];
  }
  const candidates = names
    .filter((name) => name.startsWith('schema-engine-'))
    .map((name) => join(enginesDir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });

  if (candidates.length === 0) {
    throw new Error(
      `Offline PostgreSQL prerequisite failed: no local schema engine in "${enginesDir}" (no download will be attempted)`
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Offline PostgreSQL prerequisite failed: more than one local schema engine in "${enginesDir}" (ambiguous, no download will be attempted): ${candidates.join(', ')}`
    );
  }
  return candidates[0]!;
}
