import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ historyId: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { historyId } = await params;

    const history = await prisma.listHistory.findUnique({
      where: { id: historyId, userId: session.user.id },
      select: { id: true },
    });

    if (!history) {
      return NextResponse.json({ error: 'History not found' }, { status: 404 });
    }

    await prisma.listHistory.delete({ where: { id: historyId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting history:', error);
    return NextResponse.json({ error: 'Failed to delete history' }, { status: 500 });
  }
}
