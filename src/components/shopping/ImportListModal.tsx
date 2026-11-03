'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useImportListText, type ImportResults } from '@/hooks/useListMutations';

interface ImportListModalProps {
  listId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function ImportListModal({
  listId,
  isOpen,
  onClose,
  onSuccess,
}: ImportListModalProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResults | null>(null);
  const [reviewingFailed, setReviewingFailed] = useState(false);
  const pending = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importMutation = useImportListText();
  const isImporting = importMutation.isPending;
  const t = useTranslations('lists');
  const locale = useLocale();

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [isOpen, listId]
  );

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending.current) return;
    setError('');
    setResult(null);

    if (!text.trim()) {
      setError(t('importModal.emptyText'));
      return;
    }

    pending.current = true;
    try {
      const data = await importMutation.mutateAsync({ listId, text: text.trim() });

      setResult(data.results);
      setText('');

      try {
        void Promise.resolve(onSuccess?.()).catch((error: unknown) =>
          console.error('Error refreshing imported list:', error)
        );
      } catch (error) {
        console.error('Error refreshing imported list:', error);
      }

      // Keep the result visible briefly before closing the modal. The list behind it is already
      // refetching: the mutation invalidated the list and, when products were created, the catalog.
      if (data.results.failed.length === 0) {
        closeTimer.current = setTimeout(() => {
          handleClose();
        }, 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('importModal.genericError'));
    } finally {
      pending.current = false;
    }
  };

  const handleClose = () => {
    if (pending.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setText('');
    setError('');
    setResult(null);
    setReviewingFailed(false);
    onClose();
  };

  const reviewFailed = () => {
    if (!result || pending.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    // The existing failed DTO has names, not the original quantities/notes. Let
    // the shopper review this subset; never replay the original successful text.
    setText(
      result.failed
        .map((item) => {
          const nameRu = typeof item.product?.nameRu === 'string' ? item.product.nameRu.trim() : '';
          const nameEn = typeof item.product?.nameEn === 'string' ? item.product.nameEn.trim() : '';
          return (
            (locale === 'en' ? nameEn : nameRu) ||
            nameRu ||
            nameEn ||
            t('importModal.unrecognizedEntry')
          );
        })
        .join('\n')
    );
    setResult(null);
    setError('');
    setReviewingFailed(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">{t('importModal.title')}</h2>
          <button
            onClick={handleClose}
            disabled={isImporting}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {!result ? (
          <form onSubmit={handleSubmit}>
            {reviewingFailed && (
              <p role="status" className="text-sm text-amber-800 mb-3">
                {t('importModal.retryFailedHint')}
              </p>
            )}
            <div className="mb-4">
              <label htmlFor="listText" className="block text-sm font-medium text-gray-700 mb-2">
                {t('importModal.textLabel')}
              </label>
              <textarea
                id="listText"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('importModal.textPlaceholder')}
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 font-mono text-sm"
                rows={12}
                autoFocus
                disabled={isImporting}
              />
              {error && (
                <p role="alert" className="text-red-500 text-sm mt-2">
                  {error}
                </p>
              )}
            </div>

            <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg p-4 mb-4">
              <p className="text-sm text-gray-700 font-semibold mb-2 flex items-center gap-2">
                <span>✨</span>
                <span>{t('importModal.aiTitle')}</span>
              </p>
              <ul className="text-sm text-gray-600 space-y-1 ml-6">
                <li>• {t('importModal.aiRecognize')}</li>
                <li>• {t('importModal.aiCategories')}</li>
                <li>• {t('importModal.aiIcons')}</li>
                <li>• {t('importModal.aiQuantities')}</li>
                <li>• {t('importModal.aiCreate')}</li>
              </ul>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleClose}
                disabled={isImporting}
                className="flex-1 px-4 py-3 border-2 border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {t('importModal.cancel')}
              </button>
              <button
                type="submit"
                disabled={isImporting || !text.trim()}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isImporting ? (
                  <>
                    <span className="animate-spin">⏳</span>
                    <span>{t('importModal.importing')}</span>
                  </>
                ) : (
                  <>
                    <span>✨</span>
                    <span>{t('importModal.import')}</span>
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p
                role="status"
                className="text-green-800 font-semibold mb-2 flex items-center gap-2"
              >
                <span>✅</span>
                <span>
                  {t(
                    result.failed.length
                      ? result.added.length || result.created.length
                        ? 'importModal.partialTitle'
                        : 'importModal.failedOnlyTitle'
                      : 'importModal.doneTitle'
                  )}
                </span>
              </p>
              <div className="text-sm text-green-700 space-y-1">
                <p>
                  • {t('importModal.addedLabel')} <strong>{result.added?.length || 0}</strong>
                </p>
                <p>
                  • {t('importModal.createdLabel')} <strong>{result.created?.length || 0}</strong>
                </p>
                {result.skipped?.length > 0 && (
                  <p>
                    • {t('importModal.skippedLabel')} <strong>{result.skipped.length}</strong>
                  </p>
                )}
                {result.failed?.length > 0 && (
                  <p className="text-red-600">
                    • {t('importModal.failedLabel')} <strong>{result.failed.length}</strong>
                  </p>
                )}
              </div>
            </div>

            {result.created && result.created.length > 0 && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <p className="font-semibold text-purple-900 mb-2">
                  {t('importModal.createdTitle')}
                </p>
                <div className="space-y-1 text-sm text-purple-700">
                  {result.created.map((item, i) => (
                    <p key={i}>
                      • {item.name} ({item.category}){item.note && ` - ${item.note}`}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {result.skipped && result.skipped.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="font-semibold text-yellow-900 mb-2">
                  {t('importModal.skippedTitle')}
                </p>
                <div className="space-y-1 text-sm text-yellow-700">
                  {result.skipped.map((item, i) => (
                    <p key={i}>
                      • {item.name} - {item.reason}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {result.failed && result.failed.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="font-semibold text-red-900 mb-2">{t('importModal.failedTitle')}</p>
                <div className="space-y-1 text-sm text-red-700">
                  {result.failed.map((item, i) => (
                    <p key={i}>
                      •{' '}
                      {(locale === 'en' &&
                        typeof item.product?.nameEn === 'string' &&
                        item.product.nameEn) ||
                        (typeof item.product?.nameRu === 'string' && item.product.nameRu) ||
                        t('importModal.unrecognizedEntry')}
                      : {String(item.reason)}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {result.failed.length ? (
              <button
                type="button"
                onClick={reviewFailed}
                className="text-blue-600 underline text-sm"
              >
                {t('importModal.retryFailed')}
              </button>
            ) : (
              <p className="text-center text-gray-500 text-sm">
                {t('importModal.closingIn', { seconds: 3 })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
