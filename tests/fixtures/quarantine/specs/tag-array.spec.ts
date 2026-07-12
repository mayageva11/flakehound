import { test } from '@playwright/test';

test('reconciles accounts', { tag: ['@slow', '@nightly'] }, async ({ page }) => {
  await page.goto('/accounts');
});
