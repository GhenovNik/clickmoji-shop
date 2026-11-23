// Regenerates the three committed PWA PNGs from public/icon.svg.
// Run: node scripts/generate-pwa-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const svgPath = path.join(root, 'public/icon.svg');
const svg = readFileSync(svgPath);

const targets = [
  { file: 'public/icons/icon-192.png', size: 192 },
  { file: 'public/icons/icon-512.png', size: 512 },
  { file: 'public/apple-touch-icon.png', size: 180 },
];

mkdirSync(path.join(root, 'public/icons'), { recursive: true });

for (const { file, size } of targets) {
  const png = await sharp(svg)
    .resize(size, size)
    .flatten({ background: '#4f46e5' })
    .png()
    .toBuffer();
  writeFileSync(path.join(root, file), png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
