// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

// Static PWA icon contract (AGE-1637): the manifest, the Apple touch icon and the
// three anonymous proxy exclusions are pinned here against the committed artifacts.
// Opacity uses ensureAlpha().raw().toBuffer() without flatten in the oracle, so a
// semi-transparent pixel fails even though the committed apple icon is flattened RGB.

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');
const readBinary = (relativePath: string) => readFileSync(path.join(root, relativePath));

const SVG_PATH = 'public/icon.svg';
const ICON_192 = 'public/icons/icon-192.png';
const ICON_512 = 'public/icons/icon-512.png';
const APPLE_ICON = 'public/apple-touch-icon.png';
const MANIFEST = 'public/manifest.json';
const LAYOUT = 'src/app/layout.tsx';
const PROXY = 'src/proxy.ts';

const EXPECTED_ICON_URLS = [
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/apple-touch-icon.png',
];

function assertFileExists(relativePath: string) {
  if (!existsSync(path.join(root, relativePath))) {
    throw new Error(`missing file: ${relativePath}`);
  }
}

function assertPng(metadata: sharp.Metadata, relativePath: string) {
  if (metadata.format !== 'png') {
    throw new Error(`${relativePath} decodes as ${String(metadata.format)}, expected png`);
  }
}

function assertSizes(decoded: { width: number; height: number }, declared: string, label: string) {
  const [declaredWidth, declaredHeight] = declared.split('x').map(Number);
  if (decoded.width !== declaredWidth || decoded.height !== declaredHeight) {
    throw new Error(
      `sizes mismatch for ${label}: declared ${declared} vs decoded ${decoded.width}x${decoded.height}`
    );
  }
}

async function decodePng(relativePath: string) {
  assertFileExists(relativePath);
  const buffer = readBinary(relativePath);
  const image = sharp(buffer);
  const metadata = await image.metadata();
  assertPng(metadata, relativePath);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info, metadata };
}

function assertOpaque(data: Buffer, info: sharp.OutputInfo, label: string) {
  if (info.channels !== 4) {
    throw new Error(`${label} has ${info.channels} channels after ensureAlpha(), expected 4`);
  }
  const expectedLength = info.width * info.height * 4;
  if (data.length !== expectedLength) {
    throw new Error(`${label} raw buffer is ${data.length} bytes, expected ${expectedLength}`);
  }
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] !== 255) {
      throw new Error(`${label} has a non-opaque alpha byte (${data[offset]}) at index ${offset}`);
    }
  }
}

const APPLE_MARKER = /apple:\s*'\/apple-touch-icon\.png'/;

function assertAppleMarker(source: string) {
  if (!APPLE_MARKER.test(source)) {
    throw new Error("layout lacks the apple: '/apple-touch-icon.png' marker");
  }
}

function svgIconUrls(manifest: { icons?: Array<{ src?: string }> }, layoutSource: string) {
  const manifestUrls = (manifest.icons ?? []).map((icon) => icon.src);
  const layoutIconMatch = layoutSource.match(/icons:\s*\{[^}]*\}/s);
  const layoutUrls = layoutIconMatch
    ? [...layoutIconMatch[0].matchAll(/'(\/[^']+)'/g)].map((match) => match[1])
    : [];
  return [...manifestUrls, ...layoutUrls].filter((url): url is string => Boolean(url));
}

