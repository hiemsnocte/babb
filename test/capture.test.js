const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  downloadPreviousMenuSnapshot,
  isLikelyImageBytes,
  naverMenuDateTokens,
  scoreNaverMenuCandidate,
} = require('../capture');

const fixedNow = new Date('2026-08-05T03:00:00.000Z');
const todayTokens = naverMenuDateTokens(fixedNow);

function candidate(overrides = {}) {
  return {
    alt: '',
    ariaLabel: '',
    text: '',
    natural: [560, 747],
    rect: [210, 210],
    src: 'https://search.pstatic.net/common/?src=https%3A%2F%2Fldb-phinf.pstatic.net%2Fmenu.jpg',
    clickable: true,
    inPlaceThumb: true,
    ...overrides,
  };
}

test('KST 기준 오늘 날짜 토큰을 만든다', () => {
  assert.ok(todayTokens.includes('8월 5일'));
  assert.ok(todayTokens.includes('08.05'));
  assert.ok(todayTokens.includes('2026-08-05'));
});

test('정사각형으로 리사이즈되어도 오늘 메뉴 카드면 높은 점수를 준다', () => {
  const result = scoreNaverMenuCandidate(
    candidate({ text: '8월 5일 오늘의 메뉴 특식 안내' }),
    todayTokens,
  );
  assert.ok(result.score >= 200, JSON.stringify(result));
  assert.ok(result.reasons.includes('menu-text'));
  assert.ok(result.reasons.some((reason) => reason.startsWith('today:')));
});

test('기존에 알려진 업체 메뉴 썸네일 규격도 계속 허용한다', () => {
  const result = scoreNaverMenuCandidate(
    candidate({ natural: [240, 300], rect: [240, 300] }),
    todayTokens,
  );
  assert.ok(result.score >= 70, JSON.stringify(result));
  assert.ok(result.reasons.includes('known-size'));
});

test('날짜만 같은 방문자 리뷰 이미지는 메뉴로 선택하지 않는다', () => {
  const result = scoreNaverMenuCandidate(
    candidate({
      text: '8월 5일 방문 후기',
      src: 'https://search.pstatic.net/common/?src=https%3A%2F%2Fpup-review-phinf.pstatic.net%2Freview.jpg',
    }),
    todayTokens,
  );
  assert.ok(result.score < 70, JSON.stringify(result));
  assert.ok(result.reasons.includes('visitor-image'));
});

test('CAPTCHA 이미지는 다른 신호와 무관하게 거부한다', () => {
  const result = scoreNaverMenuCandidate(
    candidate({ alt: '캡차이미지', text: '8월 5일 오늘의 메뉴' }),
    todayTokens,
  );
  assert.equal(result.score, -1000);
  assert.deepEqual(result.reasons, ['captcha']);
});

test('이미지 URL이 HTML 차단 페이지를 반환하면 이미지로 인정하지 않는다', () => {
  assert.equal(isLikelyImageBytes(Buffer.from('<html>Too Many Requests</html>')), false);

  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.equal(isLikelyImageBytes(png), true);
});

test('새 캡처 실패 시 검증된 직전 메뉴 이미지를 별도 파일로 보존한다', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babb-preserve-'));
  const imageBytes = Buffer.alloc(600);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
  const requestedUrls = [];
  const fakeFetch = async (url) => {
    requestedUrls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => imageBytes,
    };
  };

  try {
    const result = await downloadPreviousMenuSnapshot(
      { id: 'bombom', name: '봄봄', imageFileName: 'menu_bombom.png' },
      tempDir,
      fakeFetch,
    );
    assert.equal(result.stale, true);
    assert.equal(path.basename(result.localPath), '.previous-menu_bombom.png');
    assert.equal((await fs.readFile(result.localPath)).length, imageBytes.length);
    assert.match(requestedUrls[0], /\/menus\/menu_bombom\.png\?preserve=/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
