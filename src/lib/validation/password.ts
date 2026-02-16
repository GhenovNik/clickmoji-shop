export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

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

  if (!/[A-Za-zА-Яа-я]/.test(password)) {
    return 'Пароль должен содержать хотя бы одну букву';
  }

  if (!/\d/.test(password)) {
    return 'Пароль должен содержать хотя бы одну цифру';
  }

  return null;
}
