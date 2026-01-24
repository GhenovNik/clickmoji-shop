import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { UTApi } from 'uploadthing/server';

const utapi = new UTApi();

export async function DELETE(request: Request) {
  try {
    const session = await auth();
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { imageUrl } = await request.json();

    if (!imageUrl) {
      return NextResponse.json({ error: 'Image URL is required' }, { status: 400 });
    }

    // Extract file key from UploadThing URL
    // Format: https://utfs.io/f/{fileKey}
    const fileKey = imageUrl.split('/f/')[1];

    if (!fileKey) {
      console.warn('Could not extract file key from URL:', imageUrl);
      return NextResponse.json({ error: 'Invalid image URL format' }, { status: 400 });
    }

    console.log('🗑️ Deleting old emoji from UploadThing:', fileKey);

    await utapi.deleteFiles(fileKey);

    console.log('✅ Old emoji deleted successfully');

    return NextResponse.json({ message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting emoji:', error);
    return NextResponse.json({ error: 'Failed to delete image' }, { status: 500 });
  }
}
