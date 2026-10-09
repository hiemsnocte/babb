// Local browser integration check. All remote requests are blocked or replaced
// with Firebase SDK fixtures; this script never writes to the live database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const puppeteer = require('puppeteer');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
const previewRoot = path.join(root, '.preview');
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date());
const part = (type) => parts.find((entry) => entry.type === type).value;
const day = `${part('year')}-${part('month')}-${part('day')}`;
const names = ['벽산더이룸', '더이츠푸드', '봄봄', '생앤맥주판'];
const ids = ['beoksan', 'theeats', 'bombom', 'beerpan'];
let catalog;
const expectedPrices = { beoksan: '(8,000원)', theeats: '(7,500원)', bombom: '(9,000원)', beerpan: '(8,000원)' };
const expectedLinkLabels = { beoksan: ['카카오맵'], theeats: ['카카오맵'], bombom: ['네이버', '인스타그램'], beerpan: ['인스타그램', '당근'] };
const emojis = ['😍', '😋', '🤔', '😑', '😒', '😡', '🤬'];
const state = { menus: 'ok', menuDate: day, restaurantIds: [...ids], replacementImagesFail: false, oldImageDelayMs: 0, responseOrder: [] };

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const value of body) {
    crc ^= value;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function fixtureImage(width = 320, height = 240) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      const stripe = y > 55 && y < 210 && y % 30 < 8 && x > 36 && x < 280;
      raw[offset] = stripe ? 90 : 239;
      raw[offset + 1] = stripe ? 113 : 242;
      raw[offset + 2] = stripe ? 91 : 228;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Exercise both kinds of real menu image: tall wall menus and wide weekly boards.
const imageBodies = {
  beoksan: fixtureImage(240, 360),
  theeats: fixtureImage(),
  bombom: fixtureImage(),
  beerpan: fixtureImage(640, 390),
};
const firebaseAppFixture = `
export const getApps = () => [];
export const initializeApp = (config, name) => ({ name });
`;
const firestoreFixture = `
const state = () => window.__socialTest;
export const getFirestore = () => ({});
export const doc = (...parts) => ({ path: parts.filter((part) => typeof part === 'string').join('/') });
export const collection = (parent, ...parts) => ({ path: [parent.path || '', ...parts].join('/') });
export const orderBy = (field, direction) => ({ field, direction });
export const limit = (count) => ({ count });
export const query = (ref, ...constraints) => ({ ref, constraints });
export const serverTimestamp = () => ({ seconds: Math.floor(Date.now() / 1000) });
const snapshot = () => ({ exists: () => true, data: () => structuredClone(state().restaurant) });
const commentsSnapshot = (value) => {
  const max = value.constraints.find((entry) => 'count' in entry)?.count;
  return { docs: state().comments.slice(0, max).map((item, index) => ({ id: item.id || String(index), data: () => item })) };
};
export function onSnapshot(value, next, fail) {
  const entry = { value, next, fail, active: true };
  state().listeners.push(entry);
  state().activeListeners += 1;
  state().maxListeners = Math.max(state().maxListeners, state().activeListeners);
  if (!value.constraints) { state().restaurantListeners += 1; return () => {}; }
  state().queryReads += 1;
  state().limits.push(value.constraints.find((item) => 'count' in item)?.count);
  queueMicrotask(() => {
    if (!entry.active) return;
    if (state().failRead) fail(new Error('Firebase: fixture read denied'));
    else next(commentsSnapshot(value));
  });
  state().emitComment = (id, text, date) => {
    state().comments.unshift({ id: 'remote-' + Date.now(), text, date });
    for (const listener of state().listeners) {
      if (listener.active && listener.value.ref.path.includes('/' + id + '/')) listener.next(commentsSnapshot(listener.value));
    }
  };
  return () => {
    if (!entry.active) return;
    entry.active = false;
    state().activeListeners -= 1;
    state().unsubscribes += 1;
  };
}
export async function getDoc() {
  state().docReads += 1;
  state().imagesReadyWhenRead.push([...document.querySelectorAll('.img-wrap > img')].some(image => image.complete && image.naturalWidth > 0));
  if (state().failRead) throw new Error('Firebase: fixture read denied');
  return snapshot();
}
export async function getDocs(value) {
  state().queryReads += 1;
  const max = value.constraints.find((entry) => 'count' in entry)?.count;
  state().limits.push(max);
  if (state().failRead) throw new Error('Firebase: fixture read denied');
  return { docs: state().comments.slice(0, max).map((item, index) => ({ id: String(index), data: () => item })) };
}
export async function runTransaction(db, callback) {
  if (state().failRead) throw new Error('Firebase: fixture write denied');
  state().transactionRuns += 1;
  return callback({
    async get() { state().transactionReads += 1; return snapshot(); },
    update(ref, data) { state().transactionWrites += 1; state().restaurant = { ...state().restaurant, ...data }; },
    set(ref, data) { state().transactionWrites += 1; state().restaurant = { ...data }; },
  });
}
export async function addDoc(ref, data) {
  if (state().failRead) throw new Error('Firebase: fixture write denied');
  state().messageWrites += 1;
  state().comments.unshift({ ...data, id: 'new-fixture-message' });
  for (const listener of state().listeners) {
    if (listener.active && listener.value.ref.path === ref.path) listener.next(commentsSnapshot(listener.value));
  }
  return { id: 'new-fixture-message' };
}
`;

function menuFixture() {
  return {
    schemaVersion: 1, date: state.menuDate, updatedAt: new Date().toISOString(),
    restaurants: state.restaurantIds.map((id) => ({
      id, name: names[ids.indexOf(id)],
      imageUrl: `./data/images/${id}_${id === 'beerpan' ? 'fixed' : state.menus === 'replacement' ? 'b' : 'a'}.png`,
      menuType: id === 'beerpan' ? 'fixed' : 'daily', stale: false,
      priceWon: catalog.find((restaurant) => restaurant.id === id).priceWon,
      closedDays: catalog.find((restaurant) => restaurant.id === id).closedDays,
      links: catalog.find((restaurant) => restaurant.id === id).links,
    })),
  };
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const requestedPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const pathname = requestedPath.startsWith('/babb/') ? requestedPath.slice('/babb'.length) : requestedPath;
      response.setHeader('Cache-Control', 'no-store');
      if (pathname === '/data/menus.json') {
        response.setHeader('Content-Type', 'application/json');
        response.statusCode = state.menus === 'fail' ? 503 : 200;
        response.end(JSON.stringify(state.menus === 'fail' ? { error: 'fixture offline' } : menuFixture()));
        return;
      }
      if (pathname === '/data/weather.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ schemaVersion: 1, hourly: { time: [`${day}T${part('hour')}:00`], temperature_2m: [21], weathercode: [0] } }));
        return;
      }
      if (pathname.startsWith('/data/images/')) {
        if (state.oldImageDelayMs && pathname.endsWith('_a.png')) await new Promise((resolve) => setTimeout(resolve, state.oldImageDelayMs));
        state.responseOrder.push(pathname);
        if (state.replacementImagesFail && pathname.endsWith('_b.png')) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Type', 'image/png');
        const id = path.basename(pathname).split('_')[0];
        response.end(imageBodies[id]);
        return;
      }
      const filename = path.resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(`${publicRoot}${path.sep}`)) { response.writeHead(403); response.end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      response.setHeader('Content-Type', `${types[path.extname(filename)] || 'application/octet-stream'}; charset=utf-8`);
      response.end(await fs.readFile(filename));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function main() {
  let browser;
  let server;
  const unexpected = [];
  const errors = [];
  try {
    catalog = JSON.parse(await fs.readFile(path.join(publicRoot, 'restaurants.json'), 'utf8'));
    server = await startServer();
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-background-networking'] });
    await fs.mkdir(previewRoot, { recursive: true });

    async function newPage({ mobile = false, sdkFailure = false, dbFailure = false, initialVotes = 4, reducedMotion = false, basePath = '/' } = {}) {
      // Isolate user storage so a preceding successful message's cooldown cannot
      // mask a later SDK/database failure scenario.
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 900 });
      if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setRequestInterception(true);
      const sdkRequests = [];
      const localRequests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin === origin) { localRequests.push(url.pathname); request.continue(); return; }
        if (url.protocol === 'data:') { request.continue(); return; }
        const sdk = url.origin === 'https://www.gstatic.com' && url.pathname.match(/^\/firebasejs\/11\.10\.0\/firebase-(app|firestore)\.js$/);
        if (sdk) {
          sdkRequests.push(url.href);
          request.respond({ status: sdkFailure ? 503 : 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: sdkFailure ? 'fixture unavailable' : sdk[1] === 'app' ? firebaseAppFixture : firestoreFixture });
          return;
        }
        if (url.origin === 'https://fonts.googleapis.com') {
          request.respond({ status: 200, contentType: 'text/css', body: '' });
          return;
        }
        unexpected.push(url.href);
        request.abort('blockedbyclient');
      });
      await page.evaluateOnNewDocument((date, failRead, voteCount) => {
        window.__socialTest = {
          docReads: 0, queryReads: 0, limits: [], transactionRuns: 0, transactionReads: 0, transactionWrites: 0, messageWrites: 0, failRead,
          listeners: [], activeListeners: 0, maxListeners: 0, restaurantListeners: 0, unsubscribes: 0, imagesReadyWhenRead: [],
          restaurant: { date, emojiCounts: { '😍': voteCount, '😋': 2, '🤔': 1 } },
          comments: [{ id: 'today', text: '오늘도 맛있게 드세요', date }, { id: 'old', text: '지난 메뉴', date: '2000-01-01' }],
        };
      }, day, dbFailure, initialVotes);
      await page.goto(origin + basePath, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((count) => document.querySelectorAll('.img-wrap > img').length === count && [...document.querySelectorAll('.img-wrap > img')].every((img) => img.complete && img.naturalWidth > 0), {}, ids.length);
      assert.deepEqual(await page.$$eval('.menu-title-name', (elements) => elements.map((element) => element.textContent)), names);
      return { page, sdkRequests, localRequests };
    }

    async function assertMenuWorks(page) {
      assert.equal(await page.$$eval('.img-wrap > img', (elements) => elements.filter((image) => image.complete && image.naturalWidth > 0).length), state.restaurantIds.length);
      if (await page.$eval('.menu-actions', (element) => element.hidden)) await page.click('.menu-title-name');
      await page.waitForSelector('.menu-actions:not([hidden])');
      await page.click('.menu-viewonly-btn');
      await page.waitForSelector('#image-modal.on');
      assert.equal(await page.$$eval('#image-modal img', (elements) => elements.length), 1);
      await page.click('#image-modal .image-modal-close');
      await page.click('#compare-btn');
      await page.waitForSelector('#compare-modal.on');
      assert.equal(await page.$$eval('#compare-modal .compare-item img', (elements) => elements.length), state.restaurantIds.length);
      await page.click('#compare-modal .image-modal-close');
      if (!(await page.$eval('.menu-actions', (element) => element.hidden))) await page.click('.menu-title-name');
      await page.waitForFunction(() => [...document.querySelectorAll('.menu-actions')].every((element) => element.hidden));
    }

    async function assertFramedLayout(page, mobile = false) {
      assert.equal(await page.$eval('h1', (element) => element.textContent), '오늘의 메뉴🍴');
      assert.equal(await page.$eval('#weather-temp', (element) => element.textContent), '21°C');
      assert.equal(await page.$eval('#weather-icon', (element) => element.textContent), '☀️');
      assert.ok(await page.$eval('#updated-line', (element) => element.textContent.startsWith('갱신일:')));
      assert.ok(await page.$$eval('.menu-actions', (elements, count) => elements.length === count && elements.every((element) => element.hidden), ids.length), 'original actions stay in their card and open on demand');
      assert.equal(await page.$$eval('.grave-icon, .title-right, .menu-title-mid, .menu-title-bottom', (elements) => elements.length), 0, 'removed game graves must not leave badges or empty title rows');
      assert.equal(await page.$$eval('.participate-button, .social-panel, #notice, #retry-btn', (elements) => elements.length), 0);
      assert.doesNotMatch(await page.$eval('body', (element) => element.innerText), /갱신 전|식당 사정|전광판 · 이모지 투표 열기/);
      const layout = await page.evaluate(() => {
        const card = document.querySelector('.menu-card').getBoundingClientRect();
        const title = document.querySelector('.menu-heading').getBoundingClientRect();
        const heading = document.querySelector('h1').getBoundingClientRect();
        const compare = document.querySelector('#compare-btn').getBoundingClientRect();
        return { bg: getComputedStyle(document.body).backgroundColor, cardWidth: card.width, titleCentered: Math.abs((title.left + title.right) / 2 - (card.left + card.right) / 2) < 1, headingTop: heading.top, compareTop: compare.top, overflow: document.documentElement.scrollWidth > window.innerWidth };
      });
      assert.equal(layout.bg, 'rgb(244, 242, 238)');
      assert.equal(layout.titleCentered, true, 'restaurant headings stay centered in the black header');
      assert.equal(layout.overflow, false, 'the page must not overflow horizontally');
      assert.ok(layout.cardWidth <= 530 && layout.cardWidth >= (mobile ? 350 : 500));
      if (mobile) assert.ok(layout.headingTop < layout.compareTop, 'mobile header retains the original two rows');
      const frames = await page.$$eval('.menu-card', (cards) => cards.map((card) => {
        const title = card.querySelector('.menu-title');
        const name = card.querySelector('.menu-title-name');
        const wrap = card.querySelector('.img-wrap');
        const image = wrap.querySelector('img');
        const cardRect = card.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const style = getComputedStyle(card);
        const imageStyle = getComputedStyle(image);
        const naturalRatio = image.naturalWidth / image.naturalHeight;
        return {
          id: card.dataset.restaurant,
          cardColor: style.backgroundColor,
          borderColor: style.borderLeftColor,
          border: parseFloat(style.borderLeftWidth),
          titleColor: getComputedStyle(title).backgroundColor,
          imageBackground: getComputedStyle(wrap).backgroundColor,
          gap: wrapRect.top - titleRect.bottom,
          imageInset: wrapRect.left - cardRect.left,
          titleWidth: titleRect.width,
          imageWidth: wrapRect.width,
          ratio: wrapRect.width / wrapRect.height,
          naturalRatio,
          fit: imageStyle.objectFit,
          ribbonBefore: getComputedStyle(name, '::before').content,
          ribbonAfter: getComputedStyle(name, '::after').content,
        };
      }));
      const isBlack = (color) => /^rgb\(/.test(color) && color.match(/\d+/g).slice(0, 3).every((channel) => Number(channel) < 32);
      for (const frame of frames) {
        assert.ok(isBlack(frame.cardColor), `${frame.id}: one black frame must enclose header, photo and links`);
        assert.ok(isBlack(frame.borderColor) && frame.border > 0, `${frame.id}: photo must have a visible black border`);
        assert.ok(isBlack(frame.titleColor), `${frame.id}: restaurant title belongs to the black frame`);
        if (frame.id === 'beoksan') assert.equal(frame.imageBackground, 'rgb(255, 255, 255)', 'portrait menu side room is white while its frame stays black');
        else assert.ok(isBlack(frame.imageBackground), `${frame.id}: other menu image backgrounds stay unchanged`);
        assert.ok(Math.abs(frame.gap) < 1, `${frame.id}: no white gap between title and photo`);
        assert.ok(Math.abs(frame.imageInset - frame.border) < 1, `${frame.id}: photo sits directly inside the frame border`);
        assert.ok(Math.abs(frame.titleWidth - frame.imageWidth) < 1, `${frame.id}: title and photo have the same width`);
        assert.equal(frame.fit, frame.naturalRatio < 4 / 3 ? 'contain' : 'fill', `${frame.id}: tall photos retain their proportions and wide photos fill the shared frame without cropping`);
        assert.ok(Math.abs(frame.ratio - 4 / 3) < 0.01, `${frame.id}: every photo uses the same 4:3 frame regardless of its natural size`);
        assert.ok(['none', 'normal'].includes(frame.ribbonBefore) && ['none', 'normal'].includes(frame.ribbonAfter), `${frame.id}: detached ribbon tails are removed`);
      }
    }

    async function assertColumns(page, expected, { mobile = false } = {}) {
      await page.waitForFunction((count) => document.documentElement.dataset.columns === String(count), {}, expected);
      const layout = await page.evaluate(() => {
        const rect = (element) => {
          const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
          return { left, right, top, bottom, width, height };
        };
        const switcher = document.querySelector('.view-switcher');
        const buttons = [...switcher.querySelectorAll('[data-columns]')];
        const menus = document.getElementById('menus');
        return {
          cards: [...menus.children].map(rect),
          photos: [...menus.querySelectorAll('.img-wrap')].map(rect),
          columns: getComputedStyle(menus).gridTemplateColumns.split(' ').length,
          menuWidth: rect(menus).width,
          viewport: window.innerWidth,
          visible: !!switcher.getClientRects().length,
          compare: rect(document.getElementById('compare-btn')),
          date: rect(document.getElementById('weather-time')),
          switcher: rect(switcher),
          belowDateInDom: switcher.previousElementSibling?.id === 'weather-time' && switcher.parentElement.id === 'weather',
          buttons: buttons.map((button) => ({ ...rect(button), label: button.getAttribute('aria-label'), selected: button.getAttribute('aria-pressed'), columns: button.dataset.columns })),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      assert.equal(layout.columns, expected, 'selected column count changes the actual grid');
      assert.equal(layout.overflow, false, 'column changes must not overflow the viewport');
      assert.equal(layout.visible, !mobile, 'mobile keeps a single column without desktop view controls');
      assert.ok(Math.max(...layout.cards.map((card) => card.height)) - Math.min(...layout.cards.map((card) => card.height)) <= 1, 'all four restaurant cards have equal heights, including cards in later rows');
      assert.ok(Math.max(...layout.photos.map((photo) => photo.height)) - Math.min(...layout.photos.map((photo) => photo.height)) <= 1, 'portrait, regular and landscape menu photos share the same display height');
      for (let index = 0; index < layout.cards.length; index += 1) {
        const card = layout.cards[index];
        assert.ok(Math.abs(card.left - layout.cards[index % expected].left) < 1, 'cards line up in their selected grid column');
        if (index < expected) assert.ok(Math.abs(card.top - layout.cards[0].top) < 1, 'the selected number of cards share the first row');
        else assert.ok(card.top >= layout.cards[index - expected].bottom, 'remaining cards form later rows without overlap');
      }
      if (!mobile) {
        assert.equal(layout.belowDateInDom, true, 'view options follow the date inside the weather block');
        assert.ok(layout.switcher.top >= layout.date.bottom, 'view options sit below the date');
        assert.equal(layout.buttons.filter((button) => button.selected === 'true').length, 1);
        assert.equal(layout.buttons.find((button) => button.selected === 'true').columns, String(expected));
        assert.deepEqual(layout.buttons.map((button) => button.label), ['1열 보기', '2열 보기', '3열 보기']);
        assert.ok(layout.buttons.every((button) => button.width >= 24 && button.height >= 24), 'view options remain usable small buttons');
        const maxWidth = { 1: 520, 2: 1060, 3: 1600 }[expected];
        assert.ok(layout.menuWidth <= maxWidth + 1, 'single-column content stays compact and multi-column content uses more desktop width');
      }
    }

    async function assertTitleLinks(page) {
      const layouts = await page.$$eval('.menu-card', (cards) => cards.map((card) => {
        const cardRect = card.getBoundingClientRect();
        const heading = card.querySelector('.menu-heading').getBoundingClientRect();
        const name = card.querySelector('.menu-title-name').getBoundingClientRect();
        const price = card.querySelector('.menu-price').getBoundingClientRect();
        const links = card.querySelector('.restaurant-links');
        const linksRect = links.getBoundingClientRect();
        const title = card.querySelector('.menu-title').getBoundingClientRect();
        const sameRow = Math.min(linksRect.bottom, name.bottom) > Math.max(linksRect.top, name.top);
        return {
          id: card.dataset.restaurant,
          inTitle: !!links.closest('.menu-title-top'),
          headingCentered: Math.abs((heading.left + heading.right) / 2 - (cardRect.left + cardRect.right) / 2) < 1,
          textCentered: Math.abs((name.left + price.right) / 2 - (cardRect.left + cardRect.right) / 2) < 1,
          priceAdjacent: price.left >= name.right && price.left - name.right < 16 && Math.min(price.bottom, name.bottom) > Math.max(price.top, name.top),
          price: card.querySelector('.menu-price').textContent,
          linksClear: !sameRow || linksRect.left >= price.right + 4,
          linksRightAligned: title.right - linksRect.right <= 20,
          fitsHeader: linksRect.right <= title.right && linksRect.top >= title.top && linksRect.bottom <= title.bottom,
          hasFooter: [...card.children].some((child) => child.classList.contains('restaurant-links')),
          links: [...links.querySelectorAll('a')].map((anchor) => ({ label: anchor.textContent, url: anchor.href, target: anchor.target, rel: anchor.rel })),
        };
      }));
      for (const layout of layouts) {
        assert.equal(layout.inTitle, true, `${layout.id}: source links belong inside the title`);
        assert.equal(layout.headingCentered, true, `${layout.id}: full heading stays centered independent of source links`);
        assert.equal(layout.textCentered, true, `${layout.id}: the actual name and price stay centered`);
        assert.equal(layout.priceAdjacent, true, `${layout.id}: price follows the name on the same row`);
        assert.equal(layout.price, expectedPrices[layout.id]);
        assert.equal(layout.linksClear, true, `${layout.id}: source links never overlap the centered name and price`);
        assert.equal(layout.linksRightAligned, true, `${layout.id}: source links remain aligned to the header right`);
        assert.equal(layout.fitsHeader, true, `${layout.id}: source links stay inside the black title area`);
        assert.equal(layout.hasFooter, false, `${layout.id}: links must not add a separate photo footer`);
        assert.deepEqual(layout.links.map((link) => link.label), expectedLinkLabels[layout.id]);
        assert.ok(layout.links.every((link) => link.target === '_blank' && /noopener/.test(link.rel) && /noreferrer/.test(link.rel)));
      }
      const link = (id, label) => layouts.find((layout) => layout.id === id).links.find((item) => item.label === label).url;
      assert.equal(link('beoksan', '카카오맵'), 'https://place.map.kakao.com/2142931780');
      assert.equal(link('theeats', '카카오맵'), 'https://place.map.kakao.com/2111901229');
      assert.equal(link('bombom', '인스타그램'), 'https://www.instagram.com/bombom_guro/');
      assert.match(new URL(link('bombom', '네이버')).hostname, /(^|\.)naver\.com$/);
      assert.equal(link('beerpan', '인스타그램'), 'https://www.instagram.com/beerpan__d0n/');
      assert.equal(decodeURI(link('beerpan', '당근')), 'https://www.daangn.com/kr/local-profile/생앤맥주펍-fruq2j6aupbf/');
    }

    async function assertHolidayBadge(page) {
      const badges = await page.$$eval('.menu-closed-badge', (elements) => elements.filter((element) => !element.hidden).map((badge) => {
        const wrap = badge.closest('.img-wrap').getBoundingClientRect();
        const rect = badge.getBoundingClientRect();
        const style = getComputedStyle(badge);
        return { id: badge.closest('.menu-card').dataset.restaurant, text: badge.textContent, right: wrap.right - rect.right, top: rect.top - wrap.top, background: style.backgroundColor, color: style.color, borderColor: style.borderTopColor, borderWidth: parseFloat(style.borderTopWidth) };
      }));
      assert.equal(badges.length, 1, 'only the restaurant with a known holiday gets a badge');
      assert.equal(badges[0].id, 'bombom');
      assert.equal(badges[0].text, '휴무: 일요일');
      assert.equal(badges[0].background, 'rgb(139, 30, 36)', 'holiday badge uses a dark red background');
      assert.equal(badges[0].color, 'rgb(255, 255, 255)', 'holiday badge text remains readable white');
      assert.equal(badges[0].borderColor, 'rgb(17, 17, 17)', 'holiday badge has the requested black outline');
      assert.ok(badges[0].borderWidth >= 1, 'holiday badge outline must be visible');
      assert.ok(badges[0].top >= 0 && badges[0].top <= 16 && badges[0].right >= 0 && badges[0].right <= 16, 'holiday badge stays at the top-right of the photo');
      await page.click('[data-restaurant="bombom"] .menu-closed-badge');
      assert.equal(await page.$eval('[data-restaurant="bombom"] .menu-actions', (element) => element.hidden), true, 'the informational badge does not open voting controls');
    }

    async function assertCompactActions(page) {
      await page.click('[data-restaurant="beoksan"] .menu-title-name');
      await page.waitForSelector('[data-restaurant="beoksan"] .menu-actions:not([hidden])');
      const controls = await page.$eval('[data-restaurant="beoksan"]', (card) => {
        const area = card.querySelector('.img-wrap').getBoundingClientRect();
        const nodes = [...card.querySelectorAll('.menu-actions button, .menu-actions input')];
        const rects = nodes.map((node) => {
          const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
          return { left, right, top, bottom, width, height };
        });
        return {
          count: rects.length,
          inside: rects.every((rect) => rect.left >= area.left && rect.right <= area.right && rect.top >= area.top && rect.bottom <= area.bottom && rect.width >= 20 && rect.height >= 20),
          overlap: rects.some((a, index) => rects.slice(index + 1).some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)),
        };
      });
      assert.equal(controls.count, 10, 'menu-only, seven emoji, message input and send control remain available');
      assert.equal(controls.inside, true, 'compact desktop cards keep all controls inside the photo');
      assert.equal(controls.overlap, false, 'compact desktop controls must not cover each other');
      await page.mouse.click(8, 8);
    }

    async function waitForSocial(page) {
      await page.waitForFunction((count) => window.__socialTest.docReads === count && window.__socialTest.activeListeners === count && document.querySelector('.danmaku')?.textContent.includes('오늘도 맛있게 드세요'), {}, ids.length);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-restaurant="beoksan"] .emoji-train')].some((element) => element.querySelectorAll('.emoji-train-car').length === 4 && element.textContent === '😍'.repeat(4)));
      assert.ok(await page.$$eval('[data-marquee-kind="vote"]', (trains) => trains.every((train) => !/\d|표/.test(train.textContent))), 'votes are repeated emoji cars, never visible numeric labels');
      const usage = await page.evaluate(() => {
        const { docReads, queryReads, limits, activeListeners, restaurantListeners, imagesReadyWhenRead } = window.__socialTest;
        return { docReads, queryReads, limits, activeListeners, restaurantListeners, imagesReadyWhenRead };
      });
      assert.equal(usage.docReads, ids.length);
      assert.equal(usage.queryReads, ids.length);
      assert.deepEqual(usage.limits, ids.map(() => 10));
      assert.equal(usage.restaurantListeners, 0, 'votes must not create realtime document listeners');
      assert.deepEqual(usage.imagesReadyWhenRead, ids.map(() => true), 'menu starts painting before optional Firebase work');
      assert.ok(await page.$$eval('.menu-actions', (elements) => elements.every((element) => element.hidden)), 'messages must be visible before opening controls');
      assert.ok(await page.$$eval('.danmaku', (elements) => elements.every((element) => !element.textContent.includes('지난 메뉴'))));
    }

    const desktop = await newPage();
    await waitForSocial(desktop.page);
    await assertFramedLayout(desktop.page);
    await assertColumns(desktop.page, 2);
    await assertTitleLinks(desktop.page);
    await assertHolidayBadge(desktop.page);
    const sourceLinks = await desktop.page.$$('.restaurant-links a');
    for (let index = 0; index < sourceLinks.length; index += 1) {
      await desktop.page.evaluate((item) => {
        const anchor = document.querySelectorAll('.restaurant-links a')[item];
        anchor.addEventListener('click', (event) => event.preventDefault(), { once: true });
        anchor.click();
      }, index);
      assert.ok(await desktop.page.$$eval('.menu-actions', (elements) => elements.every((element) => element.hidden)), 'source links must not open card controls');
    }
    await assertMenuWorks(desktop.page);

    await desktop.page.evaluate(() => { window.__columnCards = [...document.querySelectorAll('.menu-card')]; });
    for (const count of [1, 2, 3, 2]) {
      await desktop.page.locator(`.view-switcher [data-columns="${count}"]`).click();
      await assertColumns(desktop.page, count);
      await assertTitleLinks(desktop.page);
      await assertHolidayBadge(desktop.page);
    }
    const unchanged = await desktop.page.evaluate(() => ({
      sameCards: window.__columnCards.every((card, index) => card === document.querySelectorAll('.menu-card')[index]),
      reads: window.__socialTest.docReads,
      queries: window.__socialTest.queryReads,
      listeners: window.__socialTest.activeListeners,
      maxListeners: window.__socialTest.maxListeners,
    }));
    assert.deepEqual(unchanged, { sameCards: true, reads: ids.length, queries: ids.length, listeners: ids.length, maxListeners: ids.length }, 'view changes only rearrange existing cards without Firebase reads or subscriptions');
    await desktop.page.screenshot({ path: path.join(previewRoot, 'restored-desktop.png'), fullPage: true });
    await (await desktop.page.$('[data-restaurant="beerpan"]')).screenshot({ path: path.join(previewRoot, 'framed-beerpan.png') });
    console.log('PASS centered names and prices, source links, holiday badge, date-row view options, desktop 1/2/3 columns without new reads and four-image comparison');

    const savedView = await newPage();
    await waitForSocial(savedView.page);
    await savedView.page.locator('.view-switcher [data-columns="3"]').click();
    assert.equal(await savedView.page.evaluate(() => localStorage.getItem('babb:menu-columns:v1')), '3');
    await savedView.page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSocial(savedView.page);
    await assertColumns(savedView.page, 3);
    await savedView.page.setViewport({ width: 390, height: 844 });
    await assertColumns(savedView.page, 1, { mobile: true });
    await assertTitleLinks(savedView.page);
    assert.equal(await savedView.page.evaluate(() => localStorage.getItem('babb:menu-columns:v1')), '3', 'mobile layout must not overwrite the desktop preference');
    await savedView.page.setViewport({ width: 940, height: 900 });
    await assertColumns(savedView.page, 3);
    await assertTitleLinks(savedView.page);
    await assertCompactActions(savedView.page);
    await savedView.page.screenshot({ path: path.join(previewRoot, 'columns-compact-desktop.png'), fullPage: true });
    await savedView.page.setViewport({ width: 1720, height: 1000 });
    await assertColumns(savedView.page, 3);
    await assertTitleLinks(savedView.page);
    await savedView.page.screenshot({ path: path.join(previewRoot, 'columns-wide-desktop.png'), fullPage: true });
    assert.equal(await savedView.page.evaluate(() => window.__socialTest.docReads), ids.length, 'viewport changes must not reload votes');
    assert.equal(await savedView.page.evaluate(() => window.__socialTest.activeListeners), ids.length, 'viewport changes keep exactly one subscription per card');
    await savedView.page.close();
    console.log('PASS remembered desktop view, automatic mobile single column, desktop restoration and compact-card controls');

    const firstCard = '[data-restaurant="beoksan"]';
    await desktop.page.$eval(firstCard, (card) => card.scrollIntoView());
    await desktop.page.evaluate((date) => window.__socialTest.emitComment('beoksan', '새 전광판 <b>안전한 문자</b>', date), day);
    await desktop.page.waitForFunction(() => document.querySelector('[data-restaurant="beoksan"] .danmaku').textContent.includes('새 전광판 <b>안전한 문자</b>'));
    assert.equal(await desktop.page.$$eval('.danmaku b', (elements) => elements.length), 0, 'remote messages are rendered as text');
    assert.equal(await desktop.page.evaluate(() => window.__socialTest.docReads), ids.length, 'new messages must not reread vote counts');
    await desktop.page.click(`${firstCard} .menu-title-name`);
    await desktop.page.waitForSelector(`${firstCard} .menu-actions:not([hidden])`);
    assert.deepEqual(await desktop.page.$$eval(`${firstCard} .emoji-row .emoji-btn`, (buttons) => buttons.map((button) => button.textContent.match(/😍|😋|🤔|😑|😒|😡|🤬/u)?.[0])), emojis);
    assert.equal(await desktop.page.$eval(`${firstCard} .comment-row input`, (input) => input.placeholder), '+한마디');
    await desktop.page.click(`${firstCard} .emoji-btn`);
    await desktop.page.waitForFunction(() => window.__socialTest.transactionWrites === 1);
    let usage = await desktop.page.evaluate(() => ({ ...window.__socialTest, listeners: undefined, emitComment: undefined }));
    assert.equal(usage.transactionReads, 1);
    assert.equal(usage.transactionWrites, 1);
    assert.equal(usage.restaurant.emojiCounts['😍'], 5);
    await desktop.page.waitForFunction(() => [...document.querySelectorAll('[data-restaurant="beoksan"] .emoji-train')].some((element) => element.querySelectorAll('.emoji-train-car').length === 5 && element.textContent === '😍'.repeat(5)));
    const train = await desktop.page.$eval('[data-restaurant="beoksan"] .emoji-train[aria-label="😍 투표 5표"]', (element) => ({ label: element.getAttribute('aria-label'), carsHidden: [...element.querySelectorAll('.emoji-train-car')].every((car) => car.getAttribute('aria-hidden') === 'true') }));
    assert.equal(train.label, '😍 투표 5표', 'screen readers receive a single vote count instead of repeated emoji names');
    assert.equal(train.carsHidden, true);
    await desktop.page.waitForFunction(() => [...document.querySelectorAll('[data-restaurant="beoksan"] .emoji-btn')].every((button) => button.disabled));
    await desktop.page.mouse.click(10, 10);
    await desktop.page.waitForSelector(`${firstCard} .menu-actions[hidden]`);
    await (await desktop.page.$(firstCard)).screenshot({ path: path.join(previewRoot, 'emoji-train.png') });
    await desktop.page.click(`${firstCard} .menu-title-name`);
    await desktop.page.type(`${firstCard} .comment-row input`, '맛있어요 <b>안전한 문자</b>');
    await desktop.page.click(`${firstCard} .comment-row button`);
    await desktop.page.waitForFunction(() => window.__socialTest.messageWrites === 1 && document.querySelector('[data-restaurant="beoksan"] .danmaku').textContent.includes('맛있어요 <b>안전한 문자</b>'));
    usage = await desktop.page.evaluate(() => ({ ...window.__socialTest, listeners: undefined, emitComment: undefined }));
    assert.equal(usage.messageWrites, 1);
    assert.equal(usage.queryReads, ids.length);
    assert.equal(usage.docReads, ids.length);
    assert.equal(usage.activeListeners, ids.length);
    assert.equal(await desktop.page.$$eval('.danmaku b', (elements) => elements.length), 0);
    assert.equal(await desktop.page.$eval(`${firstCard} .comment-row button`, (button) => button.disabled), true);
    await desktop.page.screenshot({ path: path.join(previewRoot, 'restored-desktop-actions.png'), fullPage: true });
    console.log('PASS embedded original emoji/message controls, safe realtime messages, one vote write and no vote fanout reads');

    state.menuDate = '2000-01-01';
    state.menus = 'replacement';
    await desktop.page.evaluate(() => {
      const originalNow = Date.now;
      Date.now = () => originalNow() + 6 * 60 * 1000;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await desktop.page.waitForFunction(() => [...document.querySelectorAll('.img-wrap > img')].every((image) => image.complete && (image.currentSrc.endsWith('_b.png') || image.currentSrc.endsWith('beerpan_fixed.png'))));
    assert.doesNotMatch(await desktop.page.$eval('body', (element) => element.innerText), /갱신 전|식당 사정/);
    usage = await desktop.page.evaluate(() => ({ activeListeners: window.__socialTest.activeListeners, maxListeners: window.__socialTest.maxListeners }));
    assert.equal(usage.activeListeners, ids.length);
    assert.equal(usage.maxListeners, ids.length, 'refreshing menu data must not accumulate realtime listeners');
    state.menuDate = day;
    state.menus = 'ok';
    await desktop.page.evaluate(() => {
      const previousNow = Date.now;
      Date.now = () => previousNow() + 6 * 60 * 1000;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await desktop.page.waitForFunction(() => [...document.querySelectorAll('.img-wrap > img')].every((image) => image.complete && (image.currentSrc.endsWith('_a.png') || image.currentSrc.endsWith('beerpan_fixed.png'))));
    console.log('PASS menu refresh preserves listener count and original copy for older menu dates');

    state.restaurantIds = ['beerpan', 'theeats', 'beoksan'];
    await desktop.page.evaluate(() => {
      const previousNow = Date.now;
      Date.now = () => previousNow() + 6 * 60 * 1000;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await desktop.page.waitForFunction(() => document.querySelectorAll('.menu-card').length === 3 && window.__socialTest.activeListeners === 3);
    assert.deepEqual(await desktop.page.$$eval('.menu-card', (cards) => cards.map((card) => card.dataset.restaurant)), state.restaurantIds, 'catalog order must determine card order');
    assert.equal(await desktop.page.evaluate(() => window.__socialTest.unsubscribes), 1, 'removed restaurants must release their listener');
    state.restaurantIds = [...ids];
    await desktop.page.evaluate(() => {
      const previousNow = Date.now;
      Date.now = () => previousNow() + 6 * 60 * 1000;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await desktop.page.waitForFunction(() => document.querySelectorAll('.menu-card').length === 4 && window.__socialTest.activeListeners === 4);
    assert.deepEqual(await desktop.page.$$eval('.menu-card', (cards) => cards.map((card) => card.dataset.restaurant)), ids);
    assert.equal(await desktop.page.evaluate(() => window.__socialTest.maxListeners), ids.length, 'remove/re-add must never keep old subscriptions alive');
    assert.equal(await desktop.page.evaluate(() => window.__socialTest.docReads), ids.length + 1, 'reorder should not reread unchanged restaurants');
    console.log('PASS restaurant removal, reordering and re-addition keep one listener per active card');

    state.menus = 'fail';
    await desktop.page.reload({ waitUntil: 'domcontentloaded' });
    await desktop.page.waitForFunction((count) => document.querySelectorAll('.img-wrap > img').length === count && [...document.querySelectorAll('.img-wrap > img')].every((image) => image.complete && image.naturalWidth > 0), {}, ids.length);
    assert.equal(await desktop.page.$eval('#error', (element) => element.hidden), true);
    await assertMenuWorks(desktop.page);
    state.menus = 'replacement';
    state.replacementImagesFail = true;
    await desktop.page.reload({ waitUntil: 'domcontentloaded' });
    await desktop.page.waitForFunction((count) => document.querySelectorAll('.img-wrap > img').length === count && [...document.querySelectorAll('.img-wrap > img')].every((image) => image.complete && image.naturalWidth > 0 && (image.currentSrc.endsWith('_a.png') || image.currentSrc.endsWith('beerpan_fixed.png'))), {}, ids.length);
    assert.ok(await desktop.page.$$eval('.img-wrap > img', (images) => images.every((image) => image.currentSrc.endsWith('_a.png') || image.currentSrc.endsWith('beerpan_fixed.png'))));
    await assertMenuWorks(desktop.page);
    assert.ok(await desktop.page.evaluate(() => JSON.parse(localStorage.getItem('babb:menus:v1')).restaurants.every((restaurant) => restaurant.imageUrl.endsWith('_a.png') || restaurant.imageUrl.endsWith('beerpan_fixed.png'))), 'failed replacement must not overwrite the last successful menu cache');
    state.oldImageDelayMs = 180;
    state.responseOrder = [];
    await desktop.page.reload({ waitUntil: 'domcontentloaded' });
    await desktop.page.waitForFunction((count) => [...document.querySelectorAll('.img-wrap > img')].length === count && [...document.querySelectorAll('.img-wrap > img')].every((image) => image.complete && image.naturalWidth > 0 && (image.currentSrc.endsWith('_a.png') || image.currentSrc.endsWith('beerpan_fixed.png'))), {}, ids.length);
    assert.ok(await desktop.page.$$eval('.img-wrap > img', (images, count) => images.length === count && images.every((image) => image.complete && image.naturalWidth > 0 && (image.currentSrc.endsWith('_a.png') || image.currentSrc.endsWith('beerpan_fixed.png'))), ids.length), 'last successful images must survive a reload while replacement images fail');
    for (const id of ids.filter((item) => item !== 'beerpan')) {
      const failedNewImage = state.responseOrder.indexOf(`/data/images/${id}_b.png`);
      const delayedCachedImage = state.responseOrder.indexOf(`/data/images/${id}_a.png`);
      assert.ok(failedNewImage >= 0 && delayedCachedImage > failedNewImage, `${id}: new image failure must precede delayed cached image completion`);
    }
    state.oldImageDelayMs = 0;
    await assertMenuWorks(desktop.page);
    assert.doesNotMatch(await desktop.page.$eval('body', (element) => element.innerText), /갱신 전|식당 사정/);
    console.log('PASS cached menu survives static JSON failure, failed image replacement, and delayed-image reload');

    state.menus = 'ok';
    state.replacementImagesFail = false;
    const mobile = await newPage({ mobile: true });
    await waitForSocial(mobile.page);
    await assertFramedLayout(mobile.page, true);
    await assertColumns(mobile.page, 1, { mobile: true });
    await assertTitleLinks(mobile.page);
    await assertHolidayBadge(mobile.page);
    await assertMenuWorks(mobile.page);
    assert.ok(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile layout must not overflow');
    await mobile.page.screenshot({ path: path.join(previewRoot, 'restored-mobile.png'), fullPage: true });
    await mobile.page.click(`${firstCard} .menu-title-name`);
    await mobile.page.waitForSelector(`${firstCard} .menu-actions:not([hidden])`);
    await mobile.page.screenshot({ path: path.join(previewRoot, 'restored-mobile-actions.png'), fullPage: true });
    console.log('PASS mobile menus, enlargement, comparison, no horizontal overflow');

    const subpath = await newPage({ basePath: '/babb/' });
    await waitForSocial(subpath.page);
    await assertMenuWorks(subpath.page);
    for (const file of ['script.js', 'menu-core.mjs', 'menu-layout.js', 'menu-view.js', 'social.js', 'config.json', 'data/menus.json', 'data/weather.json']) {
      assert.ok(subpath.localRequests.includes(`/babb/${file}`), `project deployment must load ${file} relative to its base path`);
    }
    assert.equal(new Set(subpath.localRequests.filter((url) => url.startsWith('/babb/data/images/'))).size, ids.length, 'all unique menu photos are loaded under the deployment subpath');
    assert.ok(subpath.localRequests.every((url) => url.startsWith('/babb/') || url === '/favicon.ico'), 'deployment under a repository path must not leak root-relative asset requests');
    await subpath.page.close();
    console.log('PASS repository-subpath deployment loads menu, weather, optional controls and all photos');

    const largeTrain = await newPage({ mobile: true, initialVotes: 2500 });
    await largeTrain.page.waitForSelector(`${firstCard} .emoji-train[aria-label="😍 투표 2500표"]`);
    const largeTrainState = await largeTrain.page.$eval(`${firstCard} .emoji-train[aria-label="😍 투표 2500표"]`, (train) => ({ cars: train.querySelectorAll('.emoji-train-car').length, text: train.textContent, overflow: document.documentElement.scrollWidth > window.innerWidth }));
    assert.ok(largeTrainState.cars > 1 && largeTrainState.cars <= 96, 'large vote totals use a bounded moving pool, never thousands of DOM nodes');
    assert.equal(largeTrainState.text, '😍'.repeat(largeTrainState.cars));
    assert.equal(largeTrainState.overflow, false, 'long trains stay clipped inside their photo');
    await largeTrain.page.close();

    const staticTrain = await newPage({ mobile: true, reducedMotion: true });
    await staticTrain.page.waitForSelector(`${firstCard} .emoji-train[aria-label="😍 투표 4표"]`);
    const staticTrainState = await staticTrain.page.$eval(`${firstCard} .emoji-train[aria-label="😍 투표 4표"]`, (train) => ({ cars: train.querySelectorAll('.emoji-train-car').length, text: train.textContent, animation: getComputedStyle(train).animationName, transition: getComputedStyle(train).transitionDuration }));
    assert.equal(staticTrainState.cars, 4);
    assert.equal(staticTrainState.text, '😍'.repeat(4));
    assert.equal(staticTrainState.animation, 'none');
    assert.equal(staticTrainState.transition, '0s', 'reduced-motion visitors see a still train');
    await staticTrain.page.close();
    console.log('PASS large vote trains keep bounded DOM and reduced-motion trains retain their emoji count');

    for (const failure of ['sdkFailure', 'dbFailure']) {
      const fixture = await newPage({ [failure]: true });
      await fixture.page.waitForFunction(() => document.querySelectorAll('[data-restaurant="beoksan"] .emoji-btn').length === 7);
      await fixture.page.click(`${firstCard} .menu-title-name`);
      await fixture.page.waitForSelector(`${firstCard} .menu-actions:not([hidden])`);
      await fixture.page.type(`${firstCard} .comment-row input`, '오류 확인');
      await fixture.page.click(`${firstCard} .comment-row button`);
      await fixture.page.waitForFunction(() => [...document.querySelectorAll('.social-status')].some((element) => /못했어요|실패|불러올 수/.test(element.textContent)));
      await assertMenuWorks(fixture.page);
      await fixture.page.close();
      console.log(`PASS ${failure} leaves all menus usable`);
    }
    assert.deepEqual(unexpected, [], 'unexpected external requests must never escape fixture interception');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('PASS all local browser checks; no live Firebase or Open-Meteo requests');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
