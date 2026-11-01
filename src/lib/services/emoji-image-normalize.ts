import sharp from 'sharp';

// One look for every emoji picture, whatever its source (AGE-1465 item 3): the white field is
// removed by a flood fill from the edges, the picture is cropped to the object and centred in a
// fixed square with the same margin, and stored as a transparent WebP. Port of the KB prototype
// projects/clickmoji-shop/research/2026-10-31-image-probe/normalize_prototype.py.

export const NORMALIZED_EMOJI_SIZE = 256;
export const NORMALIZED_EMOJI_MIME = 'image/webp';

// Share of the square the longer side of the object takes.
const FILL = 0.86;
// Largest sum of channel differences from the seed colour that still counts as background.
const FLOOD_THRESHOLD = 40;
// A border pixel seeds the fill only when it is light: an object touching the edge stays.
const LIGHT_SEED_MIN = 200;
const EDGE_BLUR_SIGMA = 1.2;
// Opening radius that drops specks and grid dashes before the crop box is measured.
const SPECK_RADIUS = 2;
const ALPHA_CUTOFF = 20;

export class EmptyEmojiImageError extends Error {
  constructor() {
    super('Emoji image is empty after background removal');
    this.name = 'EmptyEmojiImageError';
  }
}

function floodBackground(rgb: Buffer, width: number, height: number) {
  const background = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);

  const fillFrom = (seed: number) => {
    if (background[seed]) return;
    const r = rgb[seed * 3];
    const g = rgb[seed * 3 + 1];
    const b = rgb[seed * 3 + 2];
    if (Math.min(r, g, b) < LIGHT_SEED_MIN) return;

    let top = 0;
    stack[top++] = seed;
    background[seed] = 1;
    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        index - width,
        index + width,
      ];
      for (const next of neighbours) {
        if (next < 0 || next >= width * height || background[next]) continue;
        const diff =
          Math.abs(rgb[next * 3] - r) +
          Math.abs(rgb[next * 3 + 1] - g) +
          Math.abs(rgb[next * 3 + 2] - b);
        if (diff > FLOOD_THRESHOLD) continue;
        background[next] = 1;
        stack[top++] = next;
      }
    }
  };

  for (let x = 0; x < width; x++) {
    fillFrom(x);
    fillFrom((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    fillFrom(y * width);
    fillFrom(y * width + width - 1);
  }
  return background;
}

// Separable square min/max filter over a 0/1 mask.
function morph(mask: Uint8Array, width: number, height: number, radius: number, keep: 0 | 1) {
  const pass = (source: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(source.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let value = 1 - keep;
        for (let d = -radius; d <= radius && value !== keep; d++) {
          const sx = horizontal ? x + d : x;
          const sy = horizontal ? y : y + d;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          if (source[sy * width + sx] === keep) value = keep;
        }
        out[y * width + x] = value;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

function objectBox(alpha: Buffer, width: number, height: number) {
  const solid = new Uint8Array(width * height);
  for (let i = 0; i < solid.length; i++) solid[i] = alpha[i] > ALPHA_CUTOFF ? 1 : 0;
  const opened = morph(
    morph(solid, width, height, SPECK_RADIUS, 0),
    width,
    height,
    SPECK_RADIUS,
    1
  );

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!opened[y * width + x]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new EmptyEmojiImageError();
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

export async function normalizeEmojiImage(input: Buffer, size = NORMALIZED_EMOJI_SIZE) {
  // Transparent areas of the source become white first, so they are removed like a white field.
  const { data: rgb, info } = await sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const background = floodBackground(rgb, width, height);
  const hardAlpha = Buffer.alloc(width * height);
  for (let i = 0; i < hardAlpha.length; i++) hardAlpha[i] = background[i] ? 0 : 255;
  const alpha = await sharp(hardAlpha, { raw: { width, height, channels: 1 } })
    .blur(EDGE_BLUR_SIGMA)
    // libvips hands a one-band raw input back as sRGB; keep one band.
    .extractChannel(0)
    .raw()
    .toBuffer();

  const box = objectBox(alpha, width, height);

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }

  const inner = Math.round(size * FILL);
  const margin = Math.floor((size - inner) / 2);
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract(box)
    .resize(inner, inner, { fit: 'contain', background: transparent, kernel: 'lanczos3' })
    .extend({
      top: margin,
      left: margin,
      bottom: size - inner - margin,
      right: size - inner - margin,
      background: transparent,
    })
    .webp({ quality: 82, effort: 6 })
    .toBuffer();
}
