import { PrismaClient } from '@prisma/client';
import { UTApi } from 'uploadthing/server';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(),
});

type Command = 'cleanup-orphaned-files' | 'cleanup-unused-images';

const commands: Command[] = ['cleanup-orphaned-files', 'cleanup-unused-images'];

const usage = () => {
  console.log('Usage:');
  console.log('  npx tsx scripts/db-files.ts <command> [--dry-run]');
  console.log('');
  console.log('Available commands:');
  commands.forEach((command) => console.log(`  - ${command}`));
  console.log('');
  console.log('Flags:');
  console.log('  --dry-run  (only for cleanup-unused-images)');
};

function getFileKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    return pathParts[pathParts.length - 1] || null;
  } catch {
    return null;
  }
}

async function cleanupOrphanedFiles() {
  const utapi = new UTApi();
  console.log('🧹 Starting orphaned files cleanup...\n');

  const { files } = await utapi.listFiles();

  if (!files || files.length === 0) {
    console.log('✅ No files found in UploadThing');
    return;
  }

  console.log(`📦 Found ${files.length} files in UploadThing\n`);

  console.log('🔍 Checking database for used images...');
  const [products, categories] = await Promise.all([
    prisma.product.findMany({
      where: { imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
    prisma.category.findMany({
      where: { imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
  ]);

  const usedFileKeys = new Set<string>();

  products.forEach((product) => {
    const fileKey = getFileKeyFromUrl(product.imageUrl);
    if (fileKey) usedFileKeys.add(fileKey);
  });

  categories.forEach((category) => {
    const fileKey = getFileKeyFromUrl(category.imageUrl);
    if (fileKey) usedFileKeys.add(fileKey);
  });

  console.log(`✅ Found ${usedFileKeys.size} files currently in use\n`);

  const orphanedFiles: string[] = [];

  files.forEach((file) => {
    if (!usedFileKeys.has(file.key)) {
      orphanedFiles.push(file.key);
    }
  });

  if (orphanedFiles.length === 0) {
    console.log('✨ No orphaned files found. Everything is clean!\n');
    return;
  }

  console.log(`🗑️  Found ${orphanedFiles.length} orphaned files:\n`);
  orphanedFiles.forEach((key, index) => {
    console.log(`  ${index + 1}. ${key}`);
  });

  console.log('\n⚠️  These files will be PERMANENTLY deleted from UploadThing.');
  console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log('🗑️  Deleting orphaned files...\n');

  await utapi.deleteFiles(orphanedFiles);
  console.log(`✅ Successfully deleted ${orphanedFiles.length} orphaned files!\n`);
  console.log('🎉 Cleanup completed successfully!');
}

async function cleanupUnusedImages(isDryRun: boolean) {
  const utapi = new UTApi();

  if (isDryRun) {
    console.log('🔍 Running in DRY-RUN mode (no files will be deleted)\n');
  } else {
    console.log('🧹 Starting cleanup of unused images...\n');
  }

  console.log('📊 Fetching used images from database...');

  const categories = await prisma.category.findMany({
    where: { isCustom: true, imageUrl: { not: null } },
    select: { imageUrl: true },
  });

  const products = await prisma.product.findMany({
    where: { isCustom: true, imageUrl: { not: null } },
    select: { imageUrl: true },
  });

  const usedUrls = new Set<string>();
  categories.forEach((cat) => {
    if (cat.imageUrl) usedUrls.add(cat.imageUrl);
  });
  products.forEach((prod) => {
    if (prod.imageUrl) usedUrls.add(prod.imageUrl);
  });

  console.log(`✅ Found ${usedUrls.size} images in use`);
  console.log(`   - Categories: ${categories.length}`);
  console.log(`   - Products: ${products.length}\n`);

  const usedFileKeys = new Set<string>();
  usedUrls.forEach((url) => {
    const fileKey = url.split('/f/')[1];
    if (fileKey) usedFileKeys.add(fileKey);
  });

  console.log(`🔑 Extracted ${usedFileKeys.size} file keys from URLs\n`);

  console.log('☁️  Fetching files from UploadThing...');
  const uploadThingFiles = await utapi.listFiles();

  if (!uploadThingFiles.files || uploadThingFiles.files.length === 0) {
    console.log('ℹ️  No files found in UploadThing storage');
    return;
  }

  console.log(`✅ Found ${uploadThingFiles.files.length} files in UploadThing\n`);

  const unusedFiles = uploadThingFiles.files.filter((file) => !usedFileKeys.has(file.key));

  if (unusedFiles.length === 0) {
    console.log('✨ No unused files found. Storage is clean!');
    return;
  }

  console.log(`🗑️  Found ${unusedFiles.length} unused files:\n`);

  unusedFiles.forEach((file, index) => {
    const uploadDate = new Date(file.uploadedAt).toLocaleDateString('ru-RU');
    const sizeKB = (file.size / 1024).toFixed(2);
    console.log(`   ${index + 1}. ${file.name}`);
    console.log(`      Key: ${file.key}`);
    console.log(`      Size: ${sizeKB} KB`);
    console.log(`      Uploaded: ${uploadDate}\n`);
  });

  const totalSize = unusedFiles.reduce((sum, file) => sum + file.size, 0);
  const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
  console.log(`📦 Total size to free: ${totalSizeMB} MB\n`);

  if (isDryRun) {
    console.log('ℹ️  DRY-RUN: Files that WOULD be deleted:\n');
    console.log(`   - Would delete: ${unusedFiles.length} files`);
    console.log(`   - Would free: ${totalSizeMB} MB`);
    console.log(`   - Remaining in use: ${usedFileKeys.size} files\n`);
    console.log('💡 Run without --dry-run to actually delete these files');
    console.log('   Command: npm run cleanup-images');
  } else {
    console.log('🗑️  Deleting unused files...\n');

    const fileKeysToDelete = unusedFiles.map((file) => file.key);
    const batchSize = 10;
    let deletedCount = 0;

    for (let i = 0; i < fileKeysToDelete.length; i += batchSize) {
      const batch = fileKeysToDelete.slice(i, i + batchSize);

      try {
        await utapi.deleteFiles(batch);
        deletedCount += batch.length;
        console.log(`   Deleted ${deletedCount}/${fileKeysToDelete.length} files...`);
      } catch (error) {
        console.error(`   ❌ Error deleting batch ${i / batchSize + 1}:`, error);
      }
    }

    console.log(`\n✅ Cleanup completed!`);
    console.log(`   - Deleted: ${deletedCount} files`);
    console.log(`   - Freed: ${totalSizeMB} MB`);
    console.log(`   - Remaining in use: ${usedFileKeys.size} files`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const isDryRun = rest.includes('--dry-run');

  if (!command || !commands.includes(command as Command)) {
    usage();
    process.exit(command ? 1 : 0);
  }

  if (command === 'cleanup-orphaned-files') {
    await cleanupOrphanedFiles();
  } else if (command === 'cleanup-unused-images') {
    await cleanupUnusedImages(isDryRun);
  }
}

main()
  .catch((error) => {
    console.error('DB files error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
