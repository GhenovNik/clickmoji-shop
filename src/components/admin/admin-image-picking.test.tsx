import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';
import { messages } from '@/i18n/messages';
import ProductForm from '@/components/admin/products/ProductForm';
import CategoryForm from '@/components/admin/categories/CategoryForm';
import EmojiPicker from '@/components/admin/shared/EmojiPicker';

// AGE-1620: image picking in the admin product/category forms. Tests drive the forms and
// the picker the way an operator does; they fail until the FR-1..FR-4 implementation lands.

const category = {
  id: 'c1',
  name: 'Фрукты',
  nameEn: 'Fruits',
  emoji: '🍎',
  isCustom: false,
  imageUrl: null,
  order: 1,
};

const fruitCategories = [category];

const savedProduct = {
  id: 'p1',
  name: 'Яблоко',
  nameEn: 'Apple',
  emoji: '🍏',
  isCustom: true,
  imageUrl: 'https://utfs.io/f/old.webp',
  imageUrlEn: 'https://utfs.io/f/old-en.webp',
  categoryId: 'c1',
};

const plainProduct = {
  ...savedProduct,
  imageUrlEn: null as string | null,
};

const createObjectURLMock = vi.fn(() => 'blob:file-preview');
const revokeObjectURLMock = vi.fn();

function stubObjectUrls() {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURLMock,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURLMock,
  });
}

function renderProductForm(product = savedProduct, onSubmit = vi.fn(async () => undefined)) {
  return {
    onSubmit,
    ...renderWithIntl(
      <ProductForm
        product={product}
        categories={fruitCategories}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    ),
  };
}

const categoryShape = {
  id: 'cat1',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: true,
  imageUrl: 'https://utfs.io/f/cat.webp',
  order: 1,
};

function renderCategoryForm(
  categoryProp: typeof categoryShape | null = categoryShape,
  onSubmit = vi.fn(async () => undefined)
) {
  return {
    onSubmit,
    ...renderWithIntl(
      <CategoryForm category={categoryProp} nextOrder={2} onSubmit={onSubmit} onCancel={vi.fn()} />
    ),
  };
}

