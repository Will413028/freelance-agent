import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ui = process.env.UI_URL || 'http://127.0.0.1:3337';
const python = spawn(process.env.PYTHON || fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url)), ['-B', '-u', '-c', `
import tempfile
from pathlib import Path
from freelance.bootstrap.store import SQLiteStore
from freelance.bootstrap.api import create_server
from datetime import datetime, timezone
with tempfile.TemporaryDirectory() as directory:
    store = SQLiteStore(Path(directory) / 'cases.db')
    store.migrate()
    base = dict(source='tasker', external_id='agent', title='AI agent Python 自動化', company='Example Studio',
                description='Build an AI agent with Python API integrations, tests, deployment and documentation.',
                url='https://example.invalid/agent', kind='fixed', currency='TWD', budget_min=5000,
                budget_max=10000, weekly_hours=25, taiwan_eligible=True, timezone_compatible=True,
                location_evidence=[{'name': 'Taiwan'}], complete=True, deadline='2099-01-01', language='zh-TW')
    store.ingest(base)
    store.ingest(base | dict(source='freelancer', external_id='copy'))
    store.ingest(base | dict(source='himalayas', external_id='backend', title='Backend Python API',
                            url='https://example.invalid/backend', kind='hourly', weekly_hours=None,
                            taiwan_eligible=None, budget_min=None, budget_max=None))
    store.ingest(base | dict(external_id='fulltime', title='Full time backend API',
                            url='https://example.invalid/fulltime', kind='full_time'))
    store.ingest_resend_batch([base | dict(receipt_id='resend:synthetic-alternative',
                                           description='Alternate only wording: Python integration scope differs.',
                                           budget_min=7000, weekly_hours=15)])
    store.set_source_health('tasker', 'ok')
    store.set_source_health('himalayas', 'failed')
    now = datetime(2026, 9, 30, 1, tzinfo=timezone.utc)
    store.claim_daily_run('2026-09-30', 'synthetic@example.invalid', now)
    intent = store.create_digest('2026-09-30', 'synthetic@example.invalid', now)
    store.claim_digest(intent['id'])
    store.finish_digest(intent['id'], 'sent', 'synthetic-receipt')
    store.finish_daily_run('2026-09-30', 'synthetic@example.invalid', 'failed', {
        'source_details': {'tasker': {'status': 'partial', 'seen': 85, 'jobs': 1,
                                     'rejected_count': 1, 'complete_scan': False}}}, now)
    server = create_server(0, store, mode='sqlite')
    print(server.server_port, flush=True)
    server.serve_forever()
`], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
const lines = createInterface({ input: python.stdout });
let browser;
try {
  const [line] = await once(lines, 'line');
  const port = Number(line);
  assert.ok(port > 0);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  const routeAPI = async target => {
    target.setDefaultTimeout(10000);
    target.on('pageerror', error => errors.push(error.message));
    await target.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/api', '');
      const response = await target.request.fetch(`http://127.0.0.1:${port}${path}`, {
        method: request.method(), data: request.postData() || undefined,
        headers: { Origin: 'http://127.0.0.1:3327', 'Content-Type': 'application/json' }
      });
      await route.fulfill({ response });
    });
  };
  await routeAPI(page);
  await page.goto(ui);
  await page.locator('.job-card').first().waitFor();
  assert.equal(await page.locator('.job-card').count(), 2);
  assert.equal(await page.getByLabel('申請稿', { exact: true }).count(), 0);
  await page.getByLabel('平台', { exact: true }).selectOption('freelancer');
  assert.equal(await page.locator('.job-card').count(), 1);
  assert.equal(await page.locator('.source-links a').count(), 2);
  assert.equal(await page.locator('.content-versions article').count(), 2);
  assert.match(await page.locator('.content-conflicts').innerText(), /預算下限/);
  assert.match(await page.locator('.content-conflicts').innerText(), /每週工時/);
  assert.match(await page.locator('.content-conflicts').innerText(), /Alternate only wording/);
  const conflictDigest = await page.request.get(`http://127.0.0.1:${port}/digest`);
  assert.match(await conflictDigest.text(), /同職缺通知內容有差異/);
  await page.getByRole('button', { name: '收藏職缺', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已加入收藏' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '收藏', exact: true }).click();
  await page.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
  assert.equal(await page.locator('.job-card').count(), 1);
  await page.getByRole('button', { name: '略過', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已略過' }).waitFor();
  assert.equal(await page.locator('.job-card').count(), 0);
  const digest = await page.request.get(`http://127.0.0.1:${port}/digest`);
  assert.ok(!(await digest.text()).includes('AI agent Python 自動化'));
  await page.getByRole('button', { name: '已略過', exact: true }).click();
  await page.getByRole('button', { name: '恢復待看', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已恢復待看' }).waitFor();
  await page.getByRole('button', { name: '待看', exact: true }).click();
  await page.getByLabel('搜尋職缺').fill('Python 自動化');
  assert.equal(await page.locator('.job-card').count(), 1);
  await page.getByLabel('搜尋職缺').fill('Alternate only wording');
  assert.equal(await page.locator('.job-card').count(), 1);
  await page.getByLabel('搜尋職缺').fill('');
  await page.getByLabel('合作型態').selectOption('hourly');
  assert.equal(await page.locator('.job-card').count(), 1);
  assert.match(await page.locator('.job-facts').innerText(), /待確認/);
  await page.getByLabel('合作型態').selectOption('');

  const second = await browser.newPage();
  await routeAPI(second);
  await second.goto(ui);
  await second.getByRole('button', { name: '篩選設定', exact: true }).click();
  await second.getByLabel('每週工時上限', { exact: true }).fill('25');
  await page.getByRole('button', { name: '篩選設定', exact: true }).click();
  assert.equal(await page.getByLabel('每週工時上限', { exact: true }).inputValue(), '30');
  await page.getByLabel('每週工時上限', { exact: true }).fill('20');
  await page.getByRole('button', { name: '儲存篩選設定' }).click();
  await page.getByRole('status').filter({ hasText: '篩選設定已儲存' }).waitFor();
  assert.equal(await page.locator('.job-card').count(), 2);
  assert.match(await page.locator('.job-facts').innerText(), /15 小時/);
  assert.match(await page.locator('.detail').innerText(), /主卡依.*另一份通知內容顯示/);
  const identities = [...(await page.locator('.detail').innerText()).matchAll(/版本識別 ([0-9a-f]{12})/g)].map(match => match[1]);
  assert.ok(identities.length >= 3 && identities.slice(1).includes(identities[0]));
  await second.getByRole('button', { name: '儲存篩選設定' }).click();
  await second.getByRole('alert').filter({ hasText: '已更新' }).waitFor();
  assert.equal(await second.getByLabel('每週工時上限', { exact: true }).inputValue(), '25');
  await second.close();
  await page.reload();
  await page.getByRole('button', { name: '篩選設定', exact: true }).click();
  assert.equal(await page.getByLabel('每週工時上限', { exact: true }).inputValue(), '20');
  await page.getByLabel('每週工時上限', { exact: true }).fill('30');
  await page.getByRole('button', { name: '儲存篩選設定' }).click();
  await page.getByRole('status').filter({ hasText: '篩選設定已儲存' }).waitFor();
  await page.locator('.job-card').filter({ hasText: 'AI agent Python 自動化' }).click();
  await page.getByText('來源狀態', { exact: true }).click();
  await page.getByText('讀取失敗或不完整', { exact: true }).waitFor();
  await page.getByText('Email 結果 · 已寄出', { exact: true }).waitFor();
  await page.getByText('2026-09-30 每日收案：部分資料取得', { exact: true }).waitFor();
  await page.getByText('讀取 85 筆 · 初篩 1 筆 · 拒收 1 筆', { exact: true }).waitFor();

  // These requests must be rejected before the proxy can reach any upstream.
  assert.equal((await fetch(ui + '/api/preferences', {
    method: 'POST', headers: { Host: '127.0.0.1:3327', Origin: 'https://attacker.invalid' }, body: '{}'
  })).status, 403);
  assert.equal((await fetch(ui + '/api/review/' + 'a'.repeat(24), {
    method: 'POST', headers: { Host: '127.0.0.1:3327', Origin: 'http://127.0.0.1:3327' }, body: '{}'
  })).status, 403);
  assert.equal((await page.request.post(`http://127.0.0.1:${port}/review/` + 'a'.repeat(24), {
    headers: { Origin: 'http://127.0.0.1:3327' }, data: { action: 'approve', version: 1 }
  })).status(), 404);
  await mkdir(root + '/runtime', { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: root + '/runtime/discovery-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: root + '/runtime/discovery-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('link', { name: '記錄已投案', exact: true }).click();
  await page.getByLabel('投案表單').waitFor();
  await page.getByLabel('簡短備註').fill('synthetic private application note');
  await page.getByRole('button', { name: '儲存投案紀錄' }).click();
  await page.getByRole('status').filter({ hasText:'投案紀錄已儲存' }).waitFor();
  let applicationList = await (await page.request.get(`http://127.0.0.1:${port}/applications`)).json();
  assert.equal(applicationList.total, 1);
  assert.equal(applicationList.items[0].opportunity_ids.length, 2);
  const appliedDashboard = await (await page.request.get(`http://127.0.0.1:${port}/dashboard`)).json();
  const linked = appliedDashboard.items.find(item => item.job.title==='AI agent Python 自動化');
  assert.equal(linked.candidate, false);
  assert.ok(linked.application_ids.length === 1);
  assert.ok(!JSON.stringify(appliedDashboard).includes('synthetic private application note'));
  await page.goto(ui + '/applications');
  await page.locator('.application-card').waitFor();
  await page.getByRole('button', { name:'編輯', exact:true }).click();
  await page.getByLabel('簡短備註').fill('my unsaved draft');
  const row=applicationList.items[0];
  const updateBody=Object.fromEntries(['title','contact','url','applied_on','stage','follow_up_on','note','revision'].map(key=>[key,row[key]]));
  updateBody.note='concurrent edit';
  const concurrent=await page.request.patch(`http://127.0.0.1:${port}/applications/${row.id}`,{
    headers:{ Origin:'http://127.0.0.1:3327' },data:updateBody
  });
  assert.equal(concurrent.status(),200);
  await page.getByRole('button', { name:'儲存投案紀錄' }).click();
  await page.getByRole('alert').filter({ hasText:'已更新' }).waitFor();
  assert.equal(await page.getByLabel('簡短備註').inputValue(),'my unsaved draft');
  await page.getByRole('button', { name:'讀取最新版本' }).click();
  await page.getByText('最新備註：concurrent edit', { exact:true }).waitFor();
  await page.getByRole('button', { name:'已核對，保留我的表單繼續編輯' }).click();
  assert.equal(await page.getByLabel('簡短備註').inputValue(),'my unsaved draft');
  await page.getByLabel('目前階段').selectOption('negotiating');
  await page.getByRole('button', { name:'儲存投案紀錄' }).click();
  await page.getByRole('status').filter({ hasText:'投案紀錄已更新' }).waitFor();
  await page.screenshot({ path:root+'/runtime/applications-desktop.png',fullPage:true });
  await page.setViewportSize({ width:390,height:844 });
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('link',{name:'新增手動機會'}).click();
  await page.getByLabel('機會名稱').fill('熟人轉介 API 專案');
  await page.getByLabel('公司／聯絡對象').fill('Synthetic contact');
  await page.getByLabel('簡短備註').fill('手動測試');
  await page.getByRole('button',{name:'儲存投案紀錄'}).click();
  await page.getByRole('status').filter({hasText:'投案紀錄已儲存'}).waitFor();
  await page.goto(ui+'/applications');
  await page.locator('.application-card').filter({hasText:'熟人轉介 API 專案'}).waitFor();
  applicationList=await(await page.request.get(`http://127.0.0.1:${port}/applications`)).json();
  assert.equal(applicationList.total,2);
  assert.equal(applicationList.items.find(row=>row.title==='熟人轉介 API 專案').opportunity_ids.length,0);
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('.application-card').filter({hasText:'熟人轉介 API 專案'}).getByRole('button',{name:'刪除'}).click();
  await page.getByRole('status').filter({hasText:'投案紀錄已刪除'}).waitFor();
  assert.equal(await page.locator('.application-card').count(),1);
  await page.screenshot({path:root+'/runtime/applications-mobile.png',fullPage:true});
  assert.equal((await fetch(ui+'/api/applications/'+row.id,{
    method:'PATCH',headers:{Host:'127.0.0.1:3327',Origin:'https://attacker.invalid'},body:'{}'
  })).status,403);
  assert.deepEqual(errors, []);
  console.log('PASS: synthetic SQLite grouping, content versions, filters, save/skip/restore, preferences, conflict, reload, digest, proxy boundaries, mobile');
} finally {
  if (browser) await browser.close();
  lines.close();
  python.kill('SIGTERM');
}
