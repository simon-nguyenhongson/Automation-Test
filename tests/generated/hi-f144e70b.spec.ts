import { test, expect } from '@playwright/test';

// Sinh tự động từ Capture Studio — tc_f144e70b
test('hi', async ({ page }) => {
  await page.locator('#folder-row-8 > td:nth-of-type(2) > div').first().click();
  await page.locator('input').first().fill('ABC');
  await page.locator('input').first().press('Enter');
  await page.locator('input').first().fill('ABC');
  await page.locator('input').first().press('Enter');
  await page.locator('div:nth-of-type(6) > a').first().click();
  await page.locator('header > div:nth-of-type(1) > div:nth-of-type(1) > a').first().click();
  await page.locator('#hero_user_email').first().fill('HI');
  await page.locator('#hero_user_email').first().press('Enter');
  await page.locator('#hero_user_email').first().fill('HI');
  await page.locator('#hero_user_email').first().press('Enter');
  await page.locator('#FormControl--_R_9l8l_ > div > button').first().click();
  await page.locator('div > div:nth-of-type(2) > div > div > div:nth-of-type(2) > a').first().click();
  await page.locator('form:nth-of-type(2) > button').first().click();
  await page.locator('#identifierId').first().fill('simon');
  await page.locator('#identifierId').first().press('Enter');
  await page.locator('#identifierId').first().fill('simon');
  await page.locator('#identifierId').first().press('Enter');
});
