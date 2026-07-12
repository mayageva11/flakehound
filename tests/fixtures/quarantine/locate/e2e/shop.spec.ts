import { test, expect } from '@playwright/test';

test('pays with saved card', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByText('Paid')).toBeVisible();
});
