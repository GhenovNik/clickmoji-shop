import { describe, expect, it } from 'vitest';
import {
  getPasswordIssue,
  getPasswordValidationError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password';

describe('getPasswordIssue', () => {
  it('returns a code for an empty password', () => {
    expect(getPasswordIssue('')).toBe('required');
  });

  it('returns a code for a too short password', () => {
    expect(getPasswordIssue('a'.repeat(PASSWORD_MIN_LENGTH - 2) + '1')).toBe('tooShort');
  });

  it('returns a code for a too long password', () => {
    expect(getPasswordIssue('a'.repeat(PASSWORD_MAX_LENGTH) + '1')).toBe('tooLong');
  });

  it('accepts a valid password', () => {
    expect(getPasswordIssue('a'.repeat(PASSWORD_MIN_LENGTH - 1) + '1')).toBeNull();
  });

  it('counts Russian letters as letters', () => {
    expect(getPasswordIssue('пароль12')).toBeNull();
  });

  it('returns codes for a missing letter or digit', () => {
    expect(getPasswordIssue('12345678')).toBe('noLetter');
    expect(getPasswordIssue('abcdefgh')).toBe('noDigit');
  });
});

describe('getPasswordValidationError', () => {
  it('returns null for a valid password', () => {
    expect(getPasswordValidationError('abcdefg1', 'en')).toBeNull();
  });

  it('keeps the Russian text when no locale is given', () => {
    expect(getPasswordValidationError('12345678')).toBe(
      'Пароль должен содержать хотя бы одну букву'
    );
    expect(getPasswordValidationError('abcdefgh')).toBe(
      'Пароль должен содержать хотя бы одну цифру'
    );
    expect(getPasswordValidationError('abc1')).toBe('Пароль должен быть не менее 8 символов');
  });

  it('translates the issue into English', () => {
    expect(getPasswordValidationError('', 'en')).toBe('Password is required');
    expect(getPasswordValidationError('abc1', 'en')).toBe('Password must be at least 8 characters');
    expect(getPasswordValidationError('a'.repeat(PASSWORD_MAX_LENGTH) + '1', 'en')).toBe(
      'Password must be at most 64 characters'
    );
  });
});
