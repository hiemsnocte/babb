require('dotenv').config();

const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  doc,
  getDoc,
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

async function deleteOldCommentDocs(colRef, dateStr, pageSize = 300) {
  // Firestore Web SDK는 "where + orderBy + batch recursive delete"가 제한적이라
  // 페이지네이션으로 읽은 뒤 date가 오늘이 아닌 문서만 삭제합니다.
  let deleted = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await getDocs(query(colRef, limit(pageSize)));
    if (snap.empty) return deleted;

    const batch = writeBatch(colRef.firestore);
    let toDelete = 0;
    snap.docs.forEach((d) => {
      const data = d.data() || {};
      if (data.date !== dateStr) {
        batch.delete(d.ref);
        toDelete += 1;
      }
    });
    if (toDelete > 0) {
      await batch.commit();
      deleted += toDelete;
    }

    if (snap.size < pageSize) return deleted;
  }
}

async function resetRestaurantDailyState(db, rid, dateStr) {
  const restaurantDocRef = doc(db, 'menus', 'current', 'restaurants', rid);
  // 날짜가 오늘이 아니면 이모지를 비웁니다. (오늘 데이터는 유지)
  const restaurantSnap = await getDoc(restaurantDocRef);
  const restaurantData = restaurantSnap.exists() ? restaurantSnap.data() : null;
  const restaurantDate = typeof restaurantData?.date === 'string' ? restaurantData.date : '';
  if (!restaurantData || restaurantDate !== dateStr) {
    await setDoc(
      restaurantDocRef,
      {
        date: dateStr,
        emojiCounts: {},
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  const commentsColRef = collection(db, 'menus', 'current', 'restaurants', rid, 'comments');
  return deleteOldCommentDocs(commentsColRef, dateStr);
}

(async () => {
  const firebaseConfig = loadFirebaseConfig();
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  const dateStr = todayDateKorea();
  const restaurantIds = ['beoksan', 'theeats', 'bombom'];
  let deletedComments = 0;

  for (const rid of restaurantIds) {
    // eslint-disable-next-line no-await-in-loop
    deletedComments += await resetRestaurantDailyState(db, rid, dateStr);
  }

  console.log(`[cleanup] KST ${dateStr} 정리 완료 (삭제된 지난 날짜 comments: ${deletedComments})`);
})().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

