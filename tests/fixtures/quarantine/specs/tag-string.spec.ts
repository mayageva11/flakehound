import { test } from '@playwright/test';

test('syncs the ledger', { tag: '@slow' }, async ({ page }) => {
  await page.goto('/ledger');
});
