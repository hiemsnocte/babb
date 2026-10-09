export const MENU_REFRESH_MS = 5 * 60 * 1000;

export function koreaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function normalizeMenu(data) {
  if (!data || data.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new Error('메뉴 데이터 형식을 확인해 주세요.');
  }
  if (!Array.isArray(data.restaurants) || data.restaurants.length === 0) {
    throw new Error('식당 메뉴가 준비되지 않았어요.');
  }
  const ids = new Set();
  const restaurants = data.restaurants.map((r) => {
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.id) ||
        ids.has(r.id) || typeof r.name !== 'string' || !r.name.trim() ||
        !/^\.\/data\/images\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/.test(r.imageUrl)) {
      throw new Error('메뉴 이미지 정보가 올바르지 않아요.');
    }
    ids.add(r.id);
    if (r.priceWon !== undefined && (!Number.isSafeInteger(r.priceWon) || r.priceWon <= 0)) throw new Error('식당 가격 정보가 올바르지 않아요.');
    if (r.closedDays !== undefined && (!Array.isArray(r.closedDays) || !r.closedDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))) throw new Error('식당 휴무 정보가 올바르지 않아요.');
    const closedDays = [...new Set(r.closedDays || [])].sort((a, b) => a - b);
    if (r.links !== undefined && !Array.isArray(r.links)) throw new Error('식당 링크 정보가 올바르지 않아요.');
    const links = (r.links || []).map((link) => {
      let url;
      try { url = new URL(link?.url); } catch { throw new Error('식당 링크 정보가 올바르지 않아요.'); }
      if (url.protocol !== 'https:' || url.username || url.password || typeof link.label !== 'string' || !link.label.trim()) {
        throw new Error('식당 링크 정보가 올바르지 않아요.');
      }
      return { label: link.label.trim(), url: url.href };
    });
    return { id: r.id, name: r.name, imageUrl: r.imageUrl, stale: r.stale === true,
      menuType: r.menuType === 'fixed' ? 'fixed' : 'daily',
      ...(r.priceWon === undefined ? {} : { priceWon: r.priceWon }), closedDays, links };
  });
  return {
    schemaVersion: 1, date: data.date,
    updatedAt: typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt)) ? data.updatedAt : null,
    restaurants,
  };
}

export function weatherAt(data, now = new Date()) {
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.hourly?.time)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const key = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:00`;
  const index = data.hourly.time.indexOf(key);
  const temperature = data.hourly.temperature_2m?.[index];
  const code = data.hourly.weathercode?.[index];
  if (index < 0 || typeof temperature !== 'number' || !Number.isFinite(temperature) || typeof code !== 'number' || !Number.isFinite(code)) return null;
  const icon = code === 0 ? '☀️' : [1, 2].includes(code) ? '🌤️' : code === 3 ? '☁️' : [45, 48].includes(code) ? '🌫️' : [51, 53, 55, 56, 57].includes(code) ? '🌦️' : [71, 73, 75, 77, 85, 86].includes(code) ? '🌨️' : [95, 96, 99].includes(code) ? '⛈️' : [61, 63, 65, 66, 67, 80, 81, 82].includes(code) ? '🌧️' : '🌡️';
  return { temperature: Math.round(temperature), icon, hour: get('hour') };
}

export function menuSummary(menu) {
  return menu.updatedAt ? `갱신일: ${new Date(menu.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : '';
}
