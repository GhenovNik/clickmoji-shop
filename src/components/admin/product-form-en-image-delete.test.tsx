import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';
import ProductForm, {
  type FormData as ProductFormData,
} from '@/components/admin/products/ProductForm';

type ProductSubmit = (data: ProductFormData, imageUrl?: string) => Promise<void>;

const noopSubmit: ProductSubmit = async () => undefined;
const submitMock = () => vi.fn(noopSubmit);

// AGE-1626: deleting the English picture while an AI request is in flight must make that
// answer stale. Tests drive the real EmojiPicker and defer the AI response by hand.

const fruitCategories = [
  {
    id: 'c1',
    name: 'Фрукты',
    nameEn: 'Fruits',
    emoji: '🍎',
    isCustom: false,
    imageUrl: null,
  },
];

const savedProduct = {
  id: 'p1',
  name: 'Яблоко',
  nameEn: 'Apple',
  emoji: '🍏',
  isCustom: true,
  imageUrl: 'https://utfs.io/f/old.webp',
  localizedImages: { en: 'https://utfs.io/f/old-en.webp' } as Record<string, string>,
  categoryId: 'c1',
};

const libraryEnOnly = {
  items: [
    {
      id: 'x',
      name: 'ТолькоEN',
      nameEn: 'OnlyEN',
      tags: [],
      imageUrl: 'https://utfs.io/f/en-only.webp',
      locale: 'en',
      groupKey: 'g1',
    },
  ],
};

function renderProductForm(onSubmit = submitMock()) {
  return {
    onSubmit,
    ...renderWithIntl(
      <ProductForm
        product={savedProduct}
        categories={fruitCategories}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubGenerate(generate: Promise<Response>, withLibrary = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/emoji/generate') return generate;
      if (withLibrary && url.startsWith('/api/emoji/library')) {
        return Promise.resolve(new Response(JSON.stringify(libraryEnOnly), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    })
  );
}

async function resolveGenerate(generate: ReturnType<typeof deferred<Response>>, body: unknown) {
  await act(async () => {
    generate.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  await waitFor(() => expect(screen.getByRole('button', { name: /AI/ })).toBeTruthy());
}

function startGeneration() {
  fireEvent.click(screen.getByRole('button', { name: /AI/ }));
}

function deleteSavedEnglish() {
  fireEvent.click(screen.getByRole('button', { name: /убрать английскую версию/i }));
}

async function pickNewEnglish() {
  fireEvent.click(screen.getByRole('button', { name: /библиотека/i }));
  fireEvent.click(await screen.findByRole('button', { name: /толькоen/i }));
  await screen.findByText('Новая (EN)');
}

async function submitAndRead(onSubmit: ReturnType<typeof submitMock>) {
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  return onSubmit.mock.calls[0]!;
}

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AGE-1626 deleting the saved English picture while AI is in flight', () => {
  it('a late success keeps the main picture, leaves EN null and shows no alert', async () => {
    const generate = deferred<Response>();
    stubGenerate(generate.promise);
    const onSubmit = submitMock();
    renderProductForm(onSubmit);

    startGeneration();
    deleteSavedEnglish();

    await resolveGenerate(generate, { imageUrl: 'https://utfs.io/f/late.webp' });

    expect(window.alert).not.toHaveBeenCalled();
    expect(screen.queryByText('Новая')).toBeNull();
    expect(screen.queryByText('Новая (EN)')).toBeNull();
    const current = screen.getByRole('button', { name: /текущее изображение/i });
    expect(current.querySelector('img')?.getAttribute('src')).toContain('old.webp');

    const [data] = await submitAndRead(onSubmit);
    expect(data.imageUrl).toBe('https://utfs.io/f/old.webp');
    // The saved English picture was removed: an explicit removal, not an absent key.
    expect(data.localizedImages).toEqual({ en: null });
  });

  it('an error result after deletion shows no alert', async () => {
    const generate = deferred<Response>();
    stubGenerate(generate.promise);
    renderProductForm();

    startGeneration();
    deleteSavedEnglish();

    await act(async () => {
      generate.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /AI/ })).toBeTruthy());

    expect(window.alert).not.toHaveBeenCalled();
  });

  it('a rejection after deletion shows no alert', async () => {
    const generate = deferred<Response>();
    stubGenerate(generate.promise);
    renderProductForm();

    startGeneration();
    deleteSavedEnglish();

    await act(async () => {
      generate.reject(new Error('network down'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /AI/ })).toBeTruthy());

    expect(window.alert).not.toHaveBeenCalled();
  });
});

describe('AGE-1626 deleting a newly picked English picture while AI is in flight', () => {
  it('a stale success keeps the main picture, leaves EN null and shows no alert', async () => {
    const generate = deferred<Response>();
    stubGenerate(generate.promise, true);
    const onSubmit = submitMock();
    renderProductForm(onSubmit);

    await pickNewEnglish();
    startGeneration();
    fireEvent.click(screen.getByRole('button', { name: /убрать английскую версию/i }));
    expect(screen.queryByText('Новая (EN)')).toBeNull();

    await resolveGenerate(generate, { imageUrl: 'https://utfs.io/f/stale.webp' });

    expect(window.alert).not.toHaveBeenCalled();
    expect(screen.queryByText('Новая')).toBeNull();
    const current = screen.getByRole('button', { name: /текущее изображение/i });
    expect(current.querySelector('img')?.getAttribute('src')).toContain('old.webp');

    const [data] = await submitAndRead(onSubmit);
    expect(data.imageUrl).toBe('https://utfs.io/f/old.webp');
    // The saved English picture was removed: an explicit removal, not an absent key.
    expect(data.localizedImages).toEqual({ en: null });
  });

  it('an error result after deletion shows no alert', async () => {
    const generate = deferred<Response>();
    stubGenerate(generate.promise, true);
    renderProductForm();

    await pickNewEnglish();
    startGeneration();
    fireEvent.click(screen.getByRole('button', { name: /убрать английскую версию/i }));

    await act(async () => {
      generate.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /AI/ })).toBeTruthy());

    expect(window.alert).not.toHaveBeenCalled();
  });

  it('a rejection after deletion shows no alert', async () => {
    const generate = deferred<Response>();
    stubGenerate(generate.promise, true);
    renderProductForm();

    await pickNewEnglish();
    startGeneration();
    fireEvent.click(screen.getByRole('button', { name: /убрать английскую версию/i }));

    await act(async () => {
      generate.reject(new Error('network down'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /AI/ })).toBeTruthy());

    expect(window.alert).not.toHaveBeenCalled();
  });
});
