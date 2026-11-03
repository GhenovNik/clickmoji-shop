'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Modal, { ModalBody, ModalFooter } from '@/components/ui/Modal';

interface BulkImportModalProps {
  onClose: () => void;
  onImportComplete: () => void;
}

export default function BulkImportModal({ onClose, onImportComplete }: BulkImportModalProps) {
  const t = useTranslations('admin');
  const [bulkImportText, setBulkImportText] = useState('');
  const [bulkImporting, setBulkImporting] = useState(false);

  const handleBulkImport = async () => {
    if (!bulkImportText.trim()) {
      alert(t('bulkImport.enterNames'));
      return;
    }

    const productNames = bulkImportText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (productNames.length === 0) {
      alert(t('bulkImport.noNames'));
      return;
    }

    setBulkImporting(true);

    try {
      const res = await fetch('/api/products/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productNames }),
      });

      const data = await res.json();

      if (res.ok) {
        const { results } = data;
        alert(
          t('bulkImport.done', {
            added: results.success.length,
            failed: results.failed.length,
          })
        );

        if (results.failed.length > 0) {
          console.log('Failed products:', results.failed);
        }

        setBulkImportText('');
        onImportComplete();
        onClose();
      } else {
        alert(
          t('bulkImport.errorWithReason', { error: data.error || t('bulkImport.importFailed') })
        );
      }
    } catch (error) {
      console.error('Bulk import error:', error);
      alert(t('bulkImport.importError'));
    } finally {
      setBulkImporting(false);
    }
  };

  return (
    <Modal
      label={t('bulkImport.title')}
      onClose={onClose}
      closeDisabled={bulkImporting}
      className="max-w-2xl"
    >
      <div className="modal-header border-b border-gray-200">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-900">{t('bulkImport.title')}</h2>
        <p className="text-sm text-gray-500 mt-2">{t('bulkImport.description')}</p>
      </div>

      <ModalBody>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('bulkImport.namesLabel')}
          </label>
          <textarea
            value={bulkImportText}
            onChange={(e) => setBulkImportText(e.target.value)}
            placeholder={t('bulkImport.placeholder')}
            className="w-full h-64 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-gray-900 font-mono"
            disabled={bulkImporting}
          />
          <p className="text-xs text-gray-500 mt-2">
            {t('bulkImport.count', {
              count: bulkImportText.split('\n').filter((l) => l.trim()).length,
            })}
          </p>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-semibold text-blue-900 mb-2">{t('bulkImport.howItWorks')}</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>{t('bulkImport.stepTranslate')}</li>
            <li>{t('bulkImport.stepCategories')}</li>
            <li>{t('bulkImport.stepEmoji')}</li>
            <li>{t('bulkImport.stepFallback')}</li>
          </ul>
        </div>
      </ModalBody>

      <ModalFooter>
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={handleBulkImport}
            disabled={bulkImporting || !bulkImportText.trim()}
            className="flex-1 bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bulkImporting ? t('bulkImport.processing') : t('bulkImport.import')}
          </button>
          <button
            onClick={onClose}
            disabled={bulkImporting}
            className="flex-1 sm:flex-none px-6 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
          >
            {t('shared.cancel')}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
