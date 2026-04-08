/**
 * Firestore `menus/current` 문서를 실시간 구독해 메뉴 이미지를 표시합니다.
 * 필드: imageUrl (필수), date (선택), updatedAt (서버 타임스탬프, 선택)
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
const imgEl = document.getElementById('menu-img');
const dateLine = document.getElementById('date-line');
const updatedLine = document.getElementById('updated-line');

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
  imgEl.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
  updatedLine.hidden = true;
}

function showImage(url, data) {
  const dateStr = typeof data.date === 'string' ? data.date : '';
  const updatedStr = formatFirestoreTime(data.updatedAt);

  loadingEl.hidden = true;
  errorEl.hidden = true;
  imgEl.hidden = false;
  imgEl.src = url;
  imgEl.onload = () => {
    imgEl.hidden = false;
  };
  imgEl.onerror = () => {
    showError('이미지를 불러오지 못했습니다. URL을 확인해 주세요.');
  };

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
    const url = data.imageUrl;
    if (!url || typeof url !== 'string') {
      showError('메뉴 이미지 주소(imageUrl)가 없습니다.');
      return;
    }
    showImage(url, data);
  },
  (err) => {
    console.error(err);
    showError(
      'Firestore에 연결할 수 없습니다. 보안 규칙(읽기 허용)과 네트워크를 확인해 주세요.',
    );
  },
);
