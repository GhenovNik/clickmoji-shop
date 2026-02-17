import { test, expect } from '@playwright/test';

function randomEmail() {
  return `qa_${Date.now()}_${Math.floor(Math.random() * 100000)}@example.com`;
}

test.describe('Auth flows', () => {
  test('redirects anonymous user from protected page to login', async ({ page }) => {
    await page.goto('/lists');
    await expect(page).toHaveURL(/\/login/);
  });

  test('registers user and allows login when email verification is not required', async ({
    page,
  }) => {
    const email = randomEmail();
    const password = 'Qwerty123!';

    await page.goto('/register');
    await page.fill('#name', 'QA User');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.fill('#confirmPassword', password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login\?registered=(auto|verify)/);
    const currentUrl = page.url();

    if (currentUrl.includes('registered=verify')) {
      await expect(
        page.getByText('Регистрация успешна! Проверьте почту и подтвердите email.')
      ).toBeVisible();
      return;
    }

    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('http://localhost:3000/');
  });

  test('forgot-password endpoint returns generic response', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.fill('#email', randomEmail());
    await page.click('button[type="submit"]');
    await expect(page.getByText(/Если адрес существует/i)).toBeVisible();
  });
});