function selectFile(container: HTMLElement, name = 'new.png') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['fake-image'], name, { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

function mockFetch(
  routes: Array<{ url: string | RegExp; method?: string; body?: unknown; status?: number }>
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(
      (r) =>
        (typeof r.url === 'string' ? url === r.url : r.url.test(url)) &&
        (r.method ?? 'GET') === (init?.method ?? 'GET')
    );
    if (!route) {
      return new Response(JSON.stringify({ error: `unmocked ${init?.method ?? 'GET'} ${url}` }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

beforeEach(() => {
  stubObjectUrls();
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

describe('AC-1 large image view', () => {
  it('product form: the saved preview opens in a dialog and closes via the close button with focus back', async () => {
    renderProductForm(savedProduct);

    const preview = screen.getByRole('button', { name: /текущее изображение/i });
    fireEvent.click(preview);

    const dialog = screen.getByRole('dialog');
    const img = dialog.querySelector('img');
    expect(img?.getAttribute('src')).toContain('old.webp');

    fireEvent.click(within(dialog).getByRole('button', { name: /закрыть/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(preview).toHaveFocus();
  });

  it('product form: the dialog closes on Escape and returns focus to the preview', () => {
    renderProductForm(savedProduct);

    const preview = screen.getByRole('button', { name: /текущее изображение/i });
    fireEvent.click(preview);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(preview).toHaveFocus();
  });

  it('product form: the dialog closes on backdrop click', () => {
    renderProductForm(savedProduct);

    fireEvent.click(screen.getByRole('button', { name: /текущее изображение/i }));
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.click(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('product form: the English-version preview opens the same picture', () => {
    renderProductForm(savedProduct);

    fireEvent.click(screen.getByRole('button', { name: /английская версия/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain('old-en.webp');
  });

  it('product form: a newly selected file shows a preview button that opens the large view', () => {
    const { container } = renderProductForm(plainProduct);

    selectFile(container, 'pick.png');

    const preview = screen.getByRole('button', { name: /pick\.png|новая/i });
    fireEvent.click(preview);
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
      'blob:file-preview'
    );
  });

  it('product form: an AI-generated image shows a preview button that opens the large view', async () => {
    mockFetch([
      {
        url: '/api/emoji/generate',
        method: 'POST',
        body: { imageUrl: 'https://utfs.io/f/ai.webp' },
      },
    ]);
    renderProductForm(plainProduct);

    fireEvent.click(screen.getByRole('button', { name: /AI/ }));

    const preview = await screen.findByRole('button', { name: /новая/i });
    fireEvent.click(preview);
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toContain(
      'ai.webp'
    );
  });

  it('category form: the saved preview opens in a dialog and closes via the close button with focus back', () => {
    renderCategoryForm();

    const preview = screen.getByRole('button', { name: /категори|картинк/i });
    fireEvent.click(preview);

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain('cat.webp');

    fireEvent.click(within(dialog).getByRole('button', { name: /закрыть/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(preview).toHaveFocus();
  });

  it('category form: the dialog closes on Escape and returns focus to the preview', () => {
    renderCategoryForm();

    const preview = screen.getByRole('button', { name: /категори|картинк/i });
    fireEvent.click(preview);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(preview).toHaveFocus();
  });

  it('category form: a selected file shows a preview button that opens the large view', () => {
    const { container } = renderCategoryForm(null);

    selectFile(container, 'cat-new.png');

    const preview = screen.getByRole('button', { name: /cat-new\.png|превью/i });
    fireEvent.click(preview);
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
      'blob:file-preview'
    );
  });
});

describe('AC-2 unchecking the custom-image checkbox clears the picture', () => {
  it('form passes an empty picture and isCustom: false to onSubmit', async () => {
    const onSubmit = vi.fn(async () => undefined);
    renderProductForm(savedProduct, onSubmit);

    fireEvent.click(screen.getByRole('checkbox', { name: /кастомное изображение/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [data, imageUrl] = onSubmit.mock.calls[0]!;
    expect(data).toMatchObject({ isCustom: false, imageUrl: '', imageUrlEn: null });
    expect(imageUrl ?? '').toBe('');
  });
});

describe('AC-3 keeping the custom image', () => {
  it('form passes the unchanged picture through', async () => {
    const onSubmit = vi.fn(async () => undefined);
    renderProductForm(savedProduct, onSubmit);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [data, imageUrl] = onSubmit.mock.calls[0]!;
    expect(data).toMatchObject({
      isCustom: true,
      imageUrl: 'https://utfs.io/f/old.webp',
      imageUrlEn: 'https://utfs.io/f/old-en.webp',
    });
    expect(imageUrl).toBe('https://utfs.io/f/old.webp');
  });
});

describe('AC-4 reverting a file selection', () => {
  it('shows Сейчас/Новая and restores the saved picture on "Вернуть прежнюю"', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { calls } = mockFetch([]);
    const { container } = renderProductForm(savedProduct, onSubmit);

    selectFile(container, 'file-b.png');

    expect(screen.getByText('Сейчас')).toBeTruthy();
    expect(screen.getByText('Новая')).toBeTruthy();

    const nowImg = screen.getByText('Сейчас').parentElement!.querySelector('img');
    const newImg = screen.getByText('Новая').parentElement!.querySelector('img');
    expect(nowImg?.getAttribute('src')).toContain('old.webp');
    expect(newImg?.getAttribute('src')).toBe('blob:file-preview');

    fireEvent.click(screen.getByRole('button', { name: /вернуть прежнюю/i }));

    expect(screen.queryByText('Новая')).toBeNull();
    expect(screen.getByRole('button', { name: /текущее изображение/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [data, imageUrl] = onSubmit.mock.calls[0]!;
    expect(data).toMatchObject({ imageUrl: 'https://utfs.io/f/old.webp' });
    expect(imageUrl).toBe('https://utfs.io/f/old.webp');
    expect(calls.some(({ url }) => url.includes('/api/emoji/upload'))).toBe(false);
  });
});

describe('AC-5 new picture from AI and library', () => {
  it('(a) AI via the real EmojiPicker callback: pair is shown, revert restores old', async () => {
    mockFetch([
      {
        url: '/api/emoji/generate',
        method: 'POST',
        body: { imageUrl: 'https://utfs.io/f/new.webp' },
      },
    ]);
    renderProductForm(savedProduct);

    fireEvent.click(screen.getByRole('button', { name: /AI/ }));

    expect(await screen.findByText('Новая')).toBeTruthy();
    expect(screen.getByText('Сейчас')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /вернуть прежнюю/i }));

    expect(screen.queryByText('Новая')).toBeNull();
    expect(screen.getByRole('button', { name: /текущее изображение/i })).toBeTruthy();
  });

  it('(b) AI returning a data:image URL is revertable the same way', async () => {
    mockFetch([
      {
        url: '/api/emoji/generate',
        method: 'POST',
        body: { imageUrl: 'data:image/png;base64,AAAA' },
      },
    ]);
    renderProductForm(savedProduct);

    fireEvent.click(screen.getByRole('button', { name: /AI/ }));

    expect(await screen.findByText('Новая')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /вернуть прежнюю/i }));

    expect(screen.queryByText('Новая')).toBeNull();
    expect(screen.getByRole('button', { name: /текущее изображение/i })).toBeTruthy();
  });

  it('(c) library pick with an English version: revert restores old and old imageUrlEn', async () => {
    mockFetch([
      {
        url: /\/api\/emoji\/library\?q=/,
        body: {
          items: [
            {
              id: 'a',
              name: 'БиблТест',
              nameEn: 'LibTest',
              tags: [],
              imageUrl: 'https://utfs.io/f/lib.webp',
              locale: null,
              groupKey: 'g1',
            },
            {
              id: 'b',
              name: 'БиблТест',
              nameEn: 'LibTest',
              tags: [],
              imageUrl: 'https://utfs.io/f/lib-en.webp',
              locale: 'en',
              groupKey: 'g1',
            },
          ],
        },
      },
    ]);
    renderProductForm(savedProduct);

    fireEvent.click(screen.getByRole('button', { name: /библиотека/i }));
    fireEvent.click(await screen.findByRole('button', { name: /библтест/i }));

    expect(await screen.findByText('Новая')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /вернуть прежнюю/i }));

    expect(screen.queryByText('Новая')).toBeNull();
    expect(screen.getByRole('button', { name: /текущее изображение/i })).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: /английская версия/i })
        .querySelector('img')
        ?.getAttribute('src')
    ).toContain('old-en.webp');
  });

  it('(d) English-only library pick: revert restores the previous imageUrlEn', async () => {
    mockFetch([
      {
        url: /\/api\/emoji\/library\?q=/,
        body: {
          items: [
            {
              id: 'x',
              name: 'ТолькоEN',
              nameEn: 'OnlyEN',
              tags: [],
              imageUrl: 'https://utfs.io/f/en-only.webp',
              locale: 'en',
              groupKey: 'g2',
            },
          ],
        },
      },
    ]);
    renderProductForm(savedProduct);

    fireEvent.click(screen.getByRole('button', { name: /библиотека/i }));
    fireEvent.click(await screen.findByRole('button', { name: /толькоен/i }));

    fireEvent.click(await screen.findByRole('button', { name: /вернуть прежнюю/i }));

    const englishImg = screen
      .getByRole('button', { name: /английская версия/i })
      .querySelector('img');
    expect(englishImg?.getAttribute('src')).toContain('old-en.webp');
  });
});

describe('AC-9 late AI responses are ignored', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('file B selected, AI launched, revert, then the AI answer arrives — it is not applied', async () => {
    const generate = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: RequestInfo | URL) => {
        if (String(url) === '/api/emoji/generate') return generate.promise;
        return Promise.resolve(new Response('{}', { status: 500 }));
      })
    );
    const onSubmit = vi.fn(async () => undefined);
    const { container } = renderProductForm(savedProduct, onSubmit);

    selectFile(container, 'file-b.png');
    fireEvent.click(screen.getByRole('button', { name: /AI/ }));

    fireEvent.click(await screen.findByRole('button', { name: /вернуть прежнюю/i }));

    generate.resolve(
      new Response(JSON.stringify({ imageUrl: 'https://utfs.io/f/c.webp' }), { status: 200 })
    );
    await waitFor(() => expect(window.alert).toHaveBeenCalled());

    expect(screen.queryByText('Новая')).toBeNull();
    expect(screen.getByRole('button', { name: /текущее изображение/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [data, imageUrl] = onSubmit.mock.calls[0]!;
    expect(data.imageUrl).toBe('https://utfs.io/f/old.webp');
    expect(imageUrl).toBe('https://utfs.io/f/old.webp');
  });

  it('file B selected, AI launched, then a library pick — the late AI answer loses, the library stays', async () => {
    const generate = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/emoji/generate') return generate.promise;
        if (u.startsWith('/api/emoji/library')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: 'a',
                    name: 'БиблТест',
                    nameEn: 'LibTest',
                    tags: [],
                    imageUrl: 'https://utfs.io/f/lib.webp',
                    locale: null,
                    groupKey: 'g1',
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 500 }));
      })
    );
    const onSubmit = vi.fn(async () => undefined);
    const { container } = renderProductForm(savedProduct, onSubmit);

    selectFile(container, 'file-b.png');
    fireEvent.click(screen.getByRole('button', { name: /AI/ }));

    fireEvent.click(screen.getByRole('button', { name: /библиотека/i }));
    fireEvent.click(await screen.findByRole('button', { name: /библтест/i }));

    generate.resolve(
      new Response(JSON.stringify({ imageUrl: 'https://utfs.io/f/c.webp' }), { status: 200 })
    );
    await waitFor(() => expect(window.alert).toHaveBeenCalled());

    const newImg = screen.getByText('Новая').parentElement!.querySelector('img');
    expect(newImg?.getAttribute('src')).toContain('lib.webp');

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [, imageUrl] = onSubmit.mock.calls[0]!;
    expect(imageUrl).toBe('https://utfs.io/f/lib.webp');
  });
});

describe('AC-6 EmojiPicker button explanations', () => {
  it('shows three visible hints linked with aria-describedby', () => {
    renderWithIntl(
      <EmojiPicker
        value=""
        onChange={vi.fn()}
        productName="Молоко"
        onGenerateImage={vi.fn()}
        onSelectLibraryImage={vi.fn()}
      />
    );

    const suggest = screen.getByRole('button', { name: /подобрать/i });
    const ai = screen.getByRole('button', { name: /AI/ });
    const library = screen.getByRole('button', { name: /библиотека/i });

    const suggestHint = screen.getByText('Ищет обычный эмодзи по названию');
    const aiHint = screen.getByText('Рисует новую картинку');
    const libraryHint = screen.getByText('Ищет среди уже нарисованных');

    expect(suggest.getAttribute('aria-describedby')).toBe(suggestHint.id);
    expect(ai.getAttribute('aria-describedby')).toBe(aiHint.id);
    expect(library.getAttribute('aria-describedby')).toBe(libraryHint.id);
    expect(suggestHint.id).toBeTruthy();
    expect(aiHint.id).toBeTruthy();
    expect(libraryHint.id).toBeTruthy();
  });

  it('shows only the hints for the buttons that are shown', () => {
    renderWithIntl(
      <EmojiPicker value="" onChange={vi.fn()} productName="Молоко" onGenerateImage={vi.fn()} />
    );

    expect(screen.getByText('Ищет обычный эмодзи по названию')).toBeTruthy();
    expect(screen.getByText('Рисует новую картинку')).toBeTruthy();
    expect(screen.queryByText('Ищет среди уже нарисованных')).toBeNull();
  });

  it('has the hint keys in both ru and en admin.json', () => {
    expect(messages.ru.admin.emojiPicker.suggestHint).toBeTruthy();
    expect(messages.ru.admin.emojiPicker.generateHint).toBeTruthy();
    expect(messages.ru.admin.emojiPicker.libraryHint).toBeTruthy();
    expect(messages.en.admin.emojiPicker.suggestHint).toBeTruthy();
    expect(messages.en.admin.emojiPicker.generateHint).toBeTruthy();
    expect(messages.en.admin.emojiPicker.libraryHint).toBeTruthy();
  });
});
