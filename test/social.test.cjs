const test = require('node:test');
const assert = require('node:assert/strict');
const core = import('../public/social-core.mjs');

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
}

test('original emojis reset on the Korean date boundary without yesterday counts', async () => {
  const { EMOJIS, nextVote, todayKorea } = await core;
  assert.deepEqual(EMOJIS, ['😍', '😋', '🤔', '😑', '😒', '😡', '🤬']);
  assert.equal(todayKorea(new Date('2026-10-10T15:00:00Z')), '2026-10-11');
  assert.deepEqual(nextVote({ date: '2026-10-10', emojiCounts: { '😍': 30, '🤔': 50 } }, '2026-10-11', '😋'), { '😋': 1 });
  assert.deepEqual(nextVote({ date: '2026-10-11', emojiCounts: { '😍': 30, '🤔': 50 } }, '2026-10-11', '😍'), { '😍': 31, '🤔': 50 });
});

test('successful counts load reads once even when cards reopen after a minute', async () => {
  const { createSocialClient } = await core;
  let time = 100_000;
  let imports = 0;
  let reads = 0;
  const client = createSocialClient({
    restaurantId: 'bombom', storage: memoryStorage(), getToday: () => '2026-10-11', now: () => time,
    loadBackend: async () => {
      imports += 1;
      return { read: async () => {
        reads += 1;
        return { restaurant: { date: '2026-10-11', emojiCounts: { '😍': 2 } } };
      } };
    },
  });
  assert.equal(imports, 0);
  await Promise.all([client.load(), client.load()]);
  assert.equal(reads, 1);
  assert.deepEqual(client.snapshot().counts, { '😍': 2 });
  time += 60_000;
  await client.load();
  assert.equal(reads, 1);
  assert.equal(imports, 1);
});

test('failed initial reads retry at most once a minute', async () => {
  const { createSocialClient } = await core;
  let time = 100_000;
  let reads = 0;
  const client = createSocialClient({
    restaurantId: 'bombom', now: () => time,
    loadBackend: async () => ({ read: async () => {
      reads += 1;
      if (reads === 1) throw new Error('offline');
      return { restaurant: {} };
    } }),
  });
  await assert.rejects(client.load(), /offline/);
  await client.load();
  assert.equal(reads, 1);
  time += 60_000;
  await client.load();
  assert.equal(reads, 2);
});

test('live comment subscription is unique, bounded and cleaned up before resume', async () => {
  const { createSocialClient } = await core;
  let starts = 0;
  let stops = 0;
  let receive;
  let observed;
  const client = createSocialClient({
    restaurantId: 'bombom', getToday: () => '2026-10-11',
    loadBackend: async () => ({ subscribeComments: (id, next) => {
      starts += 1;
      receive = next;
      return () => { stops += 1; };
    } }),
  });
  const observe = (state) => { observed = state; };
  await Promise.all([client.startComments(observe), client.startComments(observe)]);
  assert.equal(starts, 1);
  receive([{ date: '2026-10-10', text: 'old' }, ...Array.from({ length: 20 }, (_, i) => ({ date: '2026-10-11', text: 'message ' + i }))]);
  assert.equal(observed.comments.length, 10);
  assert.equal(observed.comments[0].text, 'message 0');
  receive([{ date: '2026-10-11', text: '<b>new message</b>' }]);
  assert.equal(observed.comments[0].text, '<b>new message</b>');
  const oldReceive = receive;
  client.stopComments();
  client.stopComments();
  assert.equal(stops, 1);
  oldReceive([{ date: '2026-10-11', text: 'stale callback' }]);
  assert.equal(observed.comments[0].text, '<b>new message</b>');
  await client.startComments(observe);
  assert.equal(starts, 2);
  client.stopComments();
  assert.equal(stops, 2);
});

