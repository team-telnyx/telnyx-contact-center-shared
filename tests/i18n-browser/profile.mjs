// Local-only integration test: disposable accounts, real profile APIs and server
// action, independent browser contexts, no telephony provisioning or real calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import puppeteer from 'puppeteer';
import { encode } from 'next-auth/jwt';
const env = {
  ...dotenv.parse(fs.readFileSync('.env')),
  ...(fs.existsSync('.env.local') ? dotenv.parse(fs.readFileSync('.env.local')) : {}),
  ...process.env
};
assert(['localhost', '127.0.0.1', '::1'].includes(env.POSTGRES_HOST || 'localhost'), 'Integration test is local-only');
const origin = process.env.I18N_TEST_ORIGIN || 'http://127.0.0.1:3100';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
const pool = new pg.Pool({
  host: env.POSTGRES_HOST || 'localhost',
  port: Number(env.POSTGRES_PORT) || 5432,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB
});
const users = [randomUUID(), randomUUID()];
let browser, mainPage;
const errors = [];
try {
  const cookies = [];
  for (const [index, id] of users.entries()) {
    const email = `i18n-${id}@example.test`;
    await pool.query(`INSERT INTO users(id,username,first_name,last_name,roles,verified,active,language,ui_locale) VALUES($1,$2,'Locale','Test',ARRAY['owner'],true,true,'en-GB',$3)`, [id, email, index ? 'de-DE' : 'en-US']);
    await pool.query(`INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'voice',false,1,1)`, [id]);
    const token = await encode({
      secret: env.NEXTAUTH_SECRET,
      token: {
        id,
        sub: id,
        email,
        name: 'Locale Test'
      },
      maxAge: 3600
    });
    cookies.push({
      name: 'next-auth.session-token',
      value: token,
      domain: new URL(origin).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax'
    });
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await puppeteer.launch({
    headless: true,
    ...(fs.existsSync(mac) ? {
      executablePath: mac
    } : {}),
    args: process.env.CI ? ['--no-sandbox'] : []
  });
  const contexts = await Promise.all(users.map(() => browser.createBrowserContext()));
  for (let i = 0; i < contexts.length; i++) await contexts[i].setCookie(cookies[i]);
  const page = mainPage = await contexts[0].newPage();
  await page.setViewport({
    width: 1440,
    height: 1000
  });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/profile`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });
  await page.waitForSelector('#uiLocale', {
    timeout: 120000
  });
  assert.equal(await page.$eval('html', e => e.lang), 'en-US');
  const tab = await contexts[0].newPage();
  await tab.goto(`${origin}/profile`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });
  await tab.waitForSelector('#uiLocale', {
    timeout: 120000
  });
  await page.bringToFront();
  await page.click('#nick');
  await page.type('#nick', 'Unchanged customer draft');
  await page.click('#uiLocale');
  await page.waitForSelector('[role="option"]');
  for (const option of await page.$$('[role="option"]')) {
    if ((await option.evaluate(el => el.textContent)).includes('Deutsch')) {
      await option.click();
      break;
    }
  }
  await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
  assert.equal(await page.$eval('#uiLocale', e => e.textContent), 'Deutsch');
  await page.click('form button[type="submit"]');
  await page.waitForFunction(() => document.documentElement.lang === 'de-DE', {
    timeout: 60000
  });
  assert.equal(await page.$eval('#nick', e => e.value), 'Unchanged customer draft');
  await tab.bringToFront();
  await tab.waitForFunction(() => document.documentElement.lang === 'de-DE', {
    timeout: 60000
  });
  await page.bringToFront();
  await page.reload({
    waitUntil: 'domcontentloaded'
  });
  await page.waitForSelector('#uiLocale');
  assert.equal(await page.$eval('html', e => e.lang), 'de-DE');
  const profile = await page.evaluate(() => fetch('/api/user/profile').then(r => r.json()));
  assert.equal(profile.data.ui_locale, 'de-DE');
  assert.equal(profile.data.language, 'en-GB');
  const invalid = await page.evaluate(async () => {
    const r = await fetch('/api/user/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uiLocale: 'ar-SA'
      })
    });
    return {
      status: r.status,
      body: await r.json()
    };
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_UI_LOCALE');
  const second = await contexts[1].newPage();
  await second.goto(`${origin}/profile`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });
  await second.waitForSelector('#uiLocale');
  const saved = await second.evaluate(async () => {
    const r = await fetch('/api/user/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ui_locale: 'fr-FR'
      })
    });
    return r.status;
  });
  assert.equal(saved, 200);
  await second.reload({
    waitUntil: 'domcontentloaded'
  });
  await second.waitForSelector('#uiLocale');
  assert.equal(await second.$eval('html', e => e.lang), 'fr-FR');
  const rows = (await pool.query('SELECT id,ui_locale,language FROM users WHERE id=ANY($1::text[])', [users])).rows;
  assert.equal(rows.find(x => x.id === users[0]).ui_locale, 'de-DE');
  assert.equal(rows.find(x => x.id === users[1]).ui_locale, 'fr-FR');
  assert(rows.every(x => x.language === 'en-GB'));
  // A stale cookie from another account cannot override the authenticated DB preference.
  await contexts[1].setCookie({
    name: 'cc_ui_locale',
    value: 'pl-PL',
    domain: new URL(origin).hostname,
    path: '/'
  });
  const html = await fetch(`${origin}/profile`, {
    headers: {
      cookie: `next-auth.session-token=${cookies[1].value}; cc_ui_locale=pl-PL`
    }
  }).then(r => r.text());
  assert.match(html, /<html[^>]*lang="fr-FR"/);
  assert.equal((await fetch(`${origin}/api/user/profile`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      uiLocale: 'pl-PL'
    })
  })).status, 401);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    passed: true,
    checks: ['profile server action', 'API GET/PUT', 'invalid locale rejected', 'anonymous write rejected', 'speech language preserved', 'two accounts isolated', 'reload persistence', 'cookie precedence', 'second tab refresh', 'draft retained']
  }));
} catch (error) {
  if (mainPage) {
    console.log(JSON.stringify({
      url: mainPage.url(),
      locale: await mainPage.$eval('html', e => e.lang),
      errors,
      pageText: (await mainPage.$eval('body', e => e.innerText)).slice(-3500)
    }));
    await mainPage.screenshot({
      path: '/private/tmp/cc-i18n-profile-failure.png',
      fullPage: true
    });
  }
  throw error;
} finally {
  await browser?.close();
  await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
  await pool.end();
}
