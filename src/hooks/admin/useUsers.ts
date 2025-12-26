'use client';

import { useState, useEffect } from 'react';

export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'USER' | 'ADMIN';
  createdAt: string;
  updatedAt: string;
  completedSessions: number;
  _count: {
    lists: number;
    favorites: number;
  };
}

export interface UserFormData {
  email: string;
  name: string;
  password: string;
  role: 'USER' | 'ADMIN';
}

export function useUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/users');
      if (!res.ok) {
        throw new Error('Failed to fetch users');
      }
      const data = await res.json();
      setUsers(data);
    } catch (error) {
      console.error('Error fetching users:', error);
      alert('Ошибка при загрузке пользователей');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const createUser = async (formData: UserFormData) => {
    if (!formData.password) {
      alert('Пароль обязателен при создании нового пользователя');
      return null;
    }

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          name: formData.name || null,
          role: formData.role,
          password: formData.password,
        }),
      });

      if (res.ok) {
        await fetchUsers();
        return await res.json();
      } else {
        const errorData = await res.json();
        alert(errorData.error || 'Ошибка при создании пользователя');
        return null;
      }
    } catch (error) {
      console.error('Error creating user:', error);
      alert('Ошибка при создании пользователя');
      return null;
    }
  };

  const updateUser = async (userId: string, formData: UserFormData) => {
    try {
      const body: {
        email: string;
        name: string | null;
        role: 'USER' | 'ADMIN';
        password?: string;
      } = {
        email: formData.email,
        name: formData.name || null,
        role: formData.role,
      };

      // Включаем пароль только если он указан
      if (formData.password) {
        body.password = formData.password;
      }

      const res = await fetch(`/api/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        await fetchUsers();
        return await res.json();
      } else {
        const errorData = await res.json();
        alert(errorData.error || 'Ошибка при обновлении пользователя');
        return null;
      }
    } catch (error) {
      console.error('Error updating user:', error);
      alert('Ошибка при обновлении пользователя');
      return null;
    }
  };

  const deleteUser = async (userId: string) => {
    if (
      !confirm('Вы уверены, что хотите удалить этого пользователя? Это действие нельзя отменить.')
    ) {
      return false;
    }

    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        await fetchUsers();
        return true;
      } else {
        const errorData = await res.json();
        alert(errorData.error || 'Ошибка при удалении пользователя');
        return false;
      }
    } catch (error) {
      console.error('Error deleting user:', error);
      alert('Ошибка при удалении пользователя');
      return false;
    }
  };

  return {
    users,
    loading,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
  };
}
