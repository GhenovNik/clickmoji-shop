// Reproduces and verifies the six committed landing WebP assets under src/assets/landing/.
// Requires a running Clickmoji server with PLAYWRIGHT_AUTH_BYPASS=1 and PLAYWRIGHT_AUTH_BYPASS_TOKEN=e2e-auth-bypass.
// Example:
//   BASE_URL=http://127.0.0.1:3000 node scripts/generate-landing-screenshots.mjs --out-dir test-results/landing-provenance
// Pass --write to overwrite src/assets/landing/{ru,en}/*.webp instead of running in verify-only mode.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  E2E_AUTH_BYPASS_TOKEN,
  E2E_AUTH_COOKIE,
  LANDING_DEVICE_SCALE_FACTOR,
  LANDING_LOCALES,
  LANDING_VIEWPORT,
  captureLandingShowcaseLocale,
  setupLandingShowcaseMocks,
} from '../tests/e2e/fixtures/landing-showcase.mjs';

function parseArgs(argv) {
  let outDir = path.join(process.cwd(), 'test-results/landing-provenance');
  let writeAssets = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      writeAssets = true;
    } else if (arg === '--out-dir' && argv[i + 1]) {
      outDir = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    }
  }

  return { outDir, writeAssets };
}

async function main() {
  const { outDir, writeAssets } = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';
  const host = new URL(baseUrl).hostname;

  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined,
  });

  const manifest = [];

  try {
    for (const locale of LANDING_LOCALES) {
      const context = await browser.newContext({
        baseURL: baseUrl,
        locale: locale === 'ru' ? 'ru-RU' : 'en-US',
        viewport: LANDING_VIEWPORT,
        deviceScaleFactor: LANDING_DEVICE_SCALE_FACTOR,
        isMobile: true,
        hasTouch: true,
        serviceWorkers: 'block',
      });

      try {
        await context.addCookies([
          {
            name: E2E_AUTH_COOKIE,
            value: E2E_AUTH_BYPASS_TOKEN,
            domain: host,
            path: '/',
            httpOnly: true,
            sameSite: 'Lax',
          },
          {
            name: 'NEXT_LOCALE',
            value: locale,
            domain: host,
            path: '/',
          },
        ]);

        const page = await context.newPage();
        await setupLandingShowcaseMocks(page, locale, { authenticated: true });

        const results = await captureLandingShowcaseLocale(page, locale, {
          rootDir: process.cwd(),
        });

        for (const entry of results) {
          const localeOutDir = path.join(outDir, locale);
          mkdirSync(localeOutDir, { recursive: true });
          const pngFile = path.join(localeOutDir, `${entry.view}.png`);
          const webpFile = path.join(localeOutDir, `${entry.view}.webp`);
          writeFileSync(pngFile, entry.sourcePng.buffer);
          writeFileSync(webpFile, entry.capturedWebp.buffer);

          if (writeAssets) {
            writeFileSync(
              path.join(process.cwd(), entry.committedAsset.path),
              entry.capturedWebp.buffer
            );
          }

          manifest.push({
            locale: entry.locale,
            view: entry.view,
            route: entry.route,
            committedAsset: entry.committedAsset.path,
            committedSha256: entry.committedAsset.sha256,
            capturedSha256: entry.capturedWebp.sha256,
            sourcePngSha256: entry.sourcePng.sha256,
            byteIdentical: entry.byteIdentical,
            pixelComparison: entry.pixelComparison,
          });

          console.log(
            `${entry.committedAsset.path}: byteIdentical=${entry.byteIdentical} ` +
              `meanDiff=${entry.pixelComparison.meanChannelDiff} ` +
              `maxDiff=${entry.pixelComparison.maxChannelDiff} ` +
              `committed=${entry.committedAsset.sha256.slice(0, 12)} ` +
              `captured=${entry.capturedWebp.sha256.slice(0, 12)}`
          );
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
