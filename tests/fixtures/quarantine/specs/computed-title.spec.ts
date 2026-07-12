import { test } from '@playwright/test';

for (const region of ['us', 'eu']) {
  test(`loads the ${region} dashboard`, async ({ page }) => {
    await page.goto(`/${region}`);
  });
}