describe('static PWA icons', () => {
  const manifest = JSON.parse(read(MANIFEST)) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    icons: Array<Record<string, string>>;
  };
  const layoutSource = read(LAYOUT);

  it('AC-1: manifest keeps the SVG entry and adds the 192 and 512 PNG entries', () => {
    const bySrc = new Map(manifest.icons.map((icon) => [icon.src, icon]));
    const svg = bySrc.get('/icon.svg');
    if (!svg) {
      throw new Error('manifest lacks the /icon.svg entry');
    }
    expect(svg).toEqual({ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' });

    const icon192 = bySrc.get('/icons/icon-192.png');
    if (!icon192) {
      throw new Error('manifest lacks PNG 192 entry');
    }
    expect(icon192).toEqual({
      src: '/icons/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    });

    const icon512 = bySrc.get('/icons/icon-512.png');
    if (!icon512) {
      throw new Error('manifest lacks PNG 512 entry');
    }
    expect(icon512).toEqual({
      src: '/icons/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    });
  });

  it('AC-1: icon-192.png and icon-512.png exist, decode as PNG and match declared sizes', async () => {
    for (const [relativePath, declared] of [
      [ICON_192, '192x192'],
      [ICON_512, '512x512'],
    ] as const) {
      const { metadata } = await decodePng(relativePath);
      if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error(`${relativePath} decoded without dimensions`);
      }
      assertSizes({ width: metadata.width, height: metadata.height }, declared, relativePath);
    }
  });

  it('AC-2: layout declares the explicit apple touch icon marker', () => {
    assertAppleMarker(layoutSource);
  });

  it('AC-2: apple-touch-icon.png exists, decodes as 180x180 PNG and is fully opaque', async () => {
    const { data, info, metadata } = await decodePng(APPLE_ICON);
    if (metadata.width !== 180 || metadata.height !== 180) {
      throw new Error(
        `apple-touch-icon.png decodes as ${metadata.width}x${metadata.height}, expected 180x180`
      );
    }
    assertOpaque(data, info, APPLE_ICON);
  });

  it('INV-1: the icon URL set is exactly the SVG plus the three named PNGs', () => {
    const urls = new Set(svgIconUrls(manifest, layoutSource));
    expect([...urls].sort()).toEqual([...EXPECTED_ICON_URLS].sort());
  });

  it('INV-1: icon.svg is unchanged and keeps its viewBox', () => {
    const svg = read(SVG_PATH);
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toMatch(/^<svg[\s>]/);
  });

  it('AC-4/F-8: manifest name, short_name, start_url and display are unchanged', () => {
    expect(manifest.name).toBe('Clickmoji Shop');
    expect(manifest.short_name).toBe('Clickmoji');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('FR-1: proxy allowlist and matcher carry exactly the three new exact paths', () => {
    const proxy = read(PROXY);
    for (const asset of ['/icons/icon-192.png', '/icons/icon-512.png', '/apple-touch-icon.png']) {
      expect(proxy).toContain(`'${asset}'`);
    }
    // Raw source of the matcher string: dots escaped, path end anchored.
    for (const tail of [
      String.raw`icons/icon-192\\.png$`,
      String.raw`icons/icon-512\\.png$`,
      String.raw`apple-touch-icon\\.png$`,
    ]) {
      expect(proxy, `matcher lacks ${tail}`).toContain(tail);
    }
    expect(proxy).not.toContain("'/icons/'");
    expect(proxy).not.toContain('.*\\.png');
  });

  it('FR-3: committed PNGs are pixel-identical to a fresh render from the committed SVG', async () => {
    const svg = readBinary(SVG_PATH);
    for (const [relativePath, size] of [
      [ICON_192, 192],
      [ICON_512, 512],
      [APPLE_ICON, 180],
    ] as const) {
      assertFileExists(relativePath);
      const rendered = await sharp(svg)
        .resize(size, size)
        .flatten({ background: '#4f46e5' })
        .png()
        .toBuffer();
      const committed = readBinary(relativePath);
      const [renderedRaw, committedRaw] = await Promise.all([
        sharp(rendered).ensureAlpha().raw().toBuffer(),
        sharp(committed).ensureAlpha().raw().toBuffer(),
      ]);
      expect(
        committedRaw.equals(renderedRaw),
        `${relativePath} is not pixel-identical to a fresh render from ${SVG_PATH}`
      ).toBe(true);
    }
  });

  it('F-3: a declared size that disagrees with the decoded PNG fails the sizes oracle', async () => {
    const fixture = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 4,
        background: { r: 79, g: 70, b: 229, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const metadata = await sharp(fixture).metadata();
    expect(() =>
      assertSizes({ width: metadata.width!, height: metadata.height! }, '512x512', 'fixture')
    ).toThrow(/declared 512x512 vs decoded 200x200/);
  });

  it('F-4: the existence oracle fails for a missing icon file', () => {
    expect(() => assertFileExists('public/icons/__definitely-missing__.png')).toThrow(
      /missing file/
    );
  });

  it('F-5: a single translucent pixel fails the opacity oracle', async () => {
    const width = 180;
    const height = 180;
    const pixels = Buffer.alloc(width * height * 4, 255);
    pixels[3] = 128;
    const fixture = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    const { data, info } = await sharp(fixture)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(() => assertOpaque(data, info, 'translucent fixture')).toThrow(/non-opaque alpha/);
  });

  it('F-2b: a flat RGB PNG without alpha passes the opacity oracle via ensureAlpha()', async () => {
    const fixture = await sharp({
      create: {
        width: 180,
        height: 180,
        channels: 3,
        background: { r: 79, g: 70, b: 229 },
      },
    })
      .flatten({ background: '#4f46e5' })
      .png()
      .toBuffer();
    const metadata = await sharp(fixture).metadata();
    expect(metadata.channels).toBe(3);
    const { data, info } = await sharp(fixture)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(() => assertOpaque(data, info, 'flat rgb fixture')).not.toThrow();
  });

  it('F-6: source without the apple marker fails the layout oracle', () => {
    const withoutApple =
      "export const metadata = {\n  icons: {\n    icon: '/icon.svg',\n  },\n};\n";
    expect(() => assertAppleMarker(withoutApple)).toThrow(/apple:/);
  });

  it('F-7: a 384x384 PNG fails the 512x512 sizes oracle', async () => {
    const fixture = await sharp({
      create: {
        width: 384,
        height: 384,
        channels: 3,
        background: { r: 79, g: 70, b: 229 },
      },
    })
      .png()
      .toBuffer();
    const metadata = await sharp(fixture).metadata();
    expect(() =>
      assertSizes({ width: metadata.width!, height: metadata.height! }, '512x512', 'fixture')
    ).toThrow(/declared 512x512 vs decoded 384x384/);
  });

  it('F-7b: JPEG bytes named as an icon fail the format oracle', async () => {
    const fixture = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: { r: 79, g: 70, b: 229 },
      },
    })
      .jpeg()
      .toBuffer();
    const metadata = await sharp(fixture).metadata();
    expect(() => assertPng(metadata, 'icon-512.png')).toThrow(/expected png/);
  });
});
