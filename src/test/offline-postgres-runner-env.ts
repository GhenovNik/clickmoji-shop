// Stub: the runner contract is pinned by offline-postgres-runner-env.test.ts. Implementation follows.

export function buildOfflinePrismaEnv(
  baseEnv: NodeJS.ProcessEnv,
  databaseUrl: string,
  schemaEngineBinary: string
): NodeJS.ProcessEnv {
  void databaseUrl;
  void schemaEngineBinary;
  return { ...baseEnv };
}

export function resolveLocalSchemaEngine(enginesDir: string): string {
  void enginesDir;
  return '';
}
