import { MENU_REFRESH_MS, normalizeMenu, weatherAt, menuSummary } from './menu-core.mjs';
import { openImageModal, openCompareModal } from './menu-view.js';
import { initMenuLayout } from './menu-layout.js';

initMenuLayout();

const menusEl = document.getElementById('menus');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const updatedLine = document.getElementById('updated-line');
const compareBtn = document.getElementById('compare-btn');
const debugEl = document.getElementById('debug');
const DEBUG_ENABLED = new URLSearchParams(location.search).has('debug');
document.getElementById('gh-footer').hidden = !DEBUG_ENABLED;
const CACHE_KEY = 'babb:menus:v1';
const cards = new Map();
let currentMenu, weatherData, refreshPromise, timer, socialPromise;
let lastRefresh = 0;
let lastAttempt = 0;

async function readJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function cacheDisplayedMenu() {
  if (!currentMenu || !currentMenu.restaurants.every((r) => cards.get(r.id)?.displayedUrl === r.imageUrl)) return;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(currentMenu)); } catch { /* Storage may be disabled. */ }
}

function ensureSocial(state) {
  if (state.disposed) return Promise.resolve(null);
  if (state.social) return Promise.resolve(state.social);
  if (state.socialMountPromise) return state.socialMountPromise;
  state.socialMountPromise = (async () => {
    try {
      socialPromise ||= Promise.all([import('./social.js'), readJson('./config.json')]).catch((error) => { socialPromise = null; throw error; });
      const [module, config] = await socialPromise;
      if (state.disposed) return null;
      state.social = module.mountSocial({ restaurant: state.restaurant, firebaseConfig: config.firebase, elements: state.elements });
      return state.social;
    } catch (error) {
      console.warn('참여 기능을 불러오지 못했습니다.', error);
      return null;
    } finally { state.socialMountPromise = null; }
  })();
  return state.socialMountPromise;
}

