import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  E2E_AUTH_BYPASS_TOKEN,
  E2E_AUTH_COOKIE,
  LANDING_DEVICE_SCALE_FACTOR,
  LANDING_LOCALES,
  LANDING_VIEWPORT,
  captureLandingShowcaseLocale,
  setupLandingShowcaseMocks,
} from './fixtures/landing-showcase.mjs';

for (const locale of LANDING_LOCALES) {
  test(`captures and converts landing showcase source screens in ${locale} @smoke`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: 'http://localhost:3000',
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
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: 'NEXT_LOCALE',
          value: locale,
          domain: 'localhost',
          path: '/',
        },
      ]);

      const page = await context.newPage();
      await setupLandingShowcaseMocks(page, locale, { authenticated: true });

      const results = await captureLandingShowcaseLocale(page, locale, {
        rootDir: process.cwd(),
      });
      expect(results).toHaveLength(3);

      const manifestEntries = [];
      for (const entry of results) {
        expect(entry.sourcePng.format).toBe('png');
        expect(entry.sourcePng.width).toBe(entry.committedAsset.width);
        expect(entry.sourcePng.height).toBe(entry.committedAsset.height);
        expect(entry.capturedWebp.format).toBe('webp');
        expect(entry.capturedWebp.width).toBe(entry.committedAsset.width);
        expect(entry.capturedWebp.height).toBe(entry.committedAsset.height);
        expect(entry.committedAsset.sha256).toBe(entry.committedAsset.pinnedSha256);
        expect(entry.pixelComparison.dimensionsMatch).toBe(true);

        const pngName = `landing-source-${locale}-${entry.view}.png`;
        const pngPath = testInfo.outputPath(pngName);
        writeFileSync(pngPath, entry.sourcePng.buffer);
        await testInfo.attach(pngName, { path: pngPath, contentType: 'image/png' });

        const webpName = `landing-source-${locale}-${entry.view}.webp`;
        const webpPath = testInfo.outputPath(webpName);
        writeFileSync(webpPath, entry.capturedWebp.buffer);
        await testInfo.attach(webpName, { path: webpPath, contentType: 'image/webp' });

        manifestEntries.push({
          locale: entry.locale,
          view: entry.view,
          route: entry.route,
          scrollY: entry.scrollY,
          description: entry.description,
          viewport: entry.viewport,
          deviceScaleFactor: entry.deviceScaleFactor,
          conversion: entry.conversion,
          sourcePngFile: pngName,
          sourcePngBytes: entry.sourcePng.bytes,
          sourcePngSha256: entry.sourcePng.sha256,
          capturedWebpFile: webpName,
          capturedWebpBytes: entry.capturedWebp.bytes,
          capturedWebpSha256: entry.capturedWebp.sha256,
          committedAsset: entry.committedAsset,
          byteIdentical: entry.byteIdentical,
          pixelComparison: entry.pixelComparison,
        });
      }

      const manifestName = `landing-provenance-${locale}.json`;
      const manifestPath = testInfo.outputPath(manifestName);
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            locale,
            platform: process.platform,
            arch: process.arch,
            note: 'Committed WebPs were captured on macOS with Playwright bundled Chromium and converted via sharp().webp({ quality: 88, effort: 6 }). Cross-OS and cross-build runs differ in exact bytes due to font/emoji rasterization.',
            entries: manifestEntries,
          },
          null,
          2
        )
      );
      await testInfo.attach(manifestName, {
        path: manifestPath,
        contentType: 'application/json',
      });
    } finally {
      await context.close();
    }
  });
}
