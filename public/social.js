import { createEmojiTrain, createMarqueeRotation, createSocialClient, EMOJIS, MESSAGE_MAX_LENGTH, nextVote, todayKorea } from './social-core.mjs';

let backendPromise;
export function loadFirebaseBackend(firebaseConfig) {
  if (!backendPromise) {
    backendPromise = Promise.all([
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'),
    ]).then(([appApi, api]) => {
      const app = appApi.getApps().find((item) => item.name === 'babb-social') || appApi.initializeApp(firebaseConfig, 'babb-social');
      const db = api.getFirestore(app);
      const restaurantRef = (id) => api.doc(db, 'menus', 'current', 'restaurants', id);
      const commentsRef = (id) => api.collection(restaurantRef(id), 'comments');
      return {
        async read(id) {
          const saved = await api.getDoc(restaurantRef(id));
          return { restaurant: saved.exists() ? saved.data() : {} };
        },
        subscribeComments(id, onChange, onError) {
          return api.onSnapshot(api.query(commentsRef(id), api.orderBy('createdAt', 'desc'), api.limit(10)),
            (saved) => onChange(saved.docs.map((item) => ({ ...item.data(), id: item.id }))), onError);
        },
        async vote(id, day, emoji) {
          const ref = restaurantRef(id);
          return api.runTransaction(db, async (transaction) => {
            const saved = await transaction.get(ref);
            const counts = nextVote(saved.exists() ? saved.data() : {}, day, emoji);
            const data = { date: day, emojiCounts: counts, updatedAt: api.serverTimestamp() };
            // Replacing this map clears yesterday's votes without touching archived game state.
            if (saved.exists()) transaction.update(ref, data);
            else transaction.set(ref, data);
            return counts;
          });
        },
        sendMessage(id, day, text) {
          return api.addDoc(commentsRef(id), { text, date: day, createdAt: api.serverTimestamp() });
        },
      };
    }).catch((error) => { backendPromise = null; throw error; });
  }
  return backendPromise;
}

