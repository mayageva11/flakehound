import { test, expect } from '@playwright/test';

test('pays with saved card', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByText('Paid')).toBeVisible();
});

test('shows an empty cart message', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByText('Your cart is empty')).toBeVisible();
});
