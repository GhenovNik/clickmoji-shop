// @vitest-environment node
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  EmojiImageTooLargeError,
  EmptyEmojiImageError,
  NORMALIZED_EMOJI_SIZE,
  normalizeEmojiImage,
} from './emoji-image-normalize';

function svg(width: number, height: number, body: string, background = '#ffffff') {
  const fill =
    background === 'none' ? '' : `<rect width="100%" height="100%" fill="${background}"/>`;
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${fill}${body}</svg>`
    )
  )
    .png()
    .toBuffer();
}

async function decode(webp: Buffer) {
  const { data, info } = await sharp(webp)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
  let left = info.width;
  let right = -1;
  let top = info.height;
  let bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (alphaAt(x, y) <= 20) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { info, alphaAt, box: { left, right, top, bottom } };
}

describe('normalizeEmojiImage', () => {
  it('crops an off-centre object on white and centres it in a transparent 256 WebP', async () => {
    const input = await svg(600, 400, '<circle cx="120" cy="300" r="60" fill="#e53935"/>');

    const output = await normalizeEmojiImage(input);
    const { info, alphaAt, box } = await decode(output);

    expect((await sharp(output).metadata()).format).toBe('webp');
    expect(info.width).toBe(NORMALIZED_EMOJI_SIZE);
    expect(info.height).toBe(NORMALIZED_EMOJI_SIZE);
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(255, 255)).toBe(0);
    expect(alphaAt(128, 128)).toBe(255);
    // The object fills 86% of the square, with the same margin on every side.
    expect(box.right - box.left).toBeGreaterThan(205);
    expect(box.right - box.left).toBeLessThan(230);
    expect(Math.abs(box.left - (255 - box.right))).toBeLessThanOrEqual(2);
    expect(Math.abs(box.top - (255 - box.bottom))).toBeLessThanOrEqual(2);
  });

  it('gives a small and a large picture of the same object the same size', async () => {
    const small = await normalizeEmojiImage(
      await svg(200, 200, '<rect x="80" y="70" width="40" height="60" fill="#43a047"/>')
    );
    const large = await normalizeEmojiImage(
      await svg(1200, 1200, '<rect x="100" y="300" width="400" height="600" fill="#43a047"/>')
    );

    // The edge blur is fixed in source pixels, so a tiny source keeps a slightly softer edge.
    const a = (await decode(small)).box;
    const b = (await decode(large)).box;
    expect(Math.abs(a.bottom - a.top - (b.bottom - b.top))).toBeLessThanOrEqual(4);
    expect(Math.abs(a.right - a.left - (b.right - b.left))).toBeLessThanOrEqual(4);
  });

  it('keeps shaded light details inside the object, like coconut flesh', async () => {
    const input = await svg(
      300,
      300,
      '<circle cx="150" cy="150" r="90" fill="#6d4c41"/><circle cx="150" cy="150" r="30" fill="#ececec"/>'
    );

    const { alphaAt } = await decode(await normalizeEmojiImage(input));

    expect(alphaAt(128, 128)).toBe(255);
  });

  it('keeps a white label on coloured packaging by default', async () => {
    for (const label of ['#ffffff', '#fafafa']) {
      const input = await svg(
        256,
        256,
        `<rect x="64" y="64" width="128" height="128" fill="#2e7d32"/><rect x="96" y="96" width="64" height="64" fill="${label}"/>`
      );

      const { alphaAt } = await decode(await normalizeEmojiImage(input));

      expect(alphaAt(128, 128), label).toBe(255);
    }
  });

  it('clears an enclosed gap of the background colour only when asked, for text-free pictures', async () => {
    const input = await svg(
      300,
      300,
      '<circle cx="150" cy="150" r="90" fill="#43a047"/><circle cx="150" cy="150" r="30" fill="#ffffff"/>'
    );

    const kept = await decode(await normalizeEmojiImage(input));
    const cleared = await decode(await normalizeEmojiImage(input, { clearEnclosedGaps: true }));

    expect(kept.alphaAt(128, 128)).toBe(255);
    expect(cleared.alphaAt(128, 128)).toBe(0);
    expect(cleared.alphaAt(128, 40)).toBe(255);
  });

  it('drops the light grid dashes a Gemini sheet leaves at the cell edge', async () => {
    const dashes = Array.from(
      { length: 20 },
      (_, i) => `<rect x="${i * 30}" y="2" width="15" height="2" fill="#d6d6d6"/>`
    ).join('');
    const input = await svg(
      600,
      600,
      `${dashes}<circle cx="300" cy="320" r="150" fill="#fb8c00"/>`
    );

    const { box } = await decode(await normalizeEmojiImage(input));

    // A kept dash row would stretch the box to the top of the cell and push the circle down.
    expect(Math.abs(box.top - (255 - box.bottom))).toBeLessThanOrEqual(2);
  });

  it('removes transparency of a transparent-background source the same way as white', async () => {
    const input = await svg(400, 400, '<circle cx="300" cy="100" r="60" fill="#8e24aa"/>', 'none');

    const { alphaAt, box } = await decode(await normalizeEmojiImage(input));

    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(128, 128)).toBe(255);
    expect(box.right - box.left).toBeGreaterThan(205);
  });

  it('keeps a white object on a transparent background', async () => {
    const input = await svg(
      256,
      256,
      '<rect x="64" y="64" width="128" height="128" fill="#ffffff"/>',
      'none'
    );

    const { alphaAt, box } = await decode(await normalizeEmojiImage(input));

    expect(alphaAt(128, 128)).toBe(255);
    expect(alphaAt(0, 0)).toBe(0);
    expect(box.right - box.left).toBeGreaterThan(205);
  });

  it('rejects a fully transparent picture', async () => {
    const input = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    await expect(normalizeEmojiImage(input)).rejects.toBeInstanceOf(EmptyEmojiImageError);
  });

  it('refuses a picture above the pixel limit before decoding it', async () => {
    // A tiny compressed PNG that would decode to 5000 × 5000 pixels.
    const input = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    await expect(normalizeEmojiImage(input)).rejects.toBeInstanceOf(EmojiImageTooLargeError);
  });

  it('scales a large accepted picture down before building its masks', async () => {
    const input = await svg(3000, 3000, '<circle cx="1500" cy="1500" r="900" fill="#e53935"/>');

    const started = Date.now();
    const { info, alphaAt } = await decode(await normalizeEmojiImage(input));

    expect(info.width).toBe(NORMALIZED_EMOJI_SIZE);
    expect(alphaAt(128, 128)).toBe(255);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('keeps a dark object that touches the edge of the picture', async () => {
    const input = await svg(
      300,
      300,
      '<rect x="0" y="100" width="150" height="100" fill="#3e2723"/>'
    );

    const { alphaAt } = await decode(await normalizeEmojiImage(input));

    expect(alphaAt(128, 128)).toBe(255);
  });

  it('rejects a picture with nothing but background', async () => {
    const input = await svg(300, 300, '');

    await expect(normalizeEmojiImage(input)).rejects.toBeInstanceOf(EmptyEmojiImageError);
  });
});
