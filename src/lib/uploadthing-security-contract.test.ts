import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(read(relativePath)) as T;
}

type PackageJson = {
  overrides?: Record<string, string>;
  dependencies?: Record<string, string>;
};

type PackageLock = {
  packages: Record<string, { version?: string; overridden?: boolean }>;
};

describe('UploadThing security contract', () => {
  it('keeps UploadThing v7 while overriding vulnerable effect transitives', () => {
    const packageJson = readJson<PackageJson>('package.json');
    const packageLock = readJson<PackageLock>('package-lock.json');

    expect(packageJson.dependencies?.uploadthing).toMatch(/^\^7\./);
    expect(packageJson.dependencies?.['@uploadthing/react']).toMatch(/^\^7\./);
    expect(packageJson.overrides?.effect).toBe('3.21.4');
    expect(packageLock.packages['node_modules/effect']?.version).toBe('3.21.4');
  });

  it('keeps the UploadThing API surfaces covered by the follow-up issue', () => {
    expect(read('src/app/api/uploadthing/route.ts')).toContain('createRouteHandler');
    expect(read('src/app/api/uploadthing/core.ts')).toContain('createUploadthing');
    expect(read('src/app/api/uploadthing/core.ts')).toContain('productImage');
    expect(read('src/app/api/uploadthing/core.ts')).toContain("session.user.role !== 'ADMIN'");
    expect(read('src/lib/services/emoji-assets.ts')).toContain("from 'uploadthing/server'");
    expect(read('src/lib/services/emoji-assets.ts')).toContain('uploadFiles(file)');
    expect(read('src/lib/uploadthing.ts')).toContain('generateReactHelpers<OurFileRouter>()');
  });

  it('uploads emoji buffers through injectable UTApi-compatible client', async () => {
    const { uploadEmojiImage } = await import('./services/emoji-assets');
    const uploadedFiles: File[] = [];

    const result = await uploadEmojiImage({
      imageBuffer: Buffer.from('png-bytes'),
      productName: 'Test Milk',
      utapi: {
        uploadFiles: async (file: File) => {
          uploadedFiles.push(file);
          return { data: { url: 'https://utfs.io/f/test-file.png' } };
        },
      } as never,
    });

    expect(result.imageUrl).toBe('https://utfs.io/f/test-file.png');
    expect(result.fileName).toMatch(/^ai-emoji-test-milk-\d+\.png$/);
    expect(uploadedFiles).toHaveLength(1);
    expect(uploadedFiles[0].type).toBe('image/png');
  });
});
