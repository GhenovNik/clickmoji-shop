import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const vercelJsonPath = path.join(process.cwd(), 'vercel.json');

function readVercelJson(): unknown {
  try {
    return JSON.parse(readFileSync(vercelJsonPath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

describe('vercel.json region contract', () => {
  it('pins serverless functions to pdx1 and declares only regions and git settings', () => {
    const config = readVercelJson();

    expect(config, 'vercel.json must exist and contain valid JSON').toBeDefined();
    expect(config).not.toBeNull();
    expect(typeof config).toBe('object');

    const record = config as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['$schema', 'git', 'regions']);
    expect(record.$schema).toBe('https://openapi.vercel.sh/vercel.json');
    expect(record.regions).toEqual(['pdx1']);
  });

  // Operator decision of 2026-11-25: the free plan allows 100 builds a day; task branches build no preview, CI builds them.
  it('skips preview builds for task branches and keeps master and develop deploying', () => {
    const record = readVercelJson() as Record<string, unknown>;
    const git = record.git as { deploymentEnabled?: Record<string, unknown> };
    expect(Object.keys(git)).toEqual(['deploymentEnabled']);
    const enabled = git.deploymentEnabled ?? {};
    for (const prefix of ['feature', 'fix', 'chore', 't3', 'dependabot']) {
      expect(enabled[`${prefix}/**`], `${prefix}/** previews off`).toBe(false);
    }
    expect(Object.values(enabled).every((value) => value === false)).toBe(true);
    for (const key of Object.keys(enabled)) {
      expect(key.endsWith('/**'), `${key} names a branch prefix, never master or develop`).toBe(
        true
      );
    }
  });
});
