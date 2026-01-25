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
    const validPassword = 'a'.repeat(PASSWORD_MIN_LENGTH);
    expect(getPasswordValidationError(validPassword)).toBeNull();
  });
});
