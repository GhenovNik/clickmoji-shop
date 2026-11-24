// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  COMMITTED_LANDING_ASSETS,
  LANDING_DEVICE_SCALE_FACTOR,
  LANDING_VIEWPORT,
  LANDING_VIEWS,
  LANDING_WEBP_OPTIONS,
} from '../../tests/e2e/fixtures/landing-showcase.mjs';

const root = process.cwd();
const readText = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');
const readBinary = (relativePath: string) => readFileSync(path.join(root, relativePath));

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('landing screenshot provenance contract', () => {
  it('pins all six committed WebPs by locale/view with exact format, dimensions, and SHA-256', async () => {
    expect(COMMITTED_LANDING_ASSETS).toHaveLength(6);

    for (const asset of COMMITTED_LANDING_ASSETS) {
      const fullPath = path.join(root, asset.assetPath);
      expect(existsSync(fullPath), `missing committed asset ${asset.assetPath}`).toBe(true);

      const bytes = readBinary(asset.assetPath);
      expect(bytes.length, `${asset.assetPath} byte length`).toBe(asset.bytes);
      expect(sha256(bytes), `${asset.assetPath} sha256`).toBe(asset.sha256);

      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(asset.width);
      expect(meta.height).toBe(asset.height);
      expect(meta.channels).toBe(3);
      expect(asset.width).toBe(LANDING_VIEWPORT.width * LANDING_DEVICE_SCALE_FACTOR);
      expect(asset.height).toBe(LANDING_VIEWPORT.height * LANDING_DEVICE_SCALE_FACTOR);
    }
  });

  it('defines deterministic Playwright fixture capture and sharp WebP conversion provenance', () => {
    expect(LANDING_VIEWS.map((entry) => entry.view)).toEqual([
      'product-cards',
      'shopping-list',
      'shopping-grid',
    ]);
    expect(LANDING_VIEWPORT).toEqual({ width: 390, height: 520 });
    expect(LANDING_DEVICE_SCALE_FACTOR).toBe(2);
    expect(LANDING_WEBP_OPTIONS).toEqual({ quality: 88, effort: 6 });

    const smokeSpec = readText('tests/e2e/landing-provenance.spec.ts');
    const cliScript = readText('scripts/generate-landing-screenshots.mjs');
    expect(smokeSpec).toContain('@smoke');
    expect(smokeSpec).toContain('captureLandingShowcaseLocale');
    expect(cliScript).toContain('captureLandingShowcaseLocale');
  });

  it('uploads landing desktop/mobile PNGs and provenance artifacts in CI', () => {
    const ci = readText('.github/workflows/ci.yml');

    expect(ci).toContain('Upload landing screenshot evidence');
    expect(ci).toContain(
      'name: landing-evidence-${{ github.event.pull_request.head.sha || github.sha }}'
    );
    expect(ci).toContain('test-results/**/landing-*.png');
    expect(ci).toContain('test-results/**/landing-source-*.webp');
    expect(ci).toContain('test-results/**/landing-provenance-*.json');
  });
});
