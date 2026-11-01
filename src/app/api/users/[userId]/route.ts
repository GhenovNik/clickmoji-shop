import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import bcrypt from 'bcryptjs';
import { getRequestLocale } from '@/lib/auth-security';
import { getPasswordValidationError } from '@/lib/validation/password';

export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { userId } = await params;
    const body = await request.json();
    const { email, name, password, role, image } = body;

    // Build an explicit update payload from accepted fields.
    const updateData: {
      email?: string;
      name?: string | null;
      password?: string;
      role?: 'USER' | 'ADMIN';
      image?: string | null;
    } = {};

    if (email) {
      // Ensure the email address is not used by another account.
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          id: { not: userId },
        },
      });

      if (existingUser) {
        return NextResponse.json({ error: await apiText(request, 'emailTaken') }, { status: 400 });
      }

      updateData.email = email;
    }

    if (name !== undefined) updateData.name = name;
    if (role !== undefined) updateData.role = role;
    if (image !== undefined) updateData.image = image;

    // Hash a replacement password when one is provided.
    if (password) {
      const passwordError = getPasswordValidationError(password, getRequestLocale(request));
      if (passwordError) {
        return NextResponse.json({ error: passwordError }, { status: 400 });
      }

      updateData.password = await bcrypt.hash(password, 10);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(user);
  } catch (error) {
    console.error('Error updating user:', error);
    return NextResponse.json(
      { error: await apiText(request, 'updateUserFailed') },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { userId } = await params;

    // Prevent administrators from deleting their own account.
    if (session.user.id === userId) {
      return NextResponse.json(
        { error: await apiText(request, 'cannotDeleteSelf') },
        { status: 400 }
      );
    }

    await prisma.user.delete({
      where: { id: userId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    return NextResponse.json(
      { error: await apiText(request, 'deleteUserFailed') },
      { status: 500 }
    );
  }
}