test('unmount during SDK loading cannot leave a late comment listener behind', async () => {
  const { createSocialClient } = await core;
  let finish;
  let starts = 0;
  const client = createSocialClient({
    restaurantId: 'bombom',
    loadBackend: () => new Promise((resolve) => { finish = resolve; }),
  });
  const pending = client.startComments(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  client.stopComments();
  finish({ subscribeComments: () => { starts += 1; return () => {}; } });
  await pending;
  assert.equal(starts, 0);
  await client.startComments(() => {});
  assert.equal(starts, 1);
  client.stopComments();
});

test('listener errors release the listener and retry no faster than once a minute', async () => {
  const { createSocialClient } = await core;
  let time = 100_000;
  let starts = 0;
  let stops = 0;
  let fail;
  const client = createSocialClient({
    restaurantId: 'bombom', now: () => time,
    loadBackend: async () => ({ subscribeComments: (id, next, error) => {
      starts += 1; fail = error; return () => { stops += 1; };
    } }),
  });
  await client.startComments(() => {});
  fail(new Error('offline'));
  assert.equal(stops, 1);
  await client.startComments(() => {});
  assert.equal(starts, 1);
  time += 60_000;
  await client.startComments(() => {});
  assert.equal(starts, 2);
  client.stopComments();
});

test('failed votes can retry; successful repeated votes use a short persisted cooldown', async () => {
  const { createSocialClient } = await core;
  let day = '2026-10-11';
  let time = 100_000;
  let attempts = 0;
  const storage = memoryStorage();
  const calls = [];
  const options = {
    restaurantId: 'bombom', storage, getToday: () => day, now: () => time,
    loadBackend: async () => ({ vote: async (id, date, emoji) => {
      calls.push({ id, date, emoji });
      if (++attempts === 1) throw new Error('temporary failure');
      return { [emoji]: 1 };
    } }),
  };
  const client = createSocialClient(options);
  await assert.rejects(client.vote('😍'), /temporary failure/);
  assert.equal(client.snapshot().busy, false);
  assert.equal(client.snapshot().voteWaitMs, 0);
  await client.vote('😍');
  assert.equal(client.snapshot().voteWaitMs, 3000);
  await assert.rejects(createSocialClient(options).vote('🤔'), /3초/);
  assert.equal(attempts, 2);
  time += 3000;
  await client.vote('🤔');
  assert.equal(attempts, 3);
  day = '2026-10-12';
  assert.deepEqual(client.snapshot().counts, {});
  await client.vote('😋');
  assert.equal(calls[3].date, day);
});

test('vote in flight blocks duplicate submissions and releases the lock on completion', async () => {
  const { createSocialClient } = await core;
  let finish;
  let writes = 0;
  const client = createSocialClient({
    restaurantId: 'bombom', storage: memoryStorage(), getToday: () => '2026-10-11',
    loadBackend: async () => ({ vote: async () => {
      writes += 1;
      return new Promise((resolve) => { finish = resolve; });
    } }),
  });
  const pending = client.vote('😍');
  await assert.rejects(client.vote('😍'), /처리 중/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  finish({ '😍': 1 });
  await pending;
  assert.equal(client.snapshot().busy, false);
});

test('slow initial count read cannot undo a completed vote', async () => {
  const { createSocialClient } = await core;
  let finish;
  const client = createSocialClient({
    restaurantId: 'bombom', getToday: () => '2026-10-11',
    loadBackend: async () => ({
      read: () => new Promise((resolve) => { finish = resolve; }),
      vote: async () => ({ '😍': 2 }),
    }),
  });
  const pending = client.load();
  await new Promise((resolve) => setImmediate(resolve));
  await client.vote('😍');
  finish({ restaurant: { date: '2026-10-11', emojiCounts: { '😍': 1 } } });
  await pending;
  assert.deepEqual(client.snapshot().counts, { '😍': 2 });
});

test('marquee gives messages and vote totals a fair turn even with ten messages', async () => {
  const { createMarqueeRotation } = await core;
  const rotation = createMarqueeRotation();
  const state = {
    counts: { '😍': 4, '😋': 2, '🤔': 0, unknown: 10 },
    comments: Array.from({ length: 10 }, (_, i) => ({ text: 'message ' + i })),
  };
  const entries = Array.from({ length: 20 }, () => rotation.next(state));
  assert.deepEqual(entries.map((item) => item.kind), Array.from({ length: 10 }, () => ['vote', 'message']).flat());
  assert.deepEqual(entries.filter((item) => item.kind === 'message').map((item) => item.text), state.comments.map((item) => item.text));
  assert.deepEqual(entries.filter((item) => item.kind === 'vote').slice(0, 2).map(({ emoji, count }) => ({ emoji, count })), [{ emoji: '😍', count: 4 }, { emoji: '😋', count: 2 }]);
  assert.ok(entries.filter((item) => item.kind === 'vote').every((item) => !item.text));
});

test('marquee avoids active duplicates and uses current vote totals without fetching', async () => {
  const { createMarqueeRotation } = await core;
  const rotation = createMarqueeRotation();
  const state = { counts: { '😍': 4 }, comments: [{ text: 'hello' }, { text: 'hello' }] };
  const vote = rotation.next(state);
  const message = rotation.next(state, [vote.key]);
  assert.equal(message.text, 'hello');
  assert.equal(rotation.next(state, [vote.key, message.key]), null);
  state.counts['😍'] = 5;
  assert.equal(rotation.next(state, [message.key]).count, 5);
  assert.equal(rotation.next({ counts: {}, comments: [] }), null);
});

test('emoji trains represent every vote with a bounded sliding car pool', async () => {
  const { createEmojiTrain, MAX_TRAIN_CARS } = await core;
  const small = createEmojiTrain(3, 300, { priority: true, speed: 50 });
  assert.equal(small.poolSize, 3);
  assert.equal(small.frame(0).visibleCount, 3);
  assert.equal(small.frame(0).firstIndex, 0);
  assert.ok(small.frame(0).offsetX >= 0);
  assert.equal(small.frame(10_000).done, true);

  const long = createEmojiTrain(1000, 300, { speed: 50 });
  const visited = new Set();
  for (let time = 0; time < 660_000; time += 100) {
    const state = long.frame(time);
    assert.ok(state.visibleCount <= long.poolSize);
    for (let i = 0; i < state.visibleCount; i += 1) visited.add(state.firstIndex + i);
  }
  assert.equal(visited.size, 1000);
  assert.equal(Math.max(...visited), 999);
  assert.equal(long.frame(660_000).done, true);

  const huge = createEmojiTrain(Number.MAX_SAFE_INTEGER, 10_000, { speed: 50 });
  assert.ok(huge.poolSize <= MAX_TRAIN_CARS);
  const advanced = huge.frame(1_000_000_000);
  assert.ok(advanced.firstIndex > 100_000);
  assert.ok(advanced.visibleCount <= MAX_TRAIN_CARS);
  assert.equal(advanced.done, false);
  assert.ok(Math.abs(advanced.offsetX) < huge.pitch * 2);
  for (const count of [0, -1, Infinity, 1.5]) assert.throws(() => createEmojiTrain(count, 300));
});

test('messages validate locally, recover after failure, and do not fetch after writes', async () => {
  const { createSocialClient } = await core;
  let time = 100_000;
  let imports = 0;
  let attempts = 0;
  let fail = true;
  const storage = memoryStorage();
  const options = {
    restaurantId: 'bombom', storage, getToday: () => '2026-10-11', now: () => time,
    loadBackend: async () => {
      imports += 1;
      return {
        read: () => { throw new Error('unexpected read'); },
        sendMessage: async (id, day, text) => {
          attempts += 1;
          assert.equal(text, 'hello');
          if (fail) throw new Error('temporary failure');
          return { id: 'message-' + attempts };
        },
      };
    },
  };
  const client = createSocialClient(options);
  await assert.rejects(client.sendMessage(' '), /메시지를 적어/);
  await assert.rejects(client.sendMessage('x'.repeat(121)), /120자/);
  assert.equal(imports, 0);
  await assert.rejects(client.sendMessage(' hello '), /temporary failure/);
  assert.equal(client.snapshot().busy, false);
  assert.equal(client.snapshot().messageWaitMs, 0);
  fail = false;
  const result = await client.sendMessage(' hello ');
  assert.equal(result.comments[0].text, 'hello');
  await assert.rejects(createSocialClient(options).sendMessage('hello'), /30초/);
  time += 30_000;
  await client.sendMessage('hello');
  assert.equal(attempts, 3);
});

test('storage restrictions retain in-memory cooldown without a daily vote cap', async () => {
  const { createSocialClient } = await core;
  let time = 0;
  const client = createSocialClient({
    restaurantId: 'bombom', getToday: () => '2026-10-11', now: () => time,
    storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
    loadBackend: async () => ({ vote: async () => ({ '😍': 1 }) }),
  });
  await client.vote('😍');
  assert.equal(client.snapshot().voteWaitMs, 3000);
  await assert.rejects(client.vote('🤔'), /3초/);
  time += 3000;
  await client.vote('🤔');
});
