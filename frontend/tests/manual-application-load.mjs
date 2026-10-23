import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage();
  let dashboardRequests = 0;
  await page.route('**/api/dashboard', async route => {
    dashboardRequests++;
    await route.fulfill({ status: 503, contentType: 'application/json',
                          body: JSON.stringify({ error: 'Synthetic discovery unavailable' }) });
  });
  await page.route('**/api/applications/summary', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ today: '2026-09-30', weekly_count: 0, due_count: 0, overdue_count: 0 })
  }));
  await page.goto((process.env.UI_URL || 'http://127.0.0.1:3347') + '/applications/new');
  await page.getByRole('form', { name: '投案表單' }).waitFor({ timeout: 5000 });
  assert.equal(dashboardRequests, 0, 'manual referrals must work without discovery');
  console.log('PASS manual referral form independent of unavailable discovery');
} finally {
  await browser.close();
}
