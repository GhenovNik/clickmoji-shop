'use client';

import { useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { User } from '@/hooks/admin/useUsers';

interface UsersTableProps {
  users: User[];
  onEdit: (user: User) => void;
  onDelete: (id: string) => void;
}

export default function UsersTable({ users, onEdit, onDelete }: UsersTableProps) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const format = useFormatter();
  const [sortField, setSortField] = useState<'name' | 'email' | 'role' | 'createdAt' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const handleSort = (field: 'name' | 'email' | 'role' | 'createdAt') => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedUsers = [...users].sort((a, b) => {
    if (!sortField) return 0;

    let comparison = 0;
    if (sortField === 'name') {
      const aName = a.name || '';
      const bName = b.name || '';
      comparison = aName.localeCompare(bName, locale);
    } else if (sortField === 'email') {
      comparison = a.email.localeCompare(b.email);
    } else if (sortField === 'role') {
      comparison = a.role.localeCompare(b.role);
    } else if (sortField === 'createdAt') {
      comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }

    return sortDirection === 'asc' ? comparison : -comparison;
  });

  return (
    <>
      {/* Desktop Table View */}
      <div className="hidden md:block bg-white rounded-xl shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('email')}
                >
                  <div className="flex items-center gap-1">
                    Email
                    {sortField === 'email' && (
                      <span className="text-blue-600">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('name')}
                >
                  <div className="flex items-center gap-1">
                    {t('columns.userName')}
                    {sortField === 'name' && (
                      <span className="text-blue-600">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('role')}
                >
                  <div className="flex items-center gap-1">
                    {t('columns.role')}
                    {sortField === 'role' && (
                      <span className="text-blue-600">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('columns.activity')}
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('createdAt')}
                >
                  <div className="flex items-center gap-1">
                    {t('columns.registeredAt')}
                    {sortField === 'createdAt' && (
                      <span className="text-blue-600">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedUsers.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{user.email}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{user.name || '—'}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 py-1 text-xs font-semibold rounded-full ${
                        user.role === 'ADMIN'
                          ? 'bg-purple-100 text-purple-800'
                          : 'bg-green-100 text-green-800'
                      }`}
                    >
                      {user.role === 'ADMIN' ? t('usersTable.roleAdmin') : t('usersTable.roleUser')}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">
                      {t('usersTable.listsCount', { count: user._count.lists })}
                    </div>
                    <div className="text-sm text-gray-600">
                      {t('usersTable.completedCount', { count: user.completedSessions })}
                    </div>
                    <div className="text-sm text-gray-500">
                      {t('usersTable.favoritesCount', { count: user._count.favorites })}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-500">
                      {format.dateTime(new Date(user.createdAt), {
                        day: 'numeric',
                        month: 'numeric',
                        year: 'numeric',
                      })}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => onEdit(user)}
                      className="text-blue-600 hover:text-blue-900 mr-4"
                    >
                      {t('shared.edit')}
                    </button>
                    <button
                      onClick={() => onDelete(user.id)}
                      className="text-red-600 hover:text-red-900"
                    >
                      {t('shared.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-4">
        {sortedUsers.map((user) => (
          <div key={user.id} className="bg-white rounded-xl shadow-md p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900 truncate">{user.email}</h3>
                <p className="text-sm text-gray-600 mt-1">{user.name || '—'}</p>
              </div>
              <span
                className={`px-2 py-1 text-xs font-semibold rounded-full flex-shrink-0 ${
                  user.role === 'ADMIN'
                    ? 'bg-purple-100 text-purple-800'
                    : 'bg-green-100 text-green-800'
                }`}
              >
                {user.role === 'ADMIN' ? t('usersTable.roleAdminShort') : 'USER'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
              <div>
                <p className="text-gray-500 text-xs">{t('usersTable.lists')}</p>
                <p className="font-medium text-gray-900">{user._count.lists}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs">{t('usersTable.completed')}</p>
                <p className="font-medium text-gray-900">{user.completedSessions}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs">{t('usersTable.favorites')}</p>
                <p className="font-medium text-gray-900">{user._count.favorites}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs">{t('usersTable.registered')}</p>
                <p className="font-medium text-gray-900">
                  {format.dateTime(new Date(user.createdAt), {
                    day: '2-digit',
                    month: '2-digit',
                    year: '2-digit',
                  })}
                </p>
              </div>
            </div>

            <div className="flex gap-2 pt-3 border-t border-gray-100">
              <button
                onClick={() => onEdit(user)}
                className="flex-1 bg-blue-50 text-blue-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors"
              >
                {t('shared.edit')}
              </button>
              <button
                onClick={() => onDelete(user.id)}
                className="flex-1 bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
              >
                {t('shared.delete')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
