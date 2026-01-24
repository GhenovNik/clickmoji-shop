export const PASSWORD_MIN_LENGTH = 6;

export function getPasswordValidationError(password: string) {
  if (!password) {
    return 'Пароль обязателен';
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Пароль должен быть не менее ${PASSWORD_MIN_LENGTH} символов`;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Пароль должен быть не более ${PASSWORD_MAX_LENGTH} символов`;
  }

  return null;
}
