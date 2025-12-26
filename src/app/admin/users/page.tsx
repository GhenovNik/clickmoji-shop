'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useUsers, type User, type UserFormData } from '@/hooks/admin/useUsers';
import UserForm from '@/components/admin/users/UserForm';
import UsersTable from '@/components/admin/users/UsersTable';

export default function AdminUsersPage() {
  const { users, loading, createUser, updateUser, deleteUser } = useUsers();
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const handleSubmit = async (formData: UserFormData) => {
    if (editingUser) {
      await updateUser(editingUser.id, formData);
    } else {
      await createUser(formData);
    }
    resetForm();
  };

  const handleEdit = (user: User) => {
    setEditingUser(user);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    await deleteUser(id);
  };

  const resetForm = () => {
    setEditingUser(null);
    setShowForm(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-lg text-gray-600">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <Link
            href="/admin"
            className="text-blue-600 hover:text-blue-700 text-sm mb-4 inline-block"
          >
            ← Назад в админ-панель
          </Link>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Пользователи</h1>
              <p className="text-gray-600 mt-2">Всего пользователей: {users.length}</p>
            </div>
            <button
              onClick={() => setShowForm(!showForm)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors whitespace-nowrap"
            >
              {showForm ? 'Отмена' : '+ Добавить'}
            </button>
          </div>
        </div>

        {showForm && <UserForm user={editingUser} onSubmit={handleSubmit} onCancel={resetForm} />}

        <UsersTable users={users} onEdit={handleEdit} onDelete={handleDelete} />
      </div>
    </div>
  );
}
