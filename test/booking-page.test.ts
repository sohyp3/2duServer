import { test, expect } from 'bun:test';
import { createApp } from '../src/app';

const app = createApp(':memory:', { allowRegistration: true });
const get = (p: string, method = 'GET') =>
  app.fetch(new Request(`http://localhost${p}`, { method }));

test('page, script and stylesheet', async () => {
  const page = await get('/book/any-slug');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(await page.text()).not.toContain('any-slug');
  const js = await get('/book/app.js');
  expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(await js.text()).not.toContain('innerHTML');
  expect((await get('/book/app.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
});
test('other paths 404', async () => {
  for (const p of ['/book/', '/book/UPPER', '/book/a/b'])
    expect((await get(p)).status).toBe(404);
  expect((await get('/book/x', 'POST')).status).toBe(404);
});
