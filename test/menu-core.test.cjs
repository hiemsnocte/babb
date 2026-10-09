const test = require('node:test');
const assert = require('node:assert/strict');
const core = import('../public/menu-core.mjs');

function menu() {
  return { schemaVersion: 1, date: '2026-10-10', updatedAt: '2026-10-10T01:30:00Z', restaurants: ['bombom', 'beoksan', 'theeats'].map((id) => ({ id, name: id, imageUrl: `./data/images/${id}-abcdef.png` })) };
}

test('menu validation preserves catalog order for any number of restaurants', async () => {
  const { normalizeMenu } = await core;
  const value = menu();
  value.restaurants.push({ id: 'beerpan', name: '생앤맥주판', imageUrl: './data/images/beerpan-123.jpg', menuType: 'fixed',
    links: [{ label: '인스타그램', url: 'https://www.instagram.com/beerpan__d0n/' }] });
  const normalized = normalizeMenu(value);
  assert.deepEqual(normalized.restaurants.map((r) => r.id), ['bombom', 'beoksan', 'theeats', 'beerpan']);
  assert.equal(normalized.restaurants[3].menuType, 'fixed');
  assert.deepEqual(normalized.restaurants[3].links, value.restaurants[3].links);
  value.restaurants = value.restaurants.slice(3);
  assert.equal(normalizeMenu(value).restaurants.length, 1);
  assert.equal(normalizeMenu(menu()).restaurants.length, 3, 'previous cached menus stay usable');
});

test('price and weekly closures remain optional for old caches and validated for new snapshots', async () => {
  const { normalizeMenu } = await core;
  const value = menu();
  value.restaurants[0].priceWon = 9000;
  value.restaurants[0].closedDays = [6, 0, 6];
  const normalized = normalizeMenu(value).restaurants;
  assert.equal(normalized[0].priceWon, 9000);
  assert.deepEqual(normalized[0].closedDays, [0, 6]);
  assert.equal(normalized[1].priceWon, undefined);
  assert.deepEqual(normalized[1].closedDays, []);
  for (const priceWon of [null, 0, -1, 8000.5, '8000', Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = menu(); invalid.restaurants[0].priceWon = priceWon;
    assert.throws(() => normalizeMenu(invalid), /가격/);
  }
  for (const closedDays of [null, '일', [7], [-1], [0.5], ['0']]) {
    const invalid = menu(); invalid.restaurants[0].closedDays = closedDays;
    assert.throws(() => normalizeMenu(invalid), /휴무/);
  }
});

test('menu validation rejects empty/duplicate/unsafe image or link snapshots', async () => {
  const { normalizeMenu } = await core;
  for (const change of [
    (m) => { m.restaurants = []; },
    (m) => { m.restaurants[0] = m.restaurants[1]; },
    (m) => { m.restaurants[0].id = '../unsafe'; },
    (m) => { m.restaurants[0] = null; },
    (m) => { m.restaurants[0].imageUrl = 'https://example.com/tracking.png'; },
    (m) => { m.restaurants[0].imageUrl = './data/images/../../config.json'; },
    (m) => { m.restaurants[0].links = [{ label: '링크', url: 'javascript:alert(1)' }]; },
    (m) => { m.restaurants[0].links = [{ label: '링크', url: 'https://name:password@example.com/' }]; },
    (m) => { m.restaurants[0].links = {}; },
  ]) { const value = menu(); change(value); assert.throws(() => normalizeMenu(value)); }
});

test('retained menus preserve stale metadata without changing the original update caption', async () => {
  const { normalizeMenu, menuSummary, koreaDate } = await core;
  const value = menu();
  value.restaurants[0].stale = true;
  assert.equal(normalizeMenu(value).restaurants[0].stale, true);
  const midnight = new Date('2026-10-10T15:00:00Z');
  assert.equal(koreaDate(midnight), '2026-10-11');
  assert.match(menuSummary(normalizeMenu(value), midnight), /^갱신일: /);
  assert.doesNotMatch(menuSummary(normalizeMenu(value), midnight), /갱신 전|수집 메뉴/);
});

test('weather uses the current Korean hour from shared forecast and hides missing/null values', async () => {
  const { weatherAt } = await core;
  const data = { schemaVersion: 1, hourly: { time: ['2026-10-11T00:00'], temperature_2m: [16.6], weathercode: [0] } };
  assert.deepEqual(weatherAt(data, new Date('2026-10-10T15:20:00Z')), { temperature: 17, icon: '☀️', hour: '00' });
  assert.equal(weatherAt(data, new Date('2026-10-11T15:20:00Z')), null);
  data.hourly.temperature_2m[0] = null;
  assert.equal(weatherAt(data, new Date('2026-10-10T15:20:00Z')), null);
});
