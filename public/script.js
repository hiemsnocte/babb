/**
 * Firestore `menus/current` 문서를 실시간 구독해 메뉴 이미지를 표시합니다.
 * 필드:
 * - restaurants: [{ id, name, imageUrl }] (신규)
 * - imageUrl: string (구버전 호환)
 * - date (선택)
 * - updatedAt (선택: Firestore Timestamp)
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  setDoc,
  increment,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCpQ-Q0fEyjRIpXUQ2VrntpVuiUbhVkak8',
  authDomain: 'babb-6cbaf.firebaseapp.com',
  projectId: 'babb-6cbaf',
  storageBucket: 'babb-6cbaf.firebasestorage.app',
  messagingSenderId: '565390681272',
  appId: '1:565390681272:web:7a65ee4670e0bcb4ce404d',
  measurementId: 'G-9G3XJBN4YL',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const dateLine = document.getElementById('date-line');
const updatedLine = document.getElementById('updated-line');
const menusEl = document.getElementById('menus');
const debugEl = document.getElementById('debug');
const DEBUG_ENABLED = new URLSearchParams(window.location.search).has('debug');

const EMOJIS = ['😍', '😋', '🤔', '😑', '😒', '😡', '🤬'];
const DANMAKU_REPEAT_LIMIT = 10;

function todayDateKorea() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// 남구로역(대략) 좌표
const WEATHER_LAT = 37.4868;
const WEATHER_LON = 126.8876;

function weatherIconFromCode(code) {
  // Open-Meteo weathercode
  if (code === 0) return '☀️';
  if (code === 1 || code === 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if ([51, 53, 55, 56, 57].includes(code)) return '🌦️';
  if ([61, 63, 65, 66, 67].includes(code)) return '🌧️';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '🌨️';
  if ([80, 81, 82].includes(code)) return '🌧️';
  if ([95, 96, 99].includes(code)) return '⛈️';
  return '🌡️';
}

function formatKstMonthDayTime(d) {
  const kst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const m = String(kst.getMonth() + 1);
  const day = String(kst.getDate());
  const hh = String(kst.getHours()).padStart(2, '0');
  const mm = String(kst.getMinutes()).padStart(2, '0');
  return `${m}월 ${day}일 ${hh}:${mm}`;
}

async function updateWeatherNowHourly() {
  const iconEl = document.getElementById('weather-icon');
  const tempEl = document.getElementById('weather-temp');
  const timeEl = document.getElementById('weather-time');
  if (!iconEl || !tempEl || !timeEl) return;

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}` +
      `&longitude=${WEATHER_LON}` +
      `&hourly=temperature_2m,weathercode` +
      `&timezone=Asia%2FSeoul`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`weather http ${res.status}`);
    const data = await res.json();

    const now = new Date();
    const nowKst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const hourKey = `${nowKst.getFullYear()}-${String(nowKst.getMonth() + 1).padStart(2, '0')}-${String(nowKst.getDate()).padStart(2, '0')}T${String(nowKst.getHours()).padStart(2, '0')}:00`;

    const times = data?.hourly?.time || [];
    const idx = times.indexOf(hourKey);
    const t = idx >= 0 ? data.hourly.temperature_2m[idx] : null;
    const c = idx >= 0 ? data.hourly.weathercode[idx] : null;

    if (typeof t === 'number') tempEl.textContent = `${Math.round(t)}°C`;
    if (typeof c === 'number') iconEl.textContent = weatherIconFromCode(c);
    timeEl.textContent = formatKstMonthDayTime(now);
  } catch (e) {
    // 조용히 실패(메뉴 기능은 계속)
    console.error(e);
  }
}

function scheduleWeatherHourly() {
  const now = new Date();
  const nowKst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const next = new Date(nowKst);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  const ms = Math.max(1000, next.getTime() - nowKst.getTime());
  setTimeout(() => {
    updateWeatherNowHourly();
    scheduleWeatherHourly();
  }, ms);
}

updateWeatherNowHourly();
scheduleWeatherHourly();

function randomColor() {
  const palette = [
    '#FF4D6D',
    '#FFD166',
    '#06D6A0',
    '#4D96FF',
    '#B517FF',
    '#F72585',
    '#72EFDD',
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

function scheduleResetAtKstMidnight() {
  // Firestore는 date 필드 기준으로 "오늘 메뉴"만 보여주고,
  // 클라이언트쪽 반복 제한 카운터만 KST 24:00에 리셋합니다.
  const now = new Date();
  const nowKst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const next = new Date(nowKst);
  next.setHours(24, 0, 0, 0);
  const ms = Math.max(1000, next.getTime() - nowKst.getTime());
  setTimeout(() => {
    window.__BABB_DANMAKU_SEEN__ = {};
    scheduleResetAtKstMidnight();
  }, ms);
}
window.__BABB_DANMAKU_SEEN__ = {};
scheduleResetAtKstMidnight();

function formatFirestoreTime(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    } catch {
      return '';
    }
  }
  return '';
}

function showError(message) {
  loadingEl.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
  updatedLine.hidden = true;
  dateLine.hidden = true;
  menusEl.innerHTML = '';
  if (debugEl) debugEl.hidden = true;
}

function showDebug(data, renderedRestaurants) {
  if (!DEBUG_ENABLED) return;
  if (!debugEl) return;
  const debug = {
    restaurants_len: Array.isArray(data.restaurants) ? data.restaurants.length : null,
    rendered_len: renderedRestaurants.length,
    restaurants: renderedRestaurants.map((r) => ({
      id: r.id ?? null,
      name: r.name ?? null,
      imageUrl: r.imageUrl ?? null,
    })),
    legacy_imageUrl:
      typeof data.imageUrl === 'string' && data.imageUrl.length > 0 ? data.imageUrl : null,
    captureErrors: Array.isArray(data.captureErrors) ? data.captureErrors : null,
  };
  debugEl.textContent = JSON.stringify(debug, null, 2);
  debugEl.hidden = false;
}

function renderMenus(restaurants) {
  menusEl.innerHTML = '';
  for (const r of restaurants) {
    const card = document.createElement('section');
    card.className = 'menu-card';

    const title = document.createElement('h2');
    title.className = 'menu-title';
    const titleLeft = document.createElement('span');
    titleLeft.textContent = r.name || r.id || '메뉴';
    const titleRight = document.createElement('span');
    titleRight.className = 'title-right';
    title.appendChild(titleLeft);
    title.appendChild(titleRight);

    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';

    const danmaku = document.createElement('div');
    danmaku.className = 'danmaku';

    const img = document.createElement('img');
    img.alt = `${title.textContent} 메뉴`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = r.imageUrl;

    const actions = document.createElement('div');
    actions.className = 'menu-actions';
    actions.hidden = true;

    const emojiRow = document.createElement('div');
    emojiRow.className = 'emoji-row';

    const commentRow = document.createElement('div');
    commentRow.className = 'comment-row';
    const commentInput = document.createElement('input');
    commentInput.type = 'text';
    commentInput.placeholder = '+한마디';
    const commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.textContent = '+한마디';
    commentRow.appendChild(commentInput);
    commentRow.appendChild(commentBtn);

    actions.appendChild(emojiRow);
    actions.appendChild(commentRow);

    wrap.appendChild(img);
    wrap.appendChild(danmaku);
    wrap.appendChild(actions);
    card.appendChild(title);
    card.appendChild(wrap);
    menusEl.appendChild(card);

    // --- per-card state (shared via Firestore) ---
    // 댓글/이모지 저장·표시는 "항상 오늘(KST)" 기준으로 맞춥니다.
    const dateStr = todayDateKorea();

    const rid = r.id || titleLeft.textContent;
    let state = { emojiCounts: {}, comments: [] };

    // 공유 데이터 경로:
    // menus/current/restaurants/{rid} : emojiCounts 맵
    // menus/current/restaurants/{rid}/comments : 코멘트 스트림
    const restaurantDocRef = doc(db, 'menus', 'current', 'restaurants', rid);
    const commentsColRef = collection(db, 'menus', 'current', 'restaurants', rid, 'comments');

    function renderTitleRight() {
      titleRight.innerHTML = '';
      const entries = Object.entries(state.emojiCounts || {}).filter(([, c]) => (c || 0) > 0);
      if (entries.length === 0) return;

      // 공용 표시: 카운트가 큰 순으로
      entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));

      for (const [e, c] of entries) {
        const count = Number(c) || 0;
        if (count <= 0) continue;
        if (count === 1) {
          const s = document.createElement('span');
          s.textContent = e;
          titleRight.appendChild(s);
        } else {
          const pill = document.createElement('span');
          pill.className = 'emoji-pill';
          const emojiSpan = document.createElement('span');
          emojiSpan.textContent = e;
          const cnt = document.createElement('span');
          cnt.className = 'count';
          cnt.textContent = String(count);
          pill.appendChild(emojiSpan);
          pill.appendChild(cnt);
          titleRight.appendChild(pill);
        }
      }
    }

    function renderEmojiButtons() {
      emojiRow.innerHTML = '';
      for (const e of EMOJIS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'emoji-btn';
        b.textContent = e;
        // 공용 투표라 active 표시는 하지 않음(로그인 없이 개인 상태 추적 불가)
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          // 중복 투표: 클릭할 때마다 +1 (Firestore에 누적)
          // updateDoc은 문서가 없으면 실패하므로 setDoc으로 베이스를 먼저 만들어두고 updateDoc 수행
          setDoc(
            restaurantDocRef,
            { date: dateStr, updatedAt: serverTimestamp() },
            { merge: true },
          )
            .then(() =>
              updateDoc(restaurantDocRef, {
                [`emojiCounts.${e}`]: increment(1),
                updatedAt: serverTimestamp(),
              }),
            )
            .catch((err) => console.error(err));
        });
        emojiRow.appendChild(b);
      }
    }

    function spawnDanmaku(text) {
      const span = document.createElement('span');
      span.textContent = text;
      span.style.color = randomColor();
      span.style.top = `${Math.floor(Math.random() * 70) + 8}%`;
      const duration = Math.floor(Math.random() * 6) + 8; // 8~13s
      span.style.animationDuration = `${duration}s`;
      danmaku.appendChild(span);
      setTimeout(() => {
        span.remove();
      }, (duration + 1) * 1000);
    }

    function startDanmakuLoop() {
      // 코멘트를 계속 흘려보냄. 한 코멘트당 10번까지만 반복(부하 제한).
      const keyPrefix = `${dateStr}:${rid}:`;
      if (!window.__BABB_DANMAKU_SEEN__) window.__BABB_DANMAKU_SEEN__ = {};
      const seen = window.__BABB_DANMAKU_SEEN__;

      const tick = () => {
        if (!state.comments || state.comments.length === 0) return;
        const candidates = state.comments.filter((c) => {
          const k = `${keyPrefix}${c.id}`;
          const used = seen[k] || 0;
          return used < DANMAKU_REPEAT_LIMIT;
        });
        if (candidates.length === 0) return;
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        const k = `${keyPrefix}${pick.id}`;
        seen[k] = (seen[k] || 0) + 1;
        spawnDanmaku(pick.text);
      };

      // 1.6~2.6초 사이 랜덤 인터벌 느낌으로 setInterval + 내부 랜덤 스킵
      setInterval(() => {
        // 화면이 숨겨져 있으면 쉬기
        if (document.hidden) return;
        // 70% 확률로 한 번 흘리기
        if (Math.random() < 0.7) tick();
      }, 1800);
    }

    commentBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const text = commentInput.value.trim();
      if (!text) return;
      // 공유 코멘트 저장
      addDoc(commentsColRef, {
        text,
        createdAt: serverTimestamp(),
        date: dateStr,
      }).catch((err) => console.error(err));
      commentInput.value = '';
      spawnDanmaku(text);
    });
    commentInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        commentBtn.click();
      }
    });

    // 패널 열기: 카드 클릭(타이틀/이미지)로만 열고,
    // 닫기는 "바깥 클릭"에서만 처리
    const openPanel = () => {
      // 다른 카드 닫기
      document.querySelectorAll('.menu-actions').forEach((el) => {
        if (el !== actions) el.hidden = true;
      });
      actions.hidden = false;
      commentInput.focus();
    };
    wrap.addEventListener('click', (ev) => {
      // 열려있을 때 메뉴 영역 클릭으로는 닫히지 않게
      if (actions.hidden) openPanel();
      ev.stopPropagation();
    });
    title.addEventListener('click', (ev) => {
      if (actions.hidden) openPanel();
      ev.stopPropagation();
    });
    actions.addEventListener('click', (ev) => {
      // 패널 내부 클릭은 닫힘 방지
      ev.stopPropagation();
    });

    document.addEventListener('click', () => {
      actions.hidden = true;
    });

    renderEmojiButtons();
    renderTitleRight();

    // 공유 데이터 구독
    onSnapshot(
      restaurantDocRef,
      (snap) => {
        const d = snap.exists() ? snap.data() : {};
        const rowDate = typeof d.date === 'string' ? d.date : '';
        state.emojiCounts = rowDate === dateStr ? d.emojiCounts || {} : {};
        renderTitleRight();
      },
      (err) => console.error(err),
    );

    const commentsQ = query(commentsColRef, orderBy('createdAt', 'desc'), limit(30));
    onSnapshot(
      commentsQ,
      (snap) => {
        state.comments = snap.docs
          .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
          .filter((c) => c.date === dateStr)
          .filter((c) => typeof c.text === 'string' && c.text.length > 0)
          .map((c) => ({ id: c.id, text: c.text }));
      },
      (err) => console.error(err),
    );

    startDanmakuLoop();
  }
}

function showData(data) {
  const dateStr = typeof data.date === 'string' ? data.date : '';
  const updatedStr = formatFirestoreTime(data.updatedAt);

  loadingEl.hidden = true;
  errorEl.hidden = true;

  let toRender = [];
  // 신규 스키마 우선
  if (Array.isArray(data.restaurants) && data.restaurants.length > 0) {
    toRender = data.restaurants.filter(
      (r) => r && typeof r.imageUrl === 'string' && r.imageUrl.length > 0,
    );
  } else if (typeof data.imageUrl === 'string' && data.imageUrl.length > 0) {
    // 구버전(단일 이미지)도 보여주기
    toRender = [{ id: 'menu', name: '오늘의 메뉴', imageUrl: data.imageUrl }];
  } else {
    showError('메뉴 데이터(restaurants/imageUrl)가 없습니다.');
    return;
  }

  renderMenus(toRender);
  showDebug(data, toRender);

  // 카드 렌더링에서 쓸 날짜(리셋/저장 키용)
  window.__BABB_DATE__ = dateStr || '';

  if (dateStr) {
    dateLine.hidden = false;
    dateLine.textContent = `기준일: ${dateStr}`;
  } else {
    dateLine.hidden = true;
  }

  if (updatedStr) {
    updatedLine.hidden = false;
    updatedLine.textContent = `DB 갱신 시각: ${updatedStr}`;
  } else {
    updatedLine.hidden = true;
  }
}

const menuRef = doc(db, 'menus', 'current');

onSnapshot(
  menuRef,
  (snapshot) => {
    if (!snapshot.exists()) {
      showError('아직 등록된 메뉴가 없습니다. 봇이 한 번 실행되면 표시됩니다.');
      return;
    }
    const data = snapshot.data();
    showData(data);
  },
  (err) => {
    console.error(err);
    showError(
      'Firestore에 연결할 수 없습니다. 보안 규칙(읽기 허용)과 네트워크를 확인해 주세요.',
    );
  },
);
