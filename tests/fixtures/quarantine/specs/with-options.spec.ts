import { test } from '@playwright/test';

test('uploads a large file', { annotation: { type: 'slow', description: 'big fixture' } }, async ({ page }) => {
  await page.goto('/upload');
});
