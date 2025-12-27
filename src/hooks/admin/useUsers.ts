import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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

// API functions
const fetchUsersAPI = async (): Promise<User[]> => {
  const res = await fetch('/api/users');
  if (!res.ok) throw new Error('Failed to fetch users');
  return res.json();
};

const createUserAPI = async (formData: UserFormData) => {
  if (!formData.password) {
    throw new Error('Пароль обязателен при создании нового пользователя');
  }

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

  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error || 'Ошибка при создании пользователя');
  }

  return res.json();
};

const updateUserAPI = async (userId: string, formData: UserFormData) => {
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

  if (formData.password) {
    body.password = formData.password;
  }

  const res = await fetch(`/api/users/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error || 'Ошибка при обновлении пользователя');
  }

  return res.json();
};

const deleteUserAPI = async (userId: string) => {
  const res = await fetch(`/api/users/${userId}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error || 'Ошибка при удалении пользователя');
  }

  return res.json();
};

// React Query Hook
export function useUsers() {
  const queryClient = useQueryClient();

  // Query for fetching users
  const {
    data: users = [],
    isLoading: loading,
    refetch: fetchUsers,
  } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsersAPI,
  });

  // Mutation for creating user
  const createMutation = useMutation({
    mutationFn: createUserAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: Error) => {
      alert(error.message);
    },
  });

  // Mutation for updating user
  const updateMutation = useMutation({
    mutationFn: ({ userId, formData }: { userId: string; formData: UserFormData }) =>
      updateUserAPI(userId, formData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: Error) => {
      alert(error.message);
    },
  });

  // Mutation for deleting user
  const deleteMutation = useMutation({
    mutationFn: deleteUserAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: Error) => {
      alert(error.message);
    },
  });

  // Wrapper functions to maintain API compatibility
  const createUser = async (formData: UserFormData) => {
    try {
      return await createMutation.mutateAsync(formData);
    } catch (error) {
      return null;
    }
  };

  const updateUser = async (userId: string, formData: UserFormData) => {
    try {
      return await updateMutation.mutateAsync({ userId, formData });
    } catch (error) {
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
      await deleteMutation.mutateAsync(userId);
      return true;
    } catch (error) {
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
