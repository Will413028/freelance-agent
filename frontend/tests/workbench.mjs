import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const python=spawn(fileURLToPath(new URL('../../backend/.venv/bin/python',import.meta.url)),['-B','-u','-c',`
import tempfile
from pathlib import Path
from datetime import datetime,timezone
from freelance.bootstrap.store import SQLiteStore
from freelance.bootstrap.api import create_server
with tempfile.TemporaryDirectory() as root:
    store=SQLiteStore(Path(root)/'synthetic.sqlite',clock=lambda:datetime(2026,10,1,tzinfo=timezone.utc))
    store.migrate()
    server=create_server(0,store,mode='sqlite')
    print(server.server_port,flush=True)
    server.serve_forever()
`],{cwd:root,stdio:['ignore','pipe','inherit']});
let browser;
try {
  const [line]=await once(createInterface({input:python.stdout}),'line');const port=Number(line);assert.ok(port>0);
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const page=await browser.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));let dashboards=0;
  await page.route('**/api/**',async route=>{
    const request=route.request();const u=new URL(request.url());const path=u.pathname.replace('/api','')+u.search;
    if(path.startsWith('/dashboard'))dashboards++;
    const response=await page.request.fetch(`http://127.0.0.1:${port}${path}`,{method:request.method(),data:request.postData()||undefined,headers:{Origin:'http://127.0.0.1:3327','Content-Type':'application/json'}});
    await route.fulfill({response});
  });
  const ui=process.env.UI_URL||'http://127.0.0.1:3347';
  await page.goto(ui+'/clients');
  await page.getByRole('heading',{name:'客戶與聯絡人',exact:true}).waitFor();
  await page.getByLabel('客戶名稱',{exact:true}).fill('Synthetic Client');
  await page.getByRole('button',{name:'建立客戶',exact:true}).click();
  await page.getByRole('button',{name:'Synthetic Client',exact:true}).waitFor();
  await page.getByRole('button',{name:'Synthetic Client',exact:true}).click();
  await page.getByLabel('聯絡人名稱',{exact:true}).fill('Synthetic Person');
  await page.getByLabel('聯絡方式',{exact:true}).fill('person@example.test');
  await page.getByRole('button',{name:'建立聯絡人',exact:true}).click();
  await page.getByText('Synthetic Person',{exact:true}).waitFor();
  await page.goto(ui+'/proposals');
  await page.getByLabel('提案名稱',{exact:true}).fill('Synthetic Proposal');
  await page.getByLabel('提案正文',{exact:true}).fill('First body');
  await page.getByRole('button',{name:'建立草稿',exact:true}).click();
  await page.getByRole('heading',{name:'Synthetic Proposal',exact:true}).waitFor();
  await page.getByLabel('編輯正文',{exact:true}).fill('Second body');
  await page.getByRole('button',{name:'儲存新版本',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已追加新版本'}).waitFor();
  await page.getByLabel('草稿版本',{exact:true}).selectOption('1');
  assert.match(await page.locator('[data-testid="selected-body"]').innerText(),/First body/);
  await page.getByRole('link',{name:'準備外部送出',exact:true}).click();
  await page.getByLabel('寄件者',{exact:true}).fill('sender@example.test');
  await page.getByLabel('收件者',{exact:true}).fill('recipient@example.test');
  await page.getByLabel('郵件主旨',{exact:true}).fill('Synthetic subject');
  await page.getByRole('button',{name:'建立送出預覽',exact:true}).click();
  await page.getByRole('heading',{name:'核對完整送出內容',exact:true}).waitFor();
  assert.match(await page.locator('[data-testid="submission-body"]').innerText(),/First body/);
  await page.getByLabel('我已核對這份內容、目的地及費用').check();
  await page.getByRole('button',{name:'核准這份內容',exact:true}).click();
  await page.getByText('已核准，尚未送出',{exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'確認送出',exact:true}).isDisabled());
  assert.equal((await (await page.request.get(`http://127.0.0.1:${port}/applications`)).json()).total,0);
  assert.equal(dashboards,0,'manual workbench must not load discovery');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS synthetic client/contact, draft history, exact approval, disabled sender and mobile');
} finally {if(browser)await browser.close();python.kill('SIGTERM');}