// Mount into the existing card overlay; menu rendering and image loading stay independent.
export function mountSocial({ restaurant, firebaseConfig, elements, getToday = todayKorea, loadBackend }) {
  const { emojiRow, commentInput, commentBtn, danmaku, status } = elements;
  let storage;
  try { storage = window.localStorage; } catch { /* In-memory cooldowns still work. */ }
  const client = createSocialClient({
    restaurantId: restaurant.id, storage, getToday,
    loadBackend: loadBackend || (() => loadFirebaseBackend(firebaseConfig)),
  });
  let disposed = false;
  let busy = false;
  let cooldownTimer;
  let hiddenTimer;
  let loopTimer;
  let visibleInViewport = true;
  let currentDay = getToday();
  let staticTicks = 0;
  const flying = new Map();
  const rotation = createMarqueeRotation();
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const palette = ['#FF4D6D', '#FFD166', '#06D6A0', '#4D96FF', '#B517FF', '#F72585', '#72EFDD'];
  status.hidden = true;
  status.setAttribute('role', 'status');
  commentInput.maxLength = MESSAGE_MAX_LENGTH;

  const voteButtons = EMOJIS.map((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji-btn';
    button.textContent = emoji;
    const click = async (event) => {
      event.stopPropagation();
      if (await perform(() => client.vote(emoji))) {
        const count = client.snapshot().counts[emoji];
        if (count) spawnDanmaku({ key: 'vote:' + emoji, kind: 'vote', emoji, count }, true);
      }
    };
    button.addEventListener('click', click);
    return { emoji, button, click };
  });
  emojiRow.replaceChildren(...voteButtons.map(({ button }) => button));

  function clearFlying() {
    for (const { finish } of [...flying.values()]) finish();
  }

  function spawnDanmaku(item, priority = false) {
    if (disposed || document.hidden || !visibleInViewport || !item) return;
    const isTrain = item.kind === 'vote';
    if (isTrain ? !EMOJIS.includes(item.emoji) || !Number.isSafeInteger(item.count) || item.count < 1 : !item.text) return;
    const duplicate = [...flying.values()].find((flight) => flight.item.key === item.key);
    if (duplicate) {
      if (!priority) return;
      duplicate.finish();
    }
    if (motion?.matches) clearFlying();
    else {
      // A long train must not occupy the last lane reserved for messages.
      const trains = [...flying.values()].filter(({ item: active }) => active.kind === 'vote');
      if (isTrain && trains.length >= 2) {
        if (!priority) return;
        trains[0].finish();
      }
      if (flying.size >= 3) {
        if (!priority) return;
        (isTrain && trains[0] ? trains[0] : flying.values().next().value).finish();
      }
    }
    const span = document.createElement('span');
    span.className = isTrain ? 'danmaku-line emoji-train' : 'danmaku-line';
    span.dataset.marqueeKind = item.kind;
    if (isTrain) {
      span.setAttribute('role', 'img');
      span.setAttribute('aria-label', item.emoji + ' 투표 ' + item.count + '표');
    } else span.textContent = item.text;
    Object.assign(span.style, {
      color: palette[Math.floor(Math.random() * palette.length)],
      top: (Math.floor(Math.random() * 70) + 8) + '%', position: 'absolute',
      left: motion?.matches ? '12px' : '0', animation: 'none',
    });
    danmaku.appendChild(span);
    let timer;
    let frame;
    const finish = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      span.removeEventListener('transitionend', onEnd);
      span.remove();
      flying.delete(span);
    };
    const onEnd = (event) => { if (event.propertyName === 'transform') finish(); };
    flying.set(span, { finish, item });
    if (isTrain) {
      const train = createEmojiTrain(item.count, danmaku.clientWidth, { priority, speed: 48 + Math.random() * 20 });
      const cars = Array.from({ length: train.poolSize }, () => {
        const car = document.createElement('span');
        car.className = 'emoji-train-car';
        car.textContent = item.emoji;
        car.setAttribute('aria-hidden', 'true');
        Object.assign(car.style, {
          display: 'inline-block', width: train.pitch + 'px', textAlign: 'center',
          position: 'static', font: 'inherit', whiteSpace: 'nowrap',
        });
        return car;
      });
      span.replaceChildren(...cars);
      Object.assign(span.style, { height: '28px', lineHeight: '28px', width: train.poolSize * train.pitch + 'px' });
      if (motion?.matches) {
        Object.assign(span.style, { top: '12px', left: '12px' });
        return;
      }
      let began;
      let lastCount = cars.length;
      span.style.willChange = 'transform';
      const animate = (time) => {
        if (!flying.has(span)) return;
        if (began === undefined) began = time;
        const state = train.frame(time - began);
        if (state.done) { finish(); return; }
        if (lastCount !== state.visibleCount) {
          cars.forEach((car, index) => { car.style.display = index >= state.visibleCount ? 'none' : 'inline-block'; });
          lastCount = state.visibleCount;
        }
        span.style.transform = 'translateX(' + state.offsetX + 'px)';
        frame = requestAnimationFrame(animate);
      };
      span.style.transform = 'translateX(' + train.frame(0).offsetX + 'px)';
      frame = requestAnimationFrame(animate);
      return;
    }
    if (motion?.matches) {
      Object.assign(span.style, { top: '12px', right: '12px', whiteSpace: 'normal', maxWidth: 'calc(100% - 24px)' });
      return;
    }
    const width = danmaku.clientWidth;
    const textWidth = Math.max(span.offsetWidth, 1);
    const start = priority ? Math.max(0, width - textWidth - 12) : width;
    const duration = (start + textWidth + 16) / (48 + Math.random() * 20);
    span.style.willChange = 'transform';
    span.style.transform = 'translateX(' + start + 'px)';
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!flying.has(span)) return;
        span.style.transition = 'transform ' + duration + 's linear';
        span.style.transform = 'translateX(' + (-textWidth) + 'px)';
      });
    });
    span.addEventListener('transitionend', onEnd);
    timer = setTimeout(finish, duration * 1000 + 400);
  }

  function tick() {
    if (disposed || document.hidden || !visibleInViewport) return;
    if (currentDay !== getToday()) { currentDay = getToday(); clearFlying(); render(); }
    if (motion?.matches && flying.size && ++staticTicks % 6 !== 0) return;
    if (!motion?.matches && flying.size >= 3) return;
    const active = motion?.matches ? [] : [...flying.values()].map(({ item }) => item.key);
    const item = rotation.next(client.snapshot(), active);
    if (item) spawnDanmaku(item);
  }

  function render() {
    if (disposed) return;
    const state = client.snapshot();
    for (const { emoji, button } of voteButtons) {
      const count = state.counts[emoji] || 0;
      button.title = emoji + ' ' + count + '표';
      button.setAttribute('aria-label', emoji + ' 투표 ' + count + '표');
      button.disabled = busy || state.voteWaitMs > 0;
    }
    commentInput.disabled = busy;
    commentBtn.disabled = busy || state.messageWaitMs > 0;
    clearTimeout(cooldownTimer);
    const waits = [state.voteWaitMs, state.messageWaitMs].filter((wait) => wait > 0);
    if (waits.length) cooldownTimer = setTimeout(render, Math.min(...waits) + 25);
  }

  async function perform(action) {
    if (disposed || busy) return false;
    busy = true;
    status.hidden = true;
    status.textContent = '';
    render();
    try {
      await action();
      return !disposed;
    } catch (error) {
      if (!disposed) {
        status.textContent = /[가-힣]/.test(error?.message || '') ? error.message : '처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
        status.hidden = false;
      }
      return false;
    } finally { busy = false; render(); }
  }

  const send = async (event) => {
    event.stopPropagation();
    const text = commentInput.value.trim();
    if (!text) return;
    if (await perform(() => client.sendMessage(text))) {
      commentInput.value = '';
      spawnDanmaku({ key: 'message:' + text, kind: 'message', text }, true);
    }
  };
  const onKey = (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); commentBtn.click(); }
  };
  commentBtn.addEventListener('click', send);
  commentInput.addEventListener('keydown', onKey);

  function activate() {
    if (disposed || document.hidden) return;
    client.load().then(() => { render(); tick(); }).catch(() => {});
    client.startComments(() => { render(); tick(); }).catch(() => {});
  }

  function updateLoop() {
    clearInterval(loopTimer);
    loopTimer = null;
    if (document.hidden || !visibleInViewport || disposed) { clearFlying(); return; }
    tick();
    loopTimer = setInterval(tick, 1800);
  }
  const onVisibility = () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) hiddenTimer = setTimeout(() => client.stopComments(), 30_000);
    else { activate(); render(); }
    updateLoop();
  };
  const onMotion = () => { clearFlying(); staticTicks = 0; updateLoop(); };
  document.addEventListener('visibilitychange', onVisibility);
  motion?.addEventListener?.('change', onMotion);
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
    visibleInViewport = entry.isIntersecting;
    updateLoop();
  }) : null;
  observer?.observe(danmaku.parentElement || danmaku);
  let marqueeWidth = danmaku.clientWidth;
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const width = danmaku.clientWidth;
    if (disposed || width === marqueeWidth) return;
    marqueeWidth = width;
    // Column switches change the train pool and travel distance, even while visible.
    clearFlying();
    staticTicks = 0;
    updateLoop();
  }) : null;
  resizeObserver?.observe(danmaku);
  render();
  activate();
  updateLoop();

  return {
    activate,
    destroy() {
      if (disposed) return;
      disposed = true;
      client.stopComments();
      clearInterval(loopTimer);
      clearTimeout(cooldownTimer);
      clearTimeout(hiddenTimer);
      clearFlying();
      observer?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion?.removeEventListener?.('change', onMotion);
      commentBtn.removeEventListener('click', send);
      commentInput.removeEventListener('keydown', onKey);
      for (const { button, click } of voteButtons) button.removeEventListener('click', click);
    },
  };
}
