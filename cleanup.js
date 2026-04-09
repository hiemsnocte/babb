require('dotenv').config();

const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  writeBatch,
} = require('firebase/firestore');

function loadFirebaseConfig() {
  const keys = [
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_STORAGE_BUCKET',
    'FIREBASE_MESSAGING_SENDER_ID',
    'FIREBASE_APP_ID',
    'FIREBASE_MEASUREMENT_ID',
  ];
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`.env에 다음 변수가 필요합니다: ${missing.join(', ')}`);
  }
  return {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID,
  };
}

function todayDateKorea() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function deleteAllDocsInCollection(colRef, pageSize = 300) {
  // Firestore Web SDK는 "recursive delete"가 없어서, 페이지네이션으로 전부 지웁니다.
  // 코멘트 수가 많지 않다는 가정(최대 30개만 UI에서 보여줌) 하에 충분합니다.
  // 그래도 안전하게 반복합니다.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await getDocs(query(colRef, limit(pageSize)));
    if (snap.empty) return 0;

    const batch = writeBatch(colRef.firestore);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    if (snap.size < pageSize) return snap.size;
  }
}

async function resetRestaurantDailyState(db, rid, dateStr) {
  const restaurantDocRef = doc(db, 'menus', 'current', 'restaurants', rid);
  // emojiCounts를 비우고 날짜만 오늘로 갱신
  await setDoc(
    restaurantDocRef,
    {
      date: dateStr,
      emojiCounts: {},
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  const commentsColRef = collection(db, 'menus', 'current', 'restaurants', rid, 'comments');
  await deleteAllDocsInCollection(commentsColRef);
}

(async () => {
  const firebaseConfig = loadFirebaseConfig();
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  const dateStr = todayDateKorea();
  const restaurantIds = ['beoksan', 'theeats', 'bombom'];

  for (const rid of restaurantIds) {
    // eslint-disable-next-line no-await-in-loop
    await resetRestaurantDailyState(db, rid, dateStr);
  }

  console.log(`[cleanup] KST ${dateStr} 자정 리셋 완료 (emojiCounts/comments)`);
})().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

