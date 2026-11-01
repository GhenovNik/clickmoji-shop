import { describe, expect, it } from 'vitest';
import { resolveLocale } from './config';
import { messages } from './messages';

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') result.set(path, value);
    else for (const [k, v] of leaves(value, path)) result.set(k, v);
  }
  return result;
}

// ICU arguments ({count}, {name}) a message expects; plural/select keywords are not arguments.
function argumentsOf(message: string) {
  return [...message.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*(?:[,}])/g)].map((m) => m[1]).sort();
}

describe('dictionaries', () => {
  const ru = leaves(messages.ru as unknown as Tree);
  const en = leaves(messages.en as unknown as Tree);

  it('have the same keys in Russian and English', () => {
    expect([...en.keys()].sort()).toEqual([...ru.keys()].sort());
  });

  it('use the same arguments in both languages', () => {
    for (const [key, value] of ru) {
      expect(argumentsOf(en.get(key) ?? ''), key).toEqual(argumentsOf(value));
    }
  });

  it('have no empty messages', () => {
    for (const [key, value] of [...ru, ...en]) expect(value.trim(), key).not.toBe('');
  });

  it('keep English free of Cyrillic, except language names', () => {
    for (const [key, value] of en) {
      if (key.startsWith('common.languageNames')) continue;
      expect(/[А-Яа-яЁё]/.test(value), `${key}: ${value}`).toBe(false);
    }
  });
});

describe('resolveLocale', () => {
  it('keeps a saved choice', () => {
    expect(resolveLocale('ru', 'en-US,en;q=0.9')).toBe('ru');
  });

  it('takes the first supported browser language by weight', () => {
    expect(resolveLocale(undefined, 'de-DE,de;q=0.9,ru;q=0.8,en;q=0.5')).toBe('ru');
    expect(resolveLocale(undefined, 'ru-RU')).toBe('ru');
  });

  it('falls back to English for an unknown cookie or language', () => {
    expect(resolveLocale('fr', 'de-DE')).toBe('en');
    expect(resolveLocale(undefined, null)).toBe('en');
  });
});
