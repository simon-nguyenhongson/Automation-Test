import { test, expect } from '@playwright/test';

// Sinh tự động từ Capture Studio — tc_82c07246
test('4', async ({ page }) => {
  await page.goto('https://github.com/simon-nguyenhongson/Crawl.git');
  await expect(page.locator('strong > a').first()).toMatchAriaSnapshot('- link "Crawl":\n  - /url: /simon-nguyenhongson/Crawl');
  await page.locator('span:nth-of-type(4)').first().hover();
  await page.locator('span:nth-of-type(4)').first().hover();
  await expect(page.locator('#repository-container-header > div:nth-of-type(1) > div:nth-of-type(1) > div')).toHaveCount(1);
  await expect(page.locator('#insights-tab').first()).toContainText('Insights');
  await expect(page.locator('#insights-tab').first()).toBeVisible();
  await expect(page.locator('#insights-tab').first()).not.toContainText('Insights');
});
