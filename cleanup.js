require('dotenv').config();

const { initializeApp } = require('firebase/app');
const firestoreApi = require('firebase/firestore');
const { getFirestore } = firestoreApi;

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

async function deleteOldCommentDocs(colRef, dateStr, pageSize = 300, api = firestoreApi) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error('Comment cleanup page size must be between 1 and 500');
  }
  let deleted = 0;
  let cursor = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Advance past every examined document, including today's retained messages.
    // A snapshot cursor remains usable even when that document is deleted below.
    const constraints = [api.orderBy(api.documentId()), api.limit(pageSize)];
    if (cursor) constraints.push(api.startAfter(cursor));
    const snap = await api.getDocs(api.query(colRef, ...constraints));
    if (snap.empty) return deleted;
    cursor = snap.docs[snap.docs.length - 1];

    const batch = api.writeBatch(colRef.firestore);
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

async function resetRestaurantDailyState(db, rid, dateStr, api = firestoreApi) {
  const restaurantDocRef = api.doc(db, 'menus', 'current', 'restaurants', rid);
  // If a first vote arrives concurrently, Firestore retries this date check using
  // the updated document rather than overwriting today's newly recorded vote.
  await api.runTransaction(db, async (transaction) => {
    const restaurantSnap = await transaction.get(restaurantDocRef);
    const restaurantData = restaurantSnap.exists() ? restaurantSnap.data() : null;
    if (restaurantData?.date === dateStr) return;
    transaction.set(restaurantDocRef, {
      date: dateStr,
      emojiCounts: {},
      liveEmojiCounts: {},
      sacrificedEmojiCounts: {},
      destroyedEmojiCounts: {},
      emojiCrownMerge: {},
      updatedAt: api.serverTimestamp(),
    }, { merge: true });
  });

  const commentsColRef = api.collection(db, 'menus', 'current', 'restaurants', rid, 'comments');
  return deleteOldCommentDocs(commentsColRef, dateStr, 300, api);
}

async function main() {
  const firebaseConfig = loadFirebaseConfig();
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  const dateStr = todayDateKorea();
  const { validateCatalog } = require('./scripts/prepare-site.cjs');
  const restaurantIds = validateCatalog(require('./public/restaurants.json')).map((restaurant) => restaurant.id);
  let deletedComments = 0;

  for (const rid of restaurantIds) {
    // eslint-disable-next-line no-await-in-loop
    deletedComments += await resetRestaurantDailyState(db, rid, dateStr);
  }

  console.log(`[cleanup] KST ${dateStr} 정리 완료 (삭제된 지난 날짜 comments: ${deletedComments})`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}

module.exports = { deleteOldCommentDocs, resetRestaurantDailyState, todayDateKorea };
