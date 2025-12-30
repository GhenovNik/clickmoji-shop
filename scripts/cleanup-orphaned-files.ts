import { PrismaClient } from '@prisma/client';
import { UTApi } from 'uploadthing/server';

const prisma = new PrismaClient();
const utapi = new UTApi();

// Extract file key from UploadThing URL
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

async function main() {
  console.log('🧹 Starting orphaned files cleanup...\n');

  try {
    // Get all files from UploadThing
    console.log('📋 Fetching files from UploadThing...');
    const { files } = await utapi.listFiles();

    if (!files || files.length === 0) {
      console.log('✅ No files found in UploadThing');
      return;
    }

    console.log(`📦 Found ${files.length} files in UploadThing\n`);

    // Get all imageUrls from database
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

    // Extract file keys from database URLs
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

    // Find orphaned files
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

    // Ask for confirmation
    console.log('\n⚠️  These files will be PERMANENTLY deleted from UploadThing.');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Delete orphaned files
    console.log('🗑️  Deleting orphaned files...\n');

    try {
      await utapi.deleteFiles(orphanedFiles);
      console.log(`✅ Successfully deleted ${orphanedFiles.length} orphaned files!\n`);
    } catch (error) {
      console.error('❌ Error deleting files:', error);
      throw error;
    }

    console.log('🎉 Cleanup completed successfully!');
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error;
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
