import { test, expect } from '@playwright/test';

// Sinh tự động từ Capture Studio — tc_ffcda48d
test('Luồng khám phá tài liệu', async ({ page }) => {
  await test.step('Mở trang chủ Playwright', async () => {
    await page.goto('https://playwright.dev/');
    await expect(page.locator('.hero__title').first()).toBeVisible();
    await expect(page.locator('.hero__title').first()).toContainText('Playwright');
  });
  await test.step('Mở tài liệu cài đặt', async () => {
    await page.goto('https://playwright.dev/');
    await page.locator('a.getStarted_Sjon').first().click();
    await expect(page.locator('article h1').first()).toContainText('Installation');
  });
});