function queueSocial(state) {
  if (state.socialQueued || state.disposed) return;
  state.socialQueued = true;
  // Menu paints before optional social network initialization.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!state.disposed) ensureSocial(state);
  }));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function createCard(restaurant) {
  const card = element('section', 'menu-card');
  card.dataset.restaurant = restaurant.id;
  const title = element('div', 'menu-title');
  const titleTop = element('div', 'menu-title-top');
  const heading = element('div', 'menu-heading');
  const titleName = element('span', 'menu-title-name');
  const price = element('span', 'menu-price');
  price.hidden = true;
  heading.append(titleName, price);
  titleTop.append(heading);
  title.append(titleTop);
  const wrap = element('div', 'img-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'button');
  wrap.setAttribute('aria-label', `${restaurant.name} 메뉴 참여`);
  const img = element('img');
  img.decoding = 'async';
  img.draggable = false;
  img.addEventListener('dragstart', (event) => event.preventDefault());
  const danmaku = element('div', 'danmaku');
  const closedBadge = element('span', 'menu-closed-badge');
  closedBadge.hidden = true;
  closedBadge.addEventListener('click', (event) => event.stopPropagation());
  const actions = element('div', 'menu-actions');
  actions.hidden = true;
  const viewOnlyBtn = element('button', 'menu-viewonly-btn', '메뉴만 보기');
  viewOnlyBtn.type = 'button';
  viewOnlyBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (img.getAttribute('src')) openImageModal(img.src, img.alt);
  });
  const emojiRow = element('div', 'emoji-row');
  const commentRow = element('div', 'comment-row');
  const commentInput = element('input');
  commentInput.type = 'text';
  commentInput.placeholder = '+한마디';
  commentInput.disabled = true;
  commentInput.setAttribute('aria-label', `${restaurant.name} 한마디`);
  const commentBtn = element('button', '', '+한마디');
  commentBtn.type = 'button';
  commentBtn.disabled = true;
  commentRow.append(commentInput, commentBtn);
  const status = element('p', 'inline-status social-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  actions.append(viewOnlyBtn, emojiRow, commentRow, status);
  wrap.append(img, danmaku, actions, closedBadge);
  const links = element('nav', 'restaurant-links');
  links.hidden = true;
  links.addEventListener('click', (event) => event.stopPropagation());
  titleTop.append(links);
  card.append(title, wrap);
  const state = {
    card, titleName, price, closedBadge, img, links, restaurant, displayedUrl: null, requestedUrl: null,
    social: null, socialMountPromise: null, socialQueued: false, disposed: false,
    elements: { emojiRow, commentInput, commentBtn, danmaku, actions, status },
  };
  const openPanel = () => {
    for (const item of cards.values()) item.elements.actions.hidden = true;
    actions.hidden = false;
    ensureSocial(state).then((social) => {
      if (social) social.activate?.();
      else if (!actions.hidden) { status.textContent = '잠시 후 다시 시도해 주세요.'; status.hidden = false; }
    });
    if (matchMedia('(pointer: fine)').matches && !/\bEdg\//.test(navigator.userAgent)) commentInput.focus();
  };
  for (const node of [wrap, title]) {
    node.addEventListener('click', (event) => {
      if (actions.hidden) openPanel();
      event.stopPropagation();
    });
  }
  wrap.addEventListener('keydown', (event) => {
    if (event.target === wrap && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openPanel(); }
  });
  actions.addEventListener('click', (event) => event.stopPropagation());
  menusEl.append(card);
  return state;
}

function updateCard(state, restaurant) {
  state.restaurant = restaurant;
  state.titleName.textContent = restaurant.name;
  state.price.textContent = restaurant.priceWon === undefined ? '' : `(${restaurant.priceWon.toLocaleString('ko-KR')}원)`;
  state.price.hidden = restaurant.priceWon === undefined;
  const closedDays = (restaurant.closedDays || []).map((day) => ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'][day]);
  state.closedBadge.textContent = closedDays.length ? `휴무: ${closedDays.join('·')}` : '';
  state.closedBadge.hidden = closedDays.length === 0;
  state.closedBadge.setAttribute('aria-label', `정기 휴무: ${closedDays.join(', ')}`);
  state.img.alt = `${restaurant.name} 메뉴`;
  state.img.parentElement.setAttribute('aria-label', `${restaurant.name} 메뉴 참여`);
  state.elements.commentInput.setAttribute('aria-label', `${restaurant.name} 한마디`);
  state.links.setAttribute('aria-label', `${restaurant.name} 소식`);
  const linkKey = JSON.stringify(restaurant.links);
  if (state.linkKey !== linkKey) {
    state.linkKey = linkKey;
    state.links.replaceChildren(...restaurant.links.map(({ label, url }) => {
      const link = element('a', '', label);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }));
    state.links.hidden = restaurant.links.length === 0;
  }
  if (state.displayedUrl === restaurant.imageUrl || state.requestedUrl === restaurant.imageUrl) return;
  state.requestedUrl = restaurant.imageUrl;
  const requestedUrl = restaurant.imageUrl;
  const pending = new Image();
  pending.decoding = 'async';
  if (cards.keys().next().value === restaurant.id) pending.fetchPriority = 'high';
  const display = () => {
    // Every card uses the same 4:3 area. Wide menus fill its height without
    // cropping; tall menus keep their proportions and side margins.
    state.img.classList.toggle('menu-contain', pending.naturalWidth / pending.naturalHeight < 4 / 3);
    state.img.src = requestedUrl;
    state.displayedUrl = requestedUrl;
    queueSocial(state);
  };
  pending.onload = () => {
    if (state.disposed) return;
    if (state.requestedUrl !== requestedUrl) {
      // A delayed cached image remains a valid fallback, never replacing newer images.
      if (!state.displayedUrl) display();
      return;
    }
    display();
    cacheDisplayedMenu();
  };
  pending.onerror = () => {
    if (state.disposed || state.requestedUrl !== requestedUrl) return;
    state.requestedUrl = null;
    console.warn(`${restaurant.name} 메뉴 이미지 로드 실패: 이전 정상 이미지 유지`);
  };
  pending.src = requestedUrl;
}

function renderMenu(menu) {
  currentMenu = menu;
  const activeIds = new Set(menu.restaurants.map((r) => r.id));
  for (const [id, state] of cards) {
    if (activeIds.has(id)) continue;
    state.disposed = true;
    state.social?.destroy();
    state.card.remove();
    cards.delete(id);
  }
  for (const r of menu.restaurants) {
    if (!cards.has(r.id)) cards.set(r.id, createCard(r));
    updateCard(cards.get(r.id), r);
  }
  // Move only out-of-order cards so stable cards keep focus and observers intact.
  menu.restaurants.forEach((r, index) => {
    const card = cards.get(r.id).card;
    if (menusEl.children[index] !== card) menusEl.insertBefore(card, menusEl.children[index] || null);
  });
  loadingEl.hidden = true;
  errorEl.hidden = true;
  compareBtn.disabled = false;
  updatedLine.textContent = menuSummary(menu);
  updatedLine.hidden = !updatedLine.textContent;
  if (DEBUG_ENABLED) { debugEl.hidden = false; debugEl.textContent = JSON.stringify(menu, null, 2); }
  cacheDisplayedMenu();
}

function renderWeather() {
  const result = weatherAt(weatherData);
  if (!result) return;
  document.getElementById('weather-icon').textContent = result.icon;
  document.getElementById('weather-temp').textContent = `${result.temperature}°C`;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  document.getElementById('weather-time').textContent = `${part('month')}월 ${part('day')}일 ${part('hour')}:${part('minute')}`;
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  lastAttempt = Date.now();
  refreshPromise = (async () => {
    readJson('./data/weather.json').then((data) => { weatherData = data; renderWeather(); }).catch(() => renderWeather());
    try {
      renderMenu(normalizeMenu(await readJson('./data/menus.json')));
      lastRefresh = Date.now();
    } catch (error) {
      loadingEl.hidden = true;
      if (!currentMenu) { errorEl.textContent = '메뉴를 불러올 수 없습니다. 잠시 후 새로고침해 주세요.'; errorEl.hidden = false; }
      console.warn('메뉴 갱신 실패: 마지막 정상 메뉴 유지', error);
    } finally { refreshPromise = null; }
  })();
  return refreshPromise;
}

function scheduleRefresh() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!document.hidden) await refresh();
    scheduleRefresh();
  }, MENU_REFRESH_MS + Math.floor(Math.random() * 30000));
}

try {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) renderMenu(normalizeMenu(JSON.parse(cached)));
} catch { /* Invalid cache never prevents a fresh load. */ }
compareBtn.addEventListener('click', () => {
  if (!currentMenu) return;
  openCompareModal(currentMenu.restaurants.map((r) => ({ ...r, imageUrl: cards.get(r.id)?.displayedUrl || r.imageUrl })));
});
document.addEventListener('click', () => { for (const state of cards.values()) state.elements.actions.hidden = true; });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderWeather();
    if (Date.now() - Math.max(lastRefresh, lastAttempt) >= MENU_REFRESH_MS) refresh();
  }
});
setInterval(() => { if (!document.hidden) renderWeather(); }, 60000);
refresh();
scheduleRefresh();
