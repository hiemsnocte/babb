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
  doc,
  onSnapshot,
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
}

function renderMenus(restaurants) {
  menusEl.innerHTML = '';
  for (const r of restaurants) {
    const card = document.createElement('section');
    card.className = 'menu-card';

    const title = document.createElement('h2');
    title.className = 'menu-title';
    title.textContent = r.name || r.id || '메뉴';

    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';

    const img = document.createElement('img');
    img.alt = `${title.textContent} 메뉴`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = r.imageUrl;

    wrap.appendChild(img);
    card.appendChild(title);
    card.appendChild(wrap);
    menusEl.appendChild(card);
  }
}

function showData(data) {
  const dateStr = typeof data.date === 'string' ? data.date : '';
  const updatedStr = formatFirestoreTime(data.updatedAt);

  loadingEl.hidden = true;
  errorEl.hidden = true;

  // 신규 스키마 우선
  if (Array.isArray(data.restaurants) && data.restaurants.length > 0) {
    renderMenus(
      data.restaurants.filter(
        (r) => r && typeof r.imageUrl === 'string' && r.imageUrl.length > 0,
      ),
    );
  } else if (typeof data.imageUrl === 'string' && data.imageUrl.length > 0) {
    // 구버전(단일 이미지)도 보여주기
    renderMenus([{ id: 'menu', name: '오늘의 메뉴', imageUrl: data.imageUrl }]);
  } else {
    showError('메뉴 데이터(restaurants/imageUrl)가 없습니다.');
    return;
  }

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
