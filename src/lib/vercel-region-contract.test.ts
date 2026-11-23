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
  it('pins serverless functions to pdx1 and declares nothing else', () => {
    const config = readVercelJson();

    expect(config, 'vercel.json must exist and contain valid JSON').toBeDefined();
    expect(config).not.toBeNull();
    expect(typeof config).toBe('object');

    const record = config as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['$schema', 'regions']);
    expect(record.$schema).toBe('https://openapi.vercel.sh/vercel.json');
    expect(record.regions).toEqual(['pdx1']);
  });
});
