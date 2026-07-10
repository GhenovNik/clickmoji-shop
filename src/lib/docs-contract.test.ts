import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('documentation contract', () => {
  it('documents current AI route auth and service boundaries', () => {
    const api = read('docs/api.md');
    const architecture = read('docs/architecture.md');

    expect(api).toMatch(/POST \/api\/products\/smart-create`[\s\S]*Auth: signed in/);
    expect(api).toContain('does not self-call `/api/emoji/generate` or `/api/emoji/upload`');
    expect(api).toMatch(/POST \/api\/emoji\/generate`[\s\S]*Auth: admin/);
    expect(api).toMatch(/POST \/api\/emoji\/upload`[\s\S]*Auth: admin/);
    expect(architecture).not.toContain('AI routes do not yet have dedicated rate limits');
    expect(architecture).toContain('AI automation is routed through service modules');
  });

  it('keeps internal task identifiers out of public roadmap documentation', () => {
    const roadmap = read('docs/roadmap.md');

    expect(roadmap).not.toMatch(/AGE-\d+/);
    expect(roadmap).not.toContain('Linear');
    expect(roadmap).toContain('English-first localization');
  });
});
