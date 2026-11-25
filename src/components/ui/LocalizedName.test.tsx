import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { LocalizedName } from './LocalizedName';
import { namesOf } from '@/lib/catalog-name';
import { renderWithIntl } from '@/test/intl';

const zucchini = { name: 'Кабачок', nameEn: 'Zucchini' };

describe('LocalizedName', () => {
  it('in Russian draws the Russian name big and the English name small under it', () => {
    const { container } = renderWithIntl(<LocalizedName names={namesOf(zucchini)} locale="ru" />);

    const big = screen.getByText('Кабачок');
    const small = screen.getByText('Zucchini');
    expect(big.getAttribute('lang')).toBe('ru');
    expect(small.getAttribute('lang')).toBe('en');
    expect(big.compareDocumentPosition(small) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toBe('КабачокZucchini');
  });

  it('in English draws only the English name', () => {
    const { container } = renderWithIntl(<LocalizedName names={namesOf(zucchini)} locale="en" />, {
      locale: 'en',
    });

    expect(screen.getByText('Zucchini').getAttribute('lang')).toBe('en');
    expect(container.textContent).toBe('Zucchini');
  });

  it('in English without an English name draws the Russian name and no small line', () => {
    const { container } = renderWithIntl(
      <LocalizedName names={namesOf({ name: 'Кабачок', nameEn: '' })} locale="en" />,
      { locale: 'en' }
    );

    expect(container.textContent).toBe('Кабачок');
  });

  it('draws no small line when the English name equals the Russian one', () => {
    const { container } = renderWithIntl(
      <LocalizedName names={namesOf({ name: 'Ketchup', nameEn: 'Ketchup' })} locale="ru" />
    );

    expect(container.textContent).toBe('Ketchup');
  });

  it('draws an invented language big and the English name small', () => {
    const { container } = renderWithIntl(
      <LocalizedName names={{ ru: 'Кабачок', en: 'Zucchini', zz: 'Zuqqini' }} locale="zz" />
    );

    expect(screen.getByText('Zuqqini').getAttribute('lang')).toBe('zz');
    expect(screen.getByText('Zucchini').getAttribute('lang')).toBe('en');
    expect(container.textContent).toBe('ZuqqiniZucchini');
  });

  it('primaryOnly in Russian draws the Russian name only, with no English line', () => {
    const { container } = renderWithIntl(
      <LocalizedName names={namesOf(zucchini)} locale="ru" primaryOnly />
    );

    expect(screen.getByText('Кабачок').getAttribute('lang')).toBe('ru');
    expect(screen.queryByText('Zucchini')).toBeNull();
    expect(container.textContent).toBe('Кабачок');
  });

  it('primaryOnly in English draws the English name only', () => {
    const { container } = renderWithIntl(
      <LocalizedName names={namesOf(zucchini)} locale="en" primaryOnly />,
      { locale: 'en' }
    );

    expect(container.textContent).toBe('Zucchini');
  });

  it('primaryOnly with an invented language draws only that name big', () => {
    const { container } = renderWithIntl(
      <LocalizedName
        names={{ ru: 'Кабачок', en: 'Zucchini', zz: 'Zuqqini' }}
        locale="zz"
        primaryOnly
      />
    );

    expect(screen.getByText('Zuqqini').getAttribute('lang')).toBe('zz');
    expect(screen.queryByText('Zucchini')).toBeNull();
    expect(container.textContent).toBe('Zuqqini');
  });

  it('keeps the English line for products and variants by default', () => {
    const { container } = renderWithIntl(<LocalizedName names={namesOf(zucchini)} locale="ru" />);

    expect(container.textContent).toBe('КабачокZucchini');
  });

  it('appends its suffix to the big line', () => {
    renderWithIntl(<LocalizedName names={namesOf(zucchini)} locale="en" suffix=" (3)" />, {
      locale: 'en',
    });

    expect(screen.getByText('Zucchini (3)')).toBeTruthy();
  });
});
