import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaPgAdapter } from '../prisma-adapter';
import { applyCatalogImageRepairs, type RepairPlanEntry } from './catalog-image-repair';

const execFileAsync = promisify(execFile);

async function runCli(args: string[], databaseUrl: string) {
  try {
    const res = await execFileAsync(process.execPath, args, {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    });
    return { status: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { status: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// Requires INTEGRATION_DATABASE_URL (run via `npm run test:repair-catalog-postgres`).
const integrationDbUrl = process.env.INTEGRATION_DATABASE_URL;
const describeWithDb = integrationDbUrl ? describe : describe.skip;

describeWithDb('catalog image audit & repair (disposable PostgreSQL)', () => {
  let prisma: PrismaClient;
  let server: http.Server;
  let baseUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
    tempDir = mkdtempSync(join(tmpdir(), 'clickmoji-repair-it-'));
    server = http.createServer((req, res) => {
      if (req.url === '/ok.webp' || req.url === '/new-1.webp' || req.url === '/new-2.webp') {
        res.writeHead(200, { 'content-type': 'image/webp' });
        res.end('webp');
        return;
      }
      if (req.url === '/broken-1.webp' || req.url === '/broken-2.webp') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(500);
      res.end('err');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.listHistoryItem.deleteMany();
    await prisma.listHistory.deleteMany();
    await prisma.list.deleteMany();
    await prisma.favorite.deleteMany();
    await prisma.variantFavorite.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.user.deleteMany();
  });

  async function seedFixture() {
    const dairy = await prisma.category.create({
      data: { name: 'Молочные продукты', nameEn: 'Dairy', emoji: '🥛', order: 1 },
    });
    const sauces = await prisma.category.create({
      data: { name: 'Масла и соусы', nameEn: 'Oils & Sauces', emoji: '🍅', order: 2 },
    });
    const smetana = await prisma.product.create({
      data: {
        name: 'Сметана',
        nameEn: 'Sour Cream',
        emoji: '🥄',
        isCustom: true,
        imageUrl: `${baseUrl}/broken-1.webp`,
        imageUrlEn: `${baseUrl}/ok.webp`,
        categoryId: dairy.id,
        isGlobal: true,
      },
    });
    const ketchup = await prisma.product.create({
      data: {
        name: 'Кетчуп',
        nameEn: 'Ketchup',
        emoji: '🍅',
        isCustom: true,
        imageUrl: `${baseUrl}/broken-2.webp`,
        imageUrlEn: null,
        categoryId: sauces.id,
        isGlobal: true,
      },
    });
    await prisma.product.create({
      data: {
        name: 'Молоко',
        nameEn: 'Milk',
        emoji: '🥛',
        isCustom: true,
        imageUrl: `${baseUrl}/ok.webp`,
        categoryId: dairy.id,
        isGlobal: true,
      },
    });
    const user = await prisma.user.create({
      data: { email: 'it-repair@clickmoji.test', name: 'Test' },
    });
    const history = await prisma.listHistory.create({
      data: { listName: 'Hist', userId: user.id },
    });
    await prisma.listHistoryItem.create({
      data: {
        historyId: history.id,
        productId: smetana.id,
        productName: smetana.name,
        productEmoji: smetana.emoji,
        productImageUrl: smetana.imageUrl,
        categoryName: dairy.name,
        isCustom: true,
        addedAt: new Date(),
      },
    });
    return { smetana, ketchup };
  }

  it('runs the shipped audit script against real Postgres and hides URLs/secrets', async () => {
    await seedFixture();
    const res = await runCli(
      ['node_modules/.bin/tsx', 'scripts/audit-catalog-images.ts'],
      integrationDbUrl!
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Сметана: HTTP 404');
    expect(res.stdout).toContain('Кетчуп: HTTP 404');
    expect(res.stdout).toContain('Молоко: HTTP 200');
    expect(res.stdout).not.toContain('http://');
    expect(res.stdout).not.toContain('postgresql://');
  });

  it('prevents partial apply, preserves concurrent edits, and supports dry-run + atomic apply', async () => {
    const { smetana, ketchup } = await seedFixture();

    const entries: RepairPlanEntry[] = [
      {
        target: 'product',
        category: 'Молочные продукты',
        name: 'Сметана',
        expectedImageUrl: `${baseUrl}/broken-1.webp`,
        expectedIsCustom: true,
        newImageUrl: `${baseUrl}/new-1.webp`,
      },
      {
        target: 'product',
        category: 'Масла и соусы',
        name: 'Кетчуп',
        expectedImageUrl: `${baseUrl}/broken-2.webp`,
        expectedIsCustom: true,
        newImageUrl: `${baseUrl}/new-2.webp`,
      },
    ];

    // 1. Concurrent modification between read and conditional update aborts and leaves both rows unchanged.
    const concurrentEditResult = await applyCatalogImageRepairs(prisma, entries, {
      requireHttps: false,
      beforeWriteHook: async () => {
        await prisma.product.update({
          where: { id: ketchup.id },
          data: { imageUrl: `${baseUrl}/ok.webp`, isCustom: true },
        });
      },
    });
    expect(concurrentEditResult.exitCode).toBe(1);
    expect(concurrentEditResult.updatedCount).toBe(0);
    const smetanaAfterRace = await prisma.product.findUnique({ where: { id: smetana.id } });
    const ketchupAfterRace = await prisma.product.findUnique({ where: { id: ketchup.id } });
    expect(smetanaAfterRace?.imageUrl).toBe(`${baseUrl}/broken-1.webp`);
    expect(ketchupAfterRace?.imageUrl).toBe(`${baseUrl}/ok.webp`);

    // Restore ketchup back to broken-2 for full apply test.
    await prisma.product.update({
      where: { id: ketchup.id },
      data: { imageUrl: `${baseUrl}/broken-2.webp`, isCustom: true },
    });

    // 2. Partial apply check: when second item has stale expectedImageUrl, transaction aborts and first item stays unchanged.
    const partialResult = await applyCatalogImageRepairs(
      prisma,
      [entries[0]!, { ...entries[1]!, expectedImageUrl: `${baseUrl}/broken-1.webp` }],
      { requireHttps: false }
    );
    expect(partialResult.exitCode).toBe(1);
    expect(partialResult.updatedCount).toBe(0);
    expect((await prisma.product.findUnique({ where: { id: smetana.id } }))?.imageUrl).toBe(
      `${baseUrl}/broken-1.webp`
    );

    const planPath = join(tempDir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        repairs: [
          entries[0],
          { ...entries[1], expectedImageUrl: 'https://utfs.io/f/non-matching-stale' },
        ],
      })
    );
    const cliFail = await runCli(
      ['node_modules/.bin/tsx', 'scripts/repair-catalog-images.ts', '--plan', planPath],
      integrationDbUrl!
    );
    expect(cliFail.status).toBe(1);

    // 3. Full atomic apply updates only primary image fields and leaves imageUrlEn and history untouched.
    const applyResult = await applyCatalogImageRepairs(prisma, entries, { requireHttps: false });
    expect(applyResult.exitCode).toBe(0);
    expect(applyResult.updatedCount).toBe(2);

    const smetanaFinal = await prisma.product.findUnique({ where: { id: smetana.id } });
    const ketchupFinal = await prisma.product.findUnique({ where: { id: ketchup.id } });
    expect(smetanaFinal?.imageUrl).toBe(`${baseUrl}/new-1.webp`);
    expect(smetanaFinal?.imageUrlEn).toBe(`${baseUrl}/ok.webp`);
    expect(smetanaFinal?.nameEn).toBe('Sour Cream');
    expect(ketchupFinal?.imageUrl).toBe(`${baseUrl}/new-2.webp`);
    const historyRow = await prisma.listHistoryItem.findFirst({ where: { productId: smetana.id } });
    expect(historyRow?.productImageUrl).toBe(`${baseUrl}/broken-1.webp`);

    // 4. Audit after repair now passes with exit code 0.
    const okRes = await runCli(
      ['node_modules/.bin/tsx', 'scripts/audit-catalog-images.ts'],
      integrationDbUrl!
    );
    expect(okRes.status).toBe(0);
    expect(okRes.stdout).toContain('failed=0');
  });
});
