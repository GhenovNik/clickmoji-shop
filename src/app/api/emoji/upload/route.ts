import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { UTApi } from 'uploadthing/server';

const utapi = new UTApi();

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const { base64, productName } = await request.json();

    if (!base64) {
      return NextResponse.json({ error: 'Base64 image is required' }, { status: 400 });
    }

    // Extract base64 data (remove data:image/png;base64, prefix if present)
    const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Generate file name
    const fileName = `ai-emoji-${productName?.toLowerCase().replace(/\s+/g, '-') || 'product'}-${Date.now()}.png`;

    // Create File object for upload
    const file = new File([new Uint8Array(imageBuffer)], fileName, { type: 'image/png' });

    // Upload to UploadThing
    console.log('📤 Uploading finalized emoji to UploadThing:', fileName);
    const uploadResult = await utapi.uploadFiles(file);

    if (!uploadResult || uploadResult.error) {
      console.error('Upload error:', uploadResult?.error);
      return NextResponse.json({ error: 'Failed to upload image to storage' }, { status: 500 });
    }

    const imageUrl = uploadResult.data?.url;

    if (!imageUrl) {
      return NextResponse.json({ error: 'Upload succeeded but no URL returned' }, { status: 500 });
    }

    console.log('✅ Finalized emoji uploaded:', imageUrl);

    return NextResponse.json({
      imageUrl,
      fileName,
    });
  } catch (error) {
    console.error('Error uploading emoji:', error);
    return NextResponse.json({ error: 'Failed to upload emoji' }, { status: 500 });
  }
}
