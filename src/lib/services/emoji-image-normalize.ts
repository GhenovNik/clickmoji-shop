import sharp from 'sharp';

// One look for every emoji picture, whatever its source (AGE-1465 item 3): the background is
// removed (the source's own transparency when it has one, otherwise a flood fill of the white
// field from the edges), the picture is cropped to the object and centred in a fixed square with
// the same margin, and stored as a transparent WebP. Port of the KB prototype
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
// Decoding stops above this many pixels; anything accepted is first scaled down to the working
// size, so the masks below never hold more than WORK_SIZE² pixels.
export const MAX_INPUT_PIXELS = 4096 * 4096;
const WORK_SIZE = 1024;
// A source's own alpha is trusted as the object mask when its border is mostly clear: the
// background around the object is transparent. A thin transparent frame counts; an image that is
// evenly semi-transparent everywhere does not, since its alpha separates nothing.
const CLEAR_ALPHA = 32;
const SOURCE_ALPHA_BORDER_SHARE = 0.5;

export class EmptyEmojiImageError extends Error {
  constructor() {
    super('Emoji image is empty after background removal');
    this.name = 'EmptyEmojiImageError';
  }
}

export class EmojiImageTooLargeError extends Error {
  constructor() {
    super(`Emoji image is larger than ${MAX_INPUT_PIXELS} pixels`);
    this.name = 'EmojiImageTooLargeError';
  }
}

export type NormalizeEmojiOptions = {
  size?: number;
  // Also clear enclosed gaps of the background colour (between herb stems, inside a bunch of
  // tomatoes). Only for pictures known to carry no text: elsewhere the same white region may be a
  // label on the packaging, so by default every enclosed region is kept.
  clearEnclosedGaps?: boolean;
};

function floodBackground(rgb: Buffer, width: number, height: number, clearGaps: boolean) {
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
  if (clearGaps) clearEnclosedHoles(rgb, background, width, height, stack);
  return background;
}

// Gaps the edge fill cannot reach (between herb stems, inside a bunch of tomatoes), on request:
// only regions almost exactly the background colour and not a speck; shaded whites of the object
// itself (coconut flesh) differ from the field by more than this.
const HOLE_THRESHOLD = 18;
const HOLE_MIN_SHARE = 0.0005;

function clearEnclosedHoles(
  rgb: Buffer,
  background: Uint8Array,
  width: number,
  height: number,
  stack: Int32Array
) {
  let count = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < background.length; i++) {
    if (!background[i]) continue;
    count++;
    sum[0] += rgb[i * 3];
    sum[1] += rgb[i * 3 + 1];
    sum[2] += rgb[i * 3 + 2];
  }
  if (count === 0) return;
  const [r, g, b] = sum.map((value) => value / count);
  const nearField = (index: number) =>
    Math.abs(rgb[index * 3] - r) +
      Math.abs(rgb[index * 3 + 1] - g) +
      Math.abs(rgb[index * 3 + 2] - b) <=
    HOLE_THRESHOLD;

  const minArea = Math.max(16, Math.round(width * height * HOLE_MIN_SHARE));
  const seen = new Uint8Array(background.length);
  const component: number[] = [];

  for (let start = 0; start < background.length; start++) {
    if (background[start] || seen[start] || !nearField(start)) continue;
    component.length = 0;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const index = stack[--top];
      component.push(index);
      const x = index % width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        index - width,
        index + width,
      ];
      for (const next of neighbours) {
        if (next < 0 || next >= background.length || seen[next] || background[next]) continue;
        if (!nearField(next)) continue;
        seen[next] = 1;
        stack[top++] = next;
      }
    }
    if (component.length >= minArea) for (const index of component) background[index] = 1;
  }
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

async function decode(input: Buffer) {
  try {
    return await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(WORK_SIZE, WORK_SIZE, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new EmojiImageTooLargeError();
    }
    throw error;
  }
}

export async function normalizeEmojiImage(input: Buffer, options: NormalizeEmojiOptions = {}) {
  const { size = NORMALIZED_EMOJI_SIZE, clearEnclosedGaps = false } = options;
  const { data: source, info } = await decode(input);
  const { width, height } = info;
  const pixels = width * height;

  let border = 0;
  let clearBorder = 0;
  const countBorder = (index: number) => {
    border++;
    if (source[index * 4 + 3] < CLEAR_ALPHA) clearBorder++;
  };
  for (let x = 0; x < width; x++) {
    countBorder(x);
    if (height > 1) countBorder((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    countBorder(y * width);
    if (width > 1) countBorder(y * width + width - 1);
  }

  const rgb = Buffer.alloc(pixels * 3);
  let alpha: Buffer;
  if (clearBorder >= border * SOURCE_ALPHA_BORDER_SHARE) {
    // The source already separates the object from the background: trust its alpha, so a white
    // object on a transparent background stays an object.
    alpha = Buffer.alloc(pixels);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = source[i * 4];
      rgb[i * 3 + 1] = source[i * 4 + 1];
      rgb[i * 3 + 2] = source[i * 4 + 2];
      alpha[i] = source[i * 4 + 3];
    }
  } else {
    // An opaque picture on a white field: blend the few soft edges over white, then remove the
    // field from the edges inwards.
    for (let i = 0; i < pixels; i++) {
      const a = source[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c++)
        rgb[i * 3 + c] = Math.round(source[i * 4 + c] * a + 255 * (1 - a));
    }
    const background = floodBackground(rgb, width, height, clearEnclosedGaps);
    const hardAlpha = Buffer.alloc(pixels);
    for (let i = 0; i < pixels; i++) hardAlpha[i] = background[i] ? 0 : 255;
    alpha = await sharp(hardAlpha, { raw: { width, height, channels: 1 } })
      .blur(EDGE_BLUR_SIGMA)
      // libvips hands a one-band raw input back as sRGB; keep one band.
      .extractChannel(0)
      .raw()
      .toBuffer();
  }

  const box = objectBox(alpha, width, height);

  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
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
