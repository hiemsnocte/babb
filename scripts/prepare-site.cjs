const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=37.4868&longitude=126.8876&hourly=temperature_2m,weathercode&timezone=Asia%2FSeoul&forecast_days=3';

function decodeValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  throw new Error('Unsupported Firestore value');
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function imageExtension(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return 'gif';
  throw new Error('Image response is not a supported image');
}

async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('Response exceeds size limit');
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('Empty response body');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Response exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error('Empty response body');
  return Buffer.concat(chunks);
}

async function fetchBytes(url, maxBytes, options, label) {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let retryable = false;
    try {
      const response = await options.fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'babb-static-publisher/1.0' } });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return await readLimited(response, maxBytes);
    } catch (error) {
      retryable ||= error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError;
      if (!retryable || attempt + 1 >= options.attempts) {
        // Do not include URLs or raw network errors: config/query values may be sensitive.
        throw new Error(`${label} fetch failed${controller.signal.aborted ? ' (timeout)' : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await options.sleep(500 * (attempt + 1));
  }
}

async function fetchJson(url, options, label) {
  const bytes = await fetchBytes(url, MAX_JSON_BYTES, options, label);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('Restaurant catalog is empty');
  const seen = new Set();
  return catalog.map((restaurant) => {
    const id = restaurant?.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || seen.has(id)) throw new Error('Restaurant IDs must be unique and safe');
    seen.add(id);
    if (typeof restaurant.name !== 'string' || !restaurant.name.trim()) throw new Error(`Invalid restaurant name: ${id}`);
    const source = restaurant.source;
    if (!source || !['capture', 'static'].includes(source.type)) throw new Error(`Invalid menu source: ${id}`);
    if (source.type === 'static' && (typeof source.path !== 'string' || !/^\.\/assets\/menus\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif)$/.test(source.path))) throw new Error(`Invalid static menu path: ${id}`);
    if (restaurant.priceWon !== undefined && (!Number.isSafeInteger(restaurant.priceWon) || restaurant.priceWon <= 0)) throw new Error(`Invalid restaurant price: ${id}`);
    if (restaurant.closedDays !== undefined && (!Array.isArray(restaurant.closedDays) || !restaurant.closedDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))) throw new Error(`Invalid restaurant closed days: ${id}`);
    const closedDays = [...new Set(restaurant.closedDays || [])].sort((a, b) => a - b);
    if (restaurant.links !== undefined && !Array.isArray(restaurant.links)) throw new Error(`Invalid restaurant links: ${id}`);
    const links = (restaurant.links || []).map((link) => {
      let url;
      try { url = new URL(link?.url); } catch { throw new Error(`Invalid restaurant link: ${id}`); }
      if (url.protocol !== 'https:' || url.username || url.password || typeof link.label !== 'string' || !link.label.trim()) throw new Error(`Invalid restaurant link: ${id}`);
      return { label: link.label.trim(), url: url.href };
    });
    return { id, name: restaurant.name.trim(), source: source.type === 'capture' ? { type: 'capture' } : { type: 'static', path: source.path },
      ...(restaurant.priceWon === undefined ? {} : { priceWon: restaurant.priceWon }), closedDays, links };
  });
}

function validateMenus(document, captureIds) {
  if (!document.fields) throw new Error('Menu document is missing');
  const data = decodeFields(document.fields);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || '') || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('Menu date or update time is invalid');
  if (!Array.isArray(data.restaurants)) throw new Error('All configured capture menus are required');
  const restaurants = captureIds.map((id) => {
    const matches = data.restaurants.filter((restaurant) => restaurant.id === id);
    if (matches.length !== 1 || typeof matches[0].name !== 'string' || !matches[0].name.trim()) throw new Error(`Missing or invalid menu: ${id}`);
    const restaurant = matches[0];
    let imageUrl;
    try { imageUrl = new URL(restaurant.imageUrl); } catch { throw new Error(`Invalid menu image URL: ${id}`); }
    if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password) throw new Error(`Invalid menu image URL: ${id}`);
    return { id, name: restaurant.name, imageUrl: imageUrl.href, stale: restaurant.stale === true };
  });
  return { date: data.date, updatedAt: new Date(data.updatedAt).toISOString(), captureErrors: Array.isArray(data.captureErrors) ? data.captureErrors : [], restaurants };
}

async function readStaticImage(publicDir, restaurant) {
  // realpath also prevents a symlink inside the assets folder from escaping it.
  const assetsDir = await fs.realpath(path.join(publicDir, 'assets/menus'));
  const imagePath = await fs.realpath(path.resolve(publicDir, restaurant.source.path));
  const relative = path.relative(assetsDir, imagePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Static menu is outside assets/menus: ${restaurant.id}`);
  const stat = await fs.stat(imagePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error(`Invalid static menu size: ${restaurant.id}`);
  const bytes = await fs.readFile(imagePath);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Invalid static menu size: ${restaurant.id}`);
  return bytes;
}

function validateWeather(data) {
  const hourly = data?.hourly;
  const times = hourly?.time;
  if (!Number.isFinite(data?.latitude) || Math.abs(data.latitude) > 90 || !Number.isFinite(data?.longitude) || Math.abs(data.longitude) > 180 || data?.timezone !== 'Asia/Seoul' || !Array.isArray(times) || times.length === 0 || times.length > 168 || !Array.isArray(hourly.temperature_2m) || !Array.isArray(hourly.weathercode) || hourly.temperature_2m.length !== times.length || hourly.weathercode.length !== times.length) throw new Error('Weather forecast is incomplete');
  if (!times.every((time) => typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)) || !hourly.temperature_2m.every(Number.isFinite) || !hourly.weathercode.every(Number.isInteger)) throw new Error('Weather forecast contains invalid values');
  return { latitude: data.latitude, longitude: data.longitude, timezone: data.timezone, hourly: { time: times, temperature_2m: hourly.temperature_2m, weathercode: hourly.weathercode } };
}

async function prepareSite(input = {}) {
  const options = { publicDir: path.resolve(__dirname, '../public'), fetchImpl: globalThis.fetch, env: process.env, now: new Date(), attempts: 2, timeoutMs: 15000, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger: console, ...input };
  const publicDir = path.resolve(options.publicDir);
  const outputDir = path.join(publicDir, 'data');
  const catalog = validateCatalog(JSON.parse(await fs.readFile(path.join(publicDir, 'restaurants.json'), 'utf8')));
  const captureIds = catalog.filter((restaurant) => restaurant.source.type === 'capture').map((restaurant) => restaurant.id);
  let menus = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(options.now), updatedAt: options.now.toISOString(), captureErrors: [], restaurants: [] };
  if (captureIds.length) {
    const config = JSON.parse(await fs.readFile(path.join(publicDir, 'config.json'), 'utf8'));
    const projectId = options.env.FIREBASE_PROJECT_ID || config.firebase?.projectId;
    const apiKey = options.env.FIREBASE_API_KEY || config.firebase?.apiKey;
    if (!projectId || !apiKey) throw new Error('Firebase public config is missing');
    const documentUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/menus/current?key=${encodeURIComponent(apiKey)}`;
    menus = validateMenus(await fetchJson(documentUrl, options, 'Menu document'), captureIds);
  }
  const captures = new Map(menus.restaurants.map((restaurant) => [restaurant.id, restaurant]));
  const imageResults = await Promise.all(catalog.map(async (restaurant) => {
    const fixed = restaurant.source.type === 'static';
    const capture = captures.get(restaurant.id);
    const bytes = fixed ? await readStaticImage(publicDir, restaurant) : await fetchBytes(capture.imageUrl, MAX_IMAGE_BYTES, options, `${restaurant.id} image`);
    const extension = imageExtension(bytes);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return { restaurant: { id: restaurant.id, name: restaurant.name, imageUrl: `./data/images/${restaurant.id}-${hash}.${extension}`, stale: fixed ? false : capture.stale, menuType: fixed ? 'fixed' : 'daily',
      ...(restaurant.priceWon === undefined ? {} : { priceWon: restaurant.priceWon }), closedDays: restaurant.closedDays, links: restaurant.links }, fileName: `${restaurant.id}-${hash}.${extension}`, bytes };
  }));

  let weather;
  try {
    weather = { schemaVersion: 1, fetchedAt: options.now.toISOString(), ...validateWeather(await fetchJson(WEATHER_URL, options, 'Weather')) };
  } catch {
    options.logger.warn('Weather unavailable; menu publishing continues.');
    try {
      const previous = JSON.parse(await fs.readFile(path.join(outputDir, 'weather.json'), 'utf8'));
      const age = options.now.getTime() - Date.parse(previous.fetchedAt);
      if (previous.schemaVersion === 1 && age >= 0 && age <= 12 * 60 * 60 * 1000) weather = { schemaVersion: 1, fetchedAt: previous.fetchedAt, ...validateWeather(previous) };
    } catch { /* A missing or invalid optional weather cache does not block menus. */ }
  }

  const manifest = { schemaVersion: 1, generatedAt: options.now.toISOString(), ...menus, restaurants: imageResults.map((result) => result.restaurant) };
  // Stage only after every menu image has passed validation. Directory replacement
  // also keeps a pre-existing local build intact when preparation fails.
  const stageDir = await fs.mkdtemp(path.join(publicDir, '.menu-data-stage-'));
  const backupDir = `${stageDir}-previous`;
  let movedPrevious = false;
  let installed = false;
  try {
    try { await fs.cp(outputDir, stageDir, { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.join(stageDir, 'images'), { recursive: true });
    for (const result of imageResults) await fs.writeFile(path.join(stageDir, 'images', result.fileName), result.bytes);
    await fs.writeFile(path.join(stageDir, 'menus.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (weather) await fs.writeFile(path.join(stageDir, 'weather.json'), `${JSON.stringify(weather)}\n`);
    else await fs.rm(path.join(stageDir, 'weather.json'), { force: true });
    try { await fs.rename(outputDir, backupDir); movedPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(stageDir, outputDir); installed = true; } catch (error) {
      if (movedPrevious) { await fs.rename(backupDir, outputDir); movedPrevious = false; }
      throw error;
    }
  } finally {
    // These are exact, generated siblings of public/data, never a workspace root.
    if (!installed) await fs.rm(stageDir, { recursive: true, force: true });
    if (installed && movedPrevious) await fs.rm(backupDir, { recursive: true, force: true });
  }
  options.logger.log(`Prepared ${manifest.restaurants.length} menus; weather ${weather ? 'available' : 'unavailable'}.`);
  return { menus: manifest, weather };
}

if (require.main === module) {
  prepareSite().catch((error) => {
    console.error(`Site preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { prepareSite, decodeFields, imageExtension, validateCatalog, validateMenus, validateWeather };
