const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteOldCommentDocs, resetRestaurantDailyState } = require('../cleanup.js');

const TODAY = '2026-10-10';
const YESTERDAY = '2026-10-09';

function commentApi(entries = []) {
  const stored = new Map(entries.map((entry) => [entry.id, entry]));
  const queries = [];
  const commits = [];
  const api = {
    documentId: () => '__name__',
    orderBy: (field) => ({ order: field }),
    limit: (size) => ({ limit: size }),
    startAfter: (snapshot) => ({ after: snapshot.id }),
    query: (ref, ...constraints) => ({ ref, ...Object.assign({}, ...constraints) }),
    getDocs: async (query) => {
      queries.push(query);
      if (queries.length > 10) throw new Error('Cleanup did not advance to the next page');
      assert.equal(query.order, '__name__');
      const docs = [...stored.values()].sort((a, b) => a.id.localeCompare(b.id))
        .filter((entry) => !query.after || entry.id > query.after)
        .slice(0, query.limit)
        .map((entry) => ({ id: entry.id, ref: { id: entry.id }, data: () => ({ ...entry }) }));
      return { docs, empty: !docs.length, size: docs.length };
    },
    writeBatch: () => {
      const deleting = [];
      return {
        delete: (ref) => deleting.push(ref.id),
        commit: async () => {
          commits.push(deleting);
          deleting.forEach((id) => stored.delete(id));
        },
      };
    },
  };
  return { api, stored, queries, commits };
}

test('cleanup advances past 650 current-day messages to delete old messages on later pages', async () => {
  const current = Array.from({ length: 650 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}`, date: TODAY }));
  const old = Array.from({ length: 25 }, (_, i) => ({ id: `z${String(i).padStart(4, '0')}`, date: YESTERDAY }));
  const fixture = commentApi([...current, ...old]);
  const deleted = await deleteOldCommentDocs({ firestore: {} }, TODAY, 300, fixture.api);
  assert.equal(deleted, 25);
  assert.equal(fixture.queries.length, 3);
  assert.deepEqual(fixture.queries.map((query) => query.after), [undefined, 'a0299', 'a0599']);
  assert.equal(fixture.stored.size, 650);
  assert.ok([...fixture.stored.values()].every((entry) => entry.date === TODAY));
});

test('deleted page-boundary documents do not cause skipping or rereading retained messages', async () => {
  const fixture = commentApi([
    { id: 'a', date: YESTERDAY }, { id: 'b', date: TODAY }, { id: 'c', date: YESTERDAY },
    { id: 'd', date: TODAY }, { id: 'e', date: YESTERDAY }, { id: 'f', date: YESTERDAY },
    { id: 'g', date: YESTERDAY },
  ]);
  assert.equal(await deleteOldCommentDocs({ firestore: {} }, TODAY, 3, fixture.api), 5);
  assert.deepEqual([...fixture.stored.keys()], ['b', 'd']);
  assert.deepEqual(fixture.queries.map((query) => query.after), [undefined, 'c', 'f']);
  assert.ok(fixture.commits.every((batch) => batch.length <= 3));
});

function stateApi(initial, concurrentVote) {
  const fixture = commentApi();
  let state = initial;
  let attempts = 0;
  const committed = [];
  const api = {
    ...fixture.api,
    doc: (db, ...segments) => ({ path: segments.join('/') }),
    collection: (db) => ({ firestore: db }),
    serverTimestamp: () => 'server-time',
    runTransaction: async (db, operation) => {
      for (;;) {
        attempts += 1;
        const observed = state;
        const pending = [];
        await operation({
          get: async () => ({ exists: () => observed !== null, data: () => observed }),
          set: (ref, data, options) => pending.push({ ref, data, options }),
        });
        if (attempts === 1 && concurrentVote) {
          // Firestore discards the first attempt's writes and retries when another
          // transaction changes a document that this transaction has read.
          state = concurrentVote;
          continue;
        }
        for (const write of pending) {
          assert.deepEqual(write.options, { merge: true });
          committed.push(write);
          state = { ...state, ...write.data };
        }
        return;
      }
    },
  };
  return { api, state: () => state, attempts: () => attempts, committed };
}

test('daily reset skips today and clears previous-day game fields while retaining unrelated fields', async () => {
  const today = stateApi({ date: TODAY, emojiCounts: { '👍': 10 }, unrelated: true });
  await resetRestaurantDailyState({}, 'bombom', TODAY, today.api);
  assert.equal(today.committed.length, 0);
  assert.deepEqual(today.state().emojiCounts, { '👍': 10 });
  const old = stateApi({ date: YESTERDAY, emojiCounts: { '👍': 30 }, liveEmojiCounts: { '👍': 3 }, unrelated: true });
  await resetRestaurantDailyState({}, 'bombom', TODAY, old.api);
  assert.equal(old.committed.length, 1);
  assert.equal(old.state().date, TODAY);
  assert.equal(old.state().unrelated, true);
  for (const field of ['emojiCounts', 'liveEmojiCounts', 'sacrificedEmojiCounts', 'destroyedEmojiCounts', 'emojiCrownMerge']) assert.deepEqual(old.state()[field], {});
});

test('a concurrent first vote survives the transaction retry and is never reset', async () => {
  const firstVote = { date: TODAY, emojiCounts: { '❤️': 1 }, unrelated: true };
  const fixture = stateApi({ date: YESTERDAY, emojiCounts: { '👍': 100 } }, firstVote);
  await resetRestaurantDailyState({}, 'bombom', TODAY, fixture.api);
  assert.equal(fixture.attempts(), 2);
  assert.equal(fixture.committed.length, 0);
  assert.deepEqual(fixture.state(), firstVote);
});
