export const EMOJIS = ['😍', '😋', '🤔', '😑', '😒', '😡', '🤬'];
export const REFRESH_INTERVAL_MS = 60_000;
export const VOTE_INTERVAL_MS = 3_000;
export const MESSAGE_INTERVAL_MS = 30_000;
export const MESSAGE_MAX_LENGTH = 120;
export const MAX_TRAIN_CARS = 96;

// Keep only a viewport-sized window of a train, even for very large vote counts.
// The first index advances; no votes are dropped and no count-sized array is built.
export function createEmojiTrain(count, width, { priority = false, speed = 56 } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid train count');
  const viewport = Number.isFinite(width) ? Math.max(1, width) : 1;
  const pitch = Math.max(32, Math.ceil(viewport / (MAX_TRAIN_CARS - 2)));
  const poolSize = Math.min(count, Math.ceil(viewport / pitch) + 2);
  const start = priority ? Math.max(12, viewport - poolSize * pitch - 12) : viewport;
  return {
    pitch, poolSize,
    frame(elapsedMs) {
      const distance = Math.max(0, elapsedMs) * speed / 1000 - start;
      const passed = Math.floor(distance / pitch);
      const remainder = distance - passed * pitch;
      const firstIndex = Math.max(0, passed - 1);
      return {
        firstIndex,
        offsetX: (firstIndex - passed) * pitch - remainder,
        visibleCount: Math.max(0, Math.min(poolSize, count - firstIndex)),
        done: firstIndex >= count,
      };
    },
  };
}

