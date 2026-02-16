import { describe, expect, it } from 'vitest';
import { getPasswordValidationError, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password';

describe('getPasswordValidationError', () => {
  it('returns error for empty password', () => {
    expect(getPasswordValidationError('')).not.toBeNull();
  });

  it('returns error for too short password', () => {
    const shortPassword = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);
    expect(getPasswordValidationError(shortPassword)).not.toBeNull();
  });

  it('returns error for too long password', () => {
    const longPassword = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);
    expect(getPasswordValidationError(longPassword)).not.toBeNull();
  });

  it('accepts valid password length', () => {
    const validPassword = 'a'.repeat(PASSWORD_MIN_LENGTH - 1) + '1';
    expect(getPasswordValidationError(validPassword)).toBeNull();
  });

  it('returns error when password has no letters', () => {
    expect(getPasswordValidationError('12345678')).toBe(
      'Пароль должен содержать хотя бы одну букву'
    );
  });

  it('returns error when password has no digits', () => {
    expect(getPasswordValidationError('abcdefgh')).toBe(
      'Пароль должен содержать хотя бы одну цифру'
    );
  });
});
