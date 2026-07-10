import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('E2E harness contract', () => {
  it('keeps Playwright auth bypass gated by env and cookie', () => {
    const proxy = read('src/proxy.ts');
    const config = read('playwright.config.ts');
    const fixture = read('tests/e2e/fixtures/auth.ts');

    expect(proxy).toContain("process.env.PLAYWRIGHT_AUTH_BYPASS === '1'");
    expect(proxy).toContain('PLAYWRIGHT_AUTH_BYPASS_TOKEN');
    expect(proxy).toContain("request.cookies.get('clickmoji-e2e-auth')");
    expect(config).toContain('PLAYWRIGHT_AUTH_BYPASS=1');
    expect(config).toContain('PLAYWRIGHT_AUTH_BYPASS_TOKEN=e2e-auth-bypass');
    expect(fixture).toContain("E2E_AUTH_COOKIE = 'clickmoji-e2e-auth'");
    expect(fixture).toContain("E2E_AUTH_BYPASS_TOKEN = 'e2e-auth-bypass'");
  });

  it('exposes a no-database smoke command and CI step', () => {
    const packageJson = read('package.json');
    const ci = read('.github/workflows/ci.yml');
    const guide = read('TESTING_GUIDE.md');

    expect(packageJson).toContain(
      '"test:e2e:smoke": "playwright test --grep @smoke --project=chromium"'
    );
    expect(ci).toContain('npx playwright install --with-deps chromium');
    expect(ci).toContain('npm run test:e2e:smoke');
    expect(guide).toContain('npm run test:e2e:smoke');
    expect(guide).toContain('without requiring PostgreSQL');
  });

  it('does not redirect protected list pages while NextAuth session is loading', () => {
    const listPage = read('src/app/lists/[listId]/page.tsx');

    expect(listPage).toContain("status === 'loading'");
    expect(listPage).toContain('const { data: session, status } = useSession()');
  });
});