export function todayKorea(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function countsForDay(data, day) {
  if (!data || data.date !== day) return {};
  const counts = {};
  for (const [emoji, value] of Object.entries(data.emojiCounts || {})) {
    if (EMOJIS.includes(emoji) && Number.isSafeInteger(value) && value >= 0) counts[emoji] = value;
  }
  return counts;
}

export function nextVote(data, day, emoji) {
  if (!EMOJIS.includes(emoji)) throw new Error('지원하지 않는 이모지입니다.');
  const counts = countsForDay(data, day);
  counts[emoji] = (counts[emoji] || 0) + 1;
  return counts;
}

// Alternate messages and vote totals so neither can crowd the other out.
export function createMarqueeRotation() {
  let nextKind = 'vote';
  const lastKey = {};
  return {
    next({ counts = {}, comments = [] }, activeKeys = []) {
      const groups = {
        vote: EMOJIS.filter((emoji) => Number.isSafeInteger(counts[emoji]) && counts[emoji] > 0)
          .map((emoji) => ({ key: 'vote:' + emoji, kind: 'vote', emoji, count: counts[emoji] })),
        message: [...new Set(comments.map((comment) => comment.text).filter(Boolean))]
          .map((text) => ({ key: 'message:' + text, kind: 'message', text })),
      };
      for (const kind of [nextKind, nextKind === 'vote' ? 'message' : 'vote']) {
        const entries = groups[kind];
        const start = entries.findIndex((item) => item.key === lastKey[kind]) + 1;
        for (let offset = 0; offset < entries.length; offset += 1) {
          const entry = entries[(start + offset) % entries.length];
          if (activeKeys.includes(entry.key)) continue;
          lastKey[kind] = entry.key;
          nextKind = kind === 'vote' ? 'message' : 'vote';
          return entry;
        }
      }
      return null;
    },
  };
}

// Browser cooldowns prevent accidental bursts; they are not an abuse-prevention boundary.
export function createSocialClient({ restaurantId, loadBackend, storage, getToday = todayKorea, now = Date.now }) {
  if (typeof restaurantId !== 'string' || !restaurantId || restaurantId.includes('/')) {
    throw new Error('식당 정보가 올바르지 않습니다.');
  }
  let backendPromise;
  let readPromise;
  let writing = false;
  let lastReadAt = null;
  let countsLoaded = false;
  let loadedDay = '';
  let counts = {};
  let countsRevision = 0;
  let comments = [];
  let subscriptionGeneration = 0;
  let subscriptionPending = false;
  let unsubscribe;
  let subscriptionFailedAt = null;
  const memory = new Map();
  const key = (kind, day) => ['babb', kind, restaurantId, day].join(':');
  const readGuard = (name) => {
    try { return storage?.getItem(name) || memory.get(name) || ''; }
    catch { return memory.get(name) || ''; }
  };
  const saveGuard = (name, value) => {
    memory.set(name, value);
    try { storage?.setItem(name, value); } catch { /* Private browsing can deny storage. */ }
  };
  const backend = () => {
    if (!backendPromise) {
      backendPromise = Promise.resolve().then(loadBackend).catch((error) => {
        backendPromise = null;
        throw error;
      });
    }
    return backendPromise;
  };
  const cooldown = (kind, interval) => {
    const saved = readGuard(key(kind, getToday()));
    const value = Number(saved);
    return saved && Number.isFinite(value) ? Math.max(0, interval - (now() - value)) : 0;
  };
  const normalizeComments = (items) => (items || []).filter((comment) =>
    comment.date === getToday() && typeof comment.text === 'string' && comment.text.trim(),
  ).slice(0, 10).map((comment) => ({ ...comment, text: comment.text.slice(0, MESSAGE_MAX_LENGTH) }));
  const refreshWaitMs = () => lastReadAt === null ? 0 : Math.max(0, REFRESH_INTERVAL_MS - (now() - lastReadAt));
  const snapshot = () => ({
    counts: loadedDay === getToday() ? { ...counts } : {},
    comments: normalizeComments(comments),
    busy: Boolean(readPromise) || writing,
    refreshWaitMs: refreshWaitMs(),
    voteWaitMs: cooldown('vote-time', VOTE_INTERVAL_MS),
    messageWaitMs: cooldown('message', MESSAGE_INTERVAL_MS),
  });

  return {
    snapshot,
    async load() {
      if (readPromise) return readPromise;
      if (countsLoaded || refreshWaitMs() > 0) return snapshot();
      lastReadAt = now();
      const revision = countsRevision;
      readPromise = (async () => {
        const api = await backend();
        const day = getToday();
        const data = await api.read(restaurantId);
        // A slow initial read must not replace the result of a newer vote.
        if (revision === countsRevision) {
          counts = countsForDay(data.restaurant, day);
          loadedDay = day;
        }
        countsLoaded = true;
        return snapshot();
      })();
      try { return await readPromise; }
      finally { readPromise = null; }
    },
    async startComments(onChange, onError = () => {}) {
      if (unsubscribe || subscriptionPending) return;
      if (subscriptionFailedAt !== null && now() - subscriptionFailedAt < REFRESH_INTERVAL_MS) return;
      const generation = ++subscriptionGeneration;
      subscriptionPending = true;
      const fail = (error) => {
        if (generation !== subscriptionGeneration) return;
        subscriptionFailedAt = now();
        subscriptionPending = false;
        unsubscribe?.();
        unsubscribe = null;
        onError(error);
      };
      try {
        const api = await backend();
        if (generation !== subscriptionGeneration) return;
        let failedSynchronously = false;
        const stop = api.subscribeComments(restaurantId, (items) => {
          if (generation !== subscriptionGeneration) return;
          comments = normalizeComments(items);
          onChange(snapshot());
        }, (error) => { failedSynchronously = true; fail(error); });
        if (generation !== subscriptionGeneration || failedSynchronously) stop();
        else { unsubscribe = stop; subscriptionPending = false; subscriptionFailedAt = null; }
      } catch (error) { fail(error); }
    },
    stopComments() {
      subscriptionGeneration += 1;
      subscriptionPending = false;
      unsubscribe?.();
      unsubscribe = null;
    },
    async vote(emoji) {
      if (!EMOJIS.includes(emoji)) throw new Error('지원하지 않는 이모지입니다.');
      if (writing) throw new Error('처리 중입니다. 잠시 기다려 주세요.');
      if (cooldown('vote-time', VOTE_INTERVAL_MS) > 0) throw new Error('투표는 3초 간격으로 할 수 있어요.');
      writing = true;
      try {
        const api = await backend();
        const day = getToday();
        if (cooldown('vote-time', VOTE_INTERVAL_MS) > 0) throw new Error('투표는 3초 간격으로 할 수 있어요.');
        counts = await api.vote(restaurantId, day, emoji);
        countsRevision += 1;
        loadedDay = day;
        saveGuard(key('vote-time', day), String(now()));
      } finally { writing = false; }
      return snapshot();
    },
    async sendMessage(rawText) {
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!text) throw new Error('전광판에 보낼 메시지를 적어 주세요.');
      if (text.length > MESSAGE_MAX_LENGTH) throw new Error('메시지는 ' + MESSAGE_MAX_LENGTH + '자까지 보낼 수 있어요.');
      if (writing) throw new Error('처리 중입니다. 잠시 기다려 주세요.');
      if (cooldown('message', MESSAGE_INTERVAL_MS) > 0) throw new Error('메시지는 30초 간격으로 보낼 수 있어요.');
      writing = true;
      try {
        const api = await backend();
        const day = getToday();
        const saved = await api.sendMessage(restaurantId, day, text);
        const id = saved?.id || 'local-' + now();
        comments = [{ id, text, date: day }, ...comments.filter((comment) => comment.id !== id)].slice(0, 10);
        saveGuard(key('message', day), String(now()));
      } finally { writing = false; }
      return snapshot();
    },
  };
}
