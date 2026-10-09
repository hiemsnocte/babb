const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareSite, validateCatalog } = require('../scripts/prepare-site.cjs');

const NOW = new Date('2026-10-10T03:00:00.000Z');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const ids = ['beoksan', 'theeats', 'bombom'];
const catalog = [
  ...ids.map((id) => ({ id, name: id, source: { type: 'capture' }, ...(id === 'bombom' ? { priceWon: 9000, closedDays: [0] } : {}) })),
  { id: 'beerpan', name: '생앤맥주판', source: { type: 'static', path: './assets/menus/beerpan.jpg' }, priceWon: 8000, links: [{ label: '인스타그램', url: 'https://www.instagram.com/beerpan__d0n/' }] },
];

function typed(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(typed) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typed(item)])) } };
}

function document(restaurants = ids.map((id) => ({ id, name: id, imageUrl: `https://example.test/${id}.png`, stale: id === 'bombom' }))) {
  const result = typed({ date: '2026-10-10', restaurants, captureErrors: [{ id: 'bombom', error: 'Previous image retained' }] }).mapValue;
  result.fields.updatedAt = { timestampValue: '2026-10-10T02:50:00.000Z' };
  return result;
}

function forecast() {
  return { timezone: 'Asia/Seoul', latitude: 37.4868, longitude: 126.8876, hourly: { time: ['2026-10-10T12:00', '2026-10-10T13:00'], temperature_2m: [20.5, 21], weathercode: [1, 2] } };
}

