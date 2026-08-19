import { test, expect } from '@playwright/test';

// Sinh tự động từ Capture Studio — tc_7c0db650
test('2', async ({ page }) => {
  await page.goto('https://github.com/firecrawl/firecrawl');
  await expect(page.locator('div > span:nth-of-type(4)').first()).toContainText('Public');
  await expect(page.locator('div > span:nth-of-type(4)').first()).toBeEnabled();
  await page.locator('li:nth-of-type(3) > div > a').first().click();
  await page.goto('https://github.com/firecrawl/firecrawl');
  await page.locator('#folder-row-3 > td:nth-of-type(2) > div > div > div > div > a').first().click();
});
