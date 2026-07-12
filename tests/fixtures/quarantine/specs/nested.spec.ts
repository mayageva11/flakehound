import { test, expect } from '@playwright/test';

test.describe('checkout', () => {
  test.describe('with saved card', () => {
    test('pays instantly', async ({ page }) => {
      await page.goto('/checkout');
      await expect(page.getByText('Paid')).toBeVisible();
    });
  });

  test('rejects an expired card', async ({ page }) => {
    await page.goto('/checkout');
    await expect(page.getByText('Card expired')).toBeVisible();
  });
});
