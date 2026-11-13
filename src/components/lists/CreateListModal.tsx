'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Modal, { ModalBody, ModalFooter } from '@/components/ui/Modal';

interface CreateListModalProps {
  onClose: () => void;
  onCreate: (name: string) => Promise<boolean>;
}

export default function CreateListModal({ onClose, onCreate }: CreateListModalProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const t = useTranslations('lists');

  const handleCreate = async () => {
    setCreating(true);
    const success = await onCreate(name);
    setCreating(false);

    if (success) {
      setName('');
      onClose();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreate();
    }
  };

  return (
    <Modal
      label={t('createModal.title')}
      onClose={onClose}
      closeDisabled={creating}
      className="max-w-md"
    >
      <h2 className="modal-header text-2xl font-bold text-gray-900">{t('createModal.title')}</h2>
      <ModalBody>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={t('createModal.namePlaceholder')}
          className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 text-gray-900"
          autoFocus
        />
      </ModalBody>
      <ModalFooter className="flex gap-4">
        <button
          onClick={() => {
            onClose();
            setName('');
          }}
          className="flex-1 px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-semibold transition-colors"
        >
          {t('createModal.cancel')}
        </button>
        <button
          onClick={handleCreate}
          disabled={creating || !name.trim()}
          className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-semibold transition-colors disabled:opacity-50"
        >
          {creating ? t('createModal.creating') : t('createModal.create')}
        </button>
      </ModalFooter>
    </Modal>
  );
}
