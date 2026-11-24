// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOfflinePrismaEnv,
  resolveLocalSchemaEngine,
} from './offline-postgres-runner-env';

const DB_URL = 'postgresql://postgres@127.0.0.1:49999/legacy_locales_test';
const ENGINE = '/repo/node_modules/@prisma/engines/schema-engine-darwin-arm64';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeEnginesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'offline-prisma-env-'));
  tempDirs.push(dir);
  return dir;
}

describe('buildOfflinePrismaEnv', () => {
  it('disables the Prisma checkpoint call and pins the local schema engine', () => {
    const env = buildOfflinePrismaEnv({ PATH: '/usr/bin' }, DB_URL, ENGINE);

    expect(env.CHECKPOINT_DISABLE).toBe('1');
    expect(env.PRISMA_SCHEMA_ENGINE_BINARY).toBe(ENGINE);
  });

  it('points both database variables at the disposable loopback URL', () => {
    const env = buildOfflinePrismaEnv({ PATH: '/usr/bin' }, DB_URL, ENGINE);

    expect(env.DATABASE_URL).toBe(DB_URL);
    expect(env.INTEGRATION_DATABASE_URL).toBe(DB_URL);
  });

  it('overrides inherited checkpoint, engine and database values', () => {
    const env = buildOfflinePrismaEnv(
      {
        PATH: '/usr/bin',
        CHECKPOINT_DISABLE: '',
        PRISMA_SCHEMA_ENGINE_BINARY: '/elsewhere/schema-engine',
        DATABASE_URL: 'postgresql://example.invalid/other',
        INTEGRATION_DATABASE_URL: 'postgresql://example.invalid/other',
      },
      DB_URL,
      ENGINE
    );

    expect(env.CHECKPOINT_DISABLE).toBe('1');
    expect(env.PRISMA_SCHEMA_ENGINE_BINARY).toBe(ENGINE);
    expect(env.DATABASE_URL).toBe(DB_URL);
    expect(env.INTEGRATION_DATABASE_URL).toBe(DB_URL);
  });

  it('keeps unrelated inherited variables', () => {
    const env = buildOfflinePrismaEnv({ PATH: '/usr/bin', HOME: '/home/x' }, DB_URL, ENGINE);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
  });
});

describe('resolveLocalSchemaEngine', () => {
  it('returns the single schema-engine binary in the Prisma engines directory', () => {
    const dir = makeEnginesDir();
    writeFileSync(join(dir, 'schema-engine-darwin-arm64'), '');
    writeFileSync(join(dir, 'index.js'), '');

    expect(resolveLocalSchemaEngine(dir)).toBe(join(dir, 'schema-engine-darwin-arm64'));
  });

  it('fails closed without a download when no local schema engine exists', () => {
    const dir = makeEnginesDir();
    writeFileSync(join(dir, 'index.js'), '');

    expect(() => resolveLocalSchemaEngine(dir)).toThrow(/no local schema engine/i);
    expect(() => resolveLocalSchemaEngine(dir)).toThrow(/no download/i);
  });

  it('fails closed when the engines directory itself is missing', () => {
    const dir = join(makeEnginesDir(), 'absent');

    expect(() => resolveLocalSchemaEngine(dir)).toThrow(/no local schema engine/i);
  });

  it('ignores directories whose names look like engines', () => {
    const dir = makeEnginesDir();
    mkdirSync(join(dir, 'schema-engine-linux-musl'));

    expect(() => resolveLocalSchemaEngine(dir)).toThrow(/no local schema engine/i);
  });

  it('fails closed when more than one schema engine is present', () => {
    const dir = makeEnginesDir();
    writeFileSync(join(dir, 'schema-engine-darwin-arm64'), '');
    writeFileSync(join(dir, 'schema-engine-linux-musl'), '');

    expect(() => resolveLocalSchemaEngine(dir)).toThrow(/ambiguous|more than one/i);
  });
});
