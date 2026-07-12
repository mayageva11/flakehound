import { test, expect } from '@playwright/test';

test.describe('desktop', () => {
  test('renders the banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();
  });
});

test.describe('mobile', () => {
  test('renders the banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();
  });
});