async function fixture(t, handler) {
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babb-site-test-'));
  t.after(() => fs.rm(publicDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(publicDir, 'config.json'), JSON.stringify({ firebase: { projectId: 'test-project', apiKey: 'public-key' } }));
  await fs.writeFile(path.join(publicDir, 'restaurants.json'), JSON.stringify(catalog));
  await fs.mkdir(path.join(publicDir, 'assets/menus'), { recursive: true });
  await fs.writeFile(path.join(publicDir, 'assets/menus/beerpan.jpg'), PNG);
  const requests = [];
  return {
    publicDir,
    requests,
    run: (extra = {}) => prepareSite({ publicDir, now: NOW, env: {}, logger: { warn() {}, log() {} }, sleep: async () => {}, fetchImpl: async (url, options) => {
      requests.push(url);
      const custom = await handler?.(url, options);
      if (custom) return custom;
      if (url.includes('firestore.googleapis.com')) return Response.json(document());
      if (url.includes('open-meteo.com')) return Response.json(forecast());
      return new Response(PNG);
    }, ...extra }),
  };
}

test('publishes captured and fixed menus in catalog order without an extra external request', async (t) => {
  const site = await fixture(t);
  const result = await site.run();
  const stored = JSON.parse(await fs.readFile(path.join(site.publicDir, 'data/menus.json'), 'utf8'));
  assert.deepEqual(stored, result.menus);
  assert.equal(stored.updatedAt, '2026-10-10T02:50:00.000Z');
  assert.equal(stored.restaurants[2].stale, true);
  assert.equal(stored.captureErrors[0].id, 'bombom');
  assert.deepEqual(stored.restaurants.map((restaurant) => restaurant.id), [...ids, 'beerpan']);
  assert.equal(stored.restaurants[0].menuType, 'daily');
  assert.equal(stored.restaurants[3].menuType, 'fixed');
  assert.equal(stored.restaurants[3].stale, false);
  assert.deepEqual(stored.restaurants[3].links, catalog[3].links);
  assert.equal(stored.restaurants[2].priceWon, 9000);
  assert.deepEqual(stored.restaurants[2].closedDays, [0]);
  assert.equal(stored.restaurants[3].priceWon, 8000);
  assert.deepEqual(stored.restaurants[3].closedDays, []);
  const { normalizeMenu } = await import('../public/menu-core.mjs');
  assert.deepEqual(normalizeMenu(stored).restaurants, stored.restaurants, 'published metadata reaches the browser without depending on the capture document');
  for (const restaurant of stored.restaurants) {
    assert.match(restaurant.imageUrl, /^\.\/data\/images\/[a-z]+-[a-f0-9]{16}\.png$/);
    assert.deepEqual(await fs.readFile(path.join(site.publicDir, restaurant.imageUrl)), PNG);
  }
  assert.equal(site.requests.length, 5);
  assert.equal(result.weather.fetchedAt, NOW.toISOString());
});

test('partial image failure leaves existing menu, images, and weather byte-for-byte intact', async (t) => {
  let broken = false;
  const site = await fixture(t, (url) => broken && url.endsWith('bombom.png') ? new Response('<html>blocked</html>') : null);
  await site.run();
  const menuPath = path.join(site.publicDir, 'data/menus.json');
  const before = await fs.readFile(menuPath);
  const imageNames = await fs.readdir(path.join(site.publicDir, 'data/images'));
  const previousWeather = await fs.readFile(path.join(site.publicDir, 'data/weather.json'));
  broken = true;
  await assert.rejects(site.run(), /not a supported image/);
  assert.deepEqual(await fs.readFile(menuPath), before);
  assert.deepEqual(await fs.readdir(path.join(site.publicDir, 'data/images')), imageNames);
  assert.deepEqual(await fs.readFile(path.join(site.publicDir, 'data/weather.json')), previousWeather);
  assert.deepEqual((await fs.readdir(site.publicDir)).sort(), ['assets', 'config.json', 'data', 'restaurants.json']);
});

test('missing restaurant prevents deployment instead of publishing a partial menu', async (t) => {
  const site = await fixture(t, (url) => url.includes('firestore.googleapis.com') ? Response.json(document([{ id: 'beoksan', name: 'one', imageUrl: 'https://example.test/one.png' }])) : null);
  await assert.rejects(site.run(), /Missing or invalid menu: theeats/);
  await assert.rejects(fs.access(path.join(site.publicDir, 'data')), { code: 'ENOENT' });
  assert.equal(site.requests.length, 1);
});

test('weather failure still publishes menus and omits unavailable weather', async (t) => {
  const site = await fixture(t, (url) => url.includes('open-meteo.com') ? new Response('unavailable', { status: 503 }) : null);
  const result = await site.run();
  assert.equal(result.menus.restaurants.length, 4);
  assert.equal(result.weather, undefined);
  await assert.rejects(fs.access(path.join(site.publicDir, 'data/weather.json')), { code: 'ENOENT' });
  assert.equal(site.requests.filter((url) => url.includes('open-meteo.com')).length, 2);
});

test('weather failure retains a valid recent cache but drops stale cache', async (t) => {
  let unavailable = false;
  const site = await fixture(t, (url) => unavailable && url.includes('open-meteo.com') ? new Response('blocked', { status: 403 }) : null);
  await site.run();
  unavailable = true;
  const cached = await site.run({ now: new Date(NOW.getTime() + 60 * 60 * 1000) });
  assert.equal(cached.weather.fetchedAt, NOW.toISOString());
  const expired = await site.run({ now: new Date(NOW.getTime() + 13 * 60 * 60 * 1000) });
  assert.equal(expired.weather, undefined);
  await assert.rejects(fs.access(path.join(site.publicDir, 'data/weather.json')), { code: 'ENOENT' });
});

test('transient image HTTP errors retry once, permanent errors and oversized bodies fail closed', async (t) => {
  let hits = 0;
  const site = await fixture(t, (url) => url.endsWith('beoksan.png') && ++hits === 1 ? new Response('busy', { status: 503 }) : null);
  await site.run();
  assert.equal(hits, 2);
  let permanentHits = 0;
  const failed = await fixture(t, (url) => {
    if (url.endsWith('beoksan.png')) { permanentHits += 1; return new Response('forbidden', { status: 403 }); }
    return null;
  });
  await assert.rejects(failed.run(), /beoksan image fetch failed/);
  assert.equal(permanentHits, 1);
  const oversized = await fixture(t, (url) => url.endsWith('bombom.png') ? new Response(PNG, { headers: { 'content-length': String(13 * 1024 * 1024) } }) : null);
  await assert.rejects(oversized.run(), /bombom image fetch failed/);
  await assert.rejects(fs.access(path.join(oversized.publicDir, 'data')), { code: 'ENOENT' });
});

test('environment can override public Firebase config without exposing keys in errors', async (t) => {
  const site = await fixture(t, (url) => url.includes('firestore.googleapis.com') ? new Response('denied', { status: 403 }) : null);
  await assert.rejects(site.run({ env: { FIREBASE_PROJECT_ID: 'override', FIREBASE_API_KEY: 'private-test-key' } }), (error) => {
    assert.equal(error.message, 'Menu document fetch failed');
    return true;
  });
  assert.ok(site.requests[0].includes('/projects/override/'));
  assert.ok(site.requests[0].endsWith('key=private-test-key'));
});

test('image timeout is bounded and retains the previous deployment', async (t) => {
  const site = await fixture(t);
  await site.run();
  const previous = await fs.readFile(path.join(site.publicDir, 'data/menus.json'));
  await assert.rejects(site.run({ timeoutMs: 10, attempts: 1, fetchImpl: async (url, { signal }) => {
    if (url.includes('firestore.googleapis.com')) return Response.json(document());
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } }), /timeout/);
  assert.deepEqual(await fs.readFile(path.join(site.publicDir, 'data/menus.json')), previous);
});

test('invalid weather response cannot replace the optional cache or block menu updates', async (t) => {
  const site = await fixture(t, (url) => url.includes('open-meteo.com') ? Response.json({ ...forecast(), hourly: { ...forecast().hourly, weathercode: [null, 2] } }) : null);
  const result = await site.run();
  assert.equal(result.weather, undefined);
  assert.equal(result.menus.restaurants.length, 4);
});

test('adding another captured restaurant requires its menu and preserves configured ordering and names', async (t) => {
  const extra = { id: 'next', name: '새 식당', source: { type: 'capture' } };
  let complete = false;
  const site = await fixture(t, (url) => {
    if (!url.includes('firestore.googleapis.com') || !complete) return null;
    return Response.json(document([{ id: 'next', name: 'old name', imageUrl: 'https://example.test/next.png' }, ...ids.map((id) => ({ id, name: id, imageUrl: `https://example.test/${id}.png` }))]));
  });
  await fs.writeFile(path.join(site.publicDir, 'restaurants.json'), JSON.stringify([extra, ...catalog]));
  await assert.rejects(site.run(), /Missing or invalid menu: next/);
  complete = true;
  const result = await site.run();
  assert.deepEqual(result.menus.restaurants.map((restaurant) => restaurant.id), ['next', ...ids, 'beerpan']);
  assert.equal(result.menus.restaurants[0].name, '새 식당');
});

test('fixed-only catalog publishes without a Firebase config or Firestore request', async (t) => {
  const site = await fixture(t);
  await fs.writeFile(path.join(site.publicDir, 'restaurants.json'), JSON.stringify([catalog[3]]));
  await fs.rm(path.join(site.publicDir, 'config.json'));
  const result = await site.run({ now: new Date('2026-10-10T23:00:00.000Z') });
  assert.equal(result.menus.restaurants.length, 1);
  assert.equal(result.menus.date, '2026-10-11');
  assert.equal(site.requests.length, 1);
  assert.ok(site.requests[0].includes('open-meteo.com'));
});

test('invalid fixed image retains the entire previous publication', async (t) => {
  const site = await fixture(t);
  await site.run();
  const previous = await fs.readFile(path.join(site.publicDir, 'data/menus.json'));
  const images = await fs.readdir(path.join(site.publicDir, 'data/images'));
  await fs.writeFile(path.join(site.publicDir, 'assets/menus/beerpan.jpg'), '<html>not a menu</html>');
  await assert.rejects(site.run(), /not a supported image/);
  assert.deepEqual(await fs.readFile(path.join(site.publicDir, 'data/menus.json')), previous);
  assert.deepEqual(await fs.readdir(path.join(site.publicDir, 'data/images')), images);
});

test('catalog rejects duplicate IDs, unsafe static paths, and non-HTTPS links', () => {
  assert.throws(() => validateCatalog([...catalog, catalog[0]]), /unique and safe/);
  for (const staticPath of ['../menu.jpg', './assets/menus/../config.json', './assets/menus/%2e%2e/menu.jpg', 'C:/menu.jpg', './assets/menus/folder\\menu.jpg', './assets/menus/../../secret.jpg']) {
    assert.throws(() => validateCatalog([{ ...catalog[3], source: { type: 'static', path: staticPath } }]), /Invalid static menu path/);
  }
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:password@example.com']) {
    assert.throws(() => validateCatalog([{ ...catalog[3], links: [{ label: '소식', url }] }]), /Invalid restaurant link/);
  }
});

test('invalid price or closed days fail before fetching and keep the previous publication', async (t) => {
  const site = await fixture(t);
  await site.run();
  const previous = await fs.readFile(path.join(site.publicDir, 'data/menus.json'));
  const requestCount = site.requests.length;
  for (const priceWon of [null, 0, -1, 8000.5, '8000', Number.MAX_SAFE_INTEGER + 1]) {
    await fs.writeFile(path.join(site.publicDir, 'restaurants.json'), JSON.stringify([{ ...catalog[3], priceWon }]));
    await assert.rejects(site.run(), /Invalid restaurant price/);
  }
  for (const closedDays of [null, '일', [7], [-1], [0.5], ['0']]) {
    await fs.writeFile(path.join(site.publicDir, 'restaurants.json'), JSON.stringify([{ ...catalog[3], closedDays }]));
    await assert.rejects(site.run(), /Invalid restaurant closed days/);
  }
  assert.equal(site.requests.length, requestCount);
  assert.deepEqual(await fs.readFile(path.join(site.publicDir, 'data/menus.json')), previous);
  assert.deepEqual(validateCatalog([{ ...catalog[3], closedDays: [6, 0, 6] }])[0].closedDays, [0, 6]);
});
