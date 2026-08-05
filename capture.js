require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const simpleGit = require('simple-git');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, serverTimestamp } = require('firebase/firestore');

/** GitHub: hiemsnocte/babb — 코드(main)와 이미지(menus)를 분리 */
const GITHUB_OWNER = 'hiemsnocte';
const GITHUB_REPO = 'babb';
// 코드/Pages는 main, 메뉴 이미지는 menus 브랜치에 강제 푸시(히스토리 1커밋 유지)
const GITHUB_CODE_BRANCH = 'main';
const GITHUB_MENUS_BRANCH = 'menus';
const FIRESTORE_MENU_DOC_ID = 'current';

// 식당은 고정 순서: 벽산더이룸 → 더이츠푸드 → 봄봄
const RESTAURANTS = [
  {
    id: 'beoksan',
    name: '벽산더이룸',
    profileUrl: 'http://pf.kakao.com/_xdLzxgG',
    imageFileName: 'menu_beoksan.png',
    type: 'kakao',
  },
  {
    id: 'theeats',
    name: '더이츠푸드',
    profileUrl: 'https://pf.kakao.com/_xeVwxnn',
    imageFileName: 'menu_theeats.png',
    type: 'kakao',
  },
  {
    id: 'bombom',
    name: '봄봄',
    profileUrl:
      'https://map.naver.com/p/search/%EA%B5%AC%EB%94%94%20%EB%B4%84%EB%B4%84/place/2096511528?placePath=?abtExp=NEW-PLACE-SEARCH%3A1&bk_query=%EA%B5%AC%EB%94%94%20%EB%B4%84%EB%B4%84&entry=pll&from=nx&fromNxList=true&searchType=place&c=15.00,0,0,0,dh',
    imageFileName: 'menu_bombom.png',
    type: 'naverMap',
  },
];

function rawGithubFileUrl(fileName) {
  return `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_MENUS_BRANCH}/${fileName}`;
}

/** 캐시 버스팅: https://.../file.png?t=[현재시간(ms)] */
function withCacheBust(url) {
  return `${url}?t=${new Date().getTime()}`;
}

async function captureKakaoProfileMenu(page, url, imageFileName) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('div.item_profile_head button.btn_thumb', {
    timeout: 60000,
  });
  await page.click('div.item_profile_head button.btn_thumb');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  // 전체 화면(fullPage) 캡처는 모달 주변 여백까지 포함되어 "작게" 보일 수 있어
  // 가장 크게 보이는 이미지 요소만 잘라 저장합니다(실패 시 fullPage 폴백).
  const saved = await screenshotLargestVisibleImage(page, imageFileName);
  if (!saved) {
    await page.screenshot({ path: imageFileName, fullPage: true });
  }
}

function pickFrameByUrl(page, predicate) {
  return page.frames().find((f) => {
    try {
      return predicate(f.url());
    } catch {
      return false;
    }
  });
}

async function waitForFrame(page, predicate, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = pickFrameByUrl(page, predicate);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('네이버 지도 프레임(entryIframe)을 찾지 못했습니다.');
}

/** 메뉴 모달 등에서 “가장 크게 보이는 img”만 골라 원본 바이트 저장(PC에서 이미지 복사와 유사) */
const MIN_IMAGE_AREA_FOR_URL_DOWNLOAD = 120 * 120;

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** search.pstatic.net/common/?src=… 형태면 실제 원본(ldb-phinf 등)을 먼저 시도합니다. */
function variantsForNaverImageUrl(url) {
  try {
    const u = new URL(url);
    const inner = u.searchParams.get('src');
    if (inner) {
      const decoded = decodeURIComponent(inner);
      if (/^https?:\/\//i.test(decoded) && decoded !== url) return [decoded, url];
    }
  } catch {
    /* ignore */
  }
  return [url];
}

function isLikelyImageBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const ascii = (start, end) => buf.subarray(start, end).toString('ascii');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng =
    buf[0] === 0x89 &&
    ascii(1, 4) === 'PNG' &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a;
  const isGif = ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  const isWebp = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  const isIsoImage = ascii(4, 8) === 'ftyp' && /avif|avis|heic|heix|mif1/.test(ascii(8, 24));
  return isJpeg || isPng || isGif || isWebp || isIsoImage;
}

/**
 * 브라우저 fetch는 CORS로 막히는 경우가 많아, Node에서 Referer를 붙여 받습니다.
 */
async function downloadImageBytesFromNode(url) {
  const referers = [
    'https://map.naver.com/',
    'https://map.naver.com/p/',
    'https://search.pstatic.net/',
  ];
  const variants = variantsForNaverImageUrl(url);

  for (const imageUrl of variants) {
    for (const referer of referers) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(imageUrl, {
          redirect: 'follow',
          headers: {
            Referer: referer,
            'User-Agent': CHROME_UA,
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
        });
        if (!res.ok) continue;
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (!contentType.startsWith('image/')) continue;
        // eslint-disable-next-line no-await-in-loop
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length >= 500 && isLikelyImageBytes(buf)) return buf;
      } catch {
        /* 다음 Referer / URL */
      }
    }
  }
  return null;
}

async function downloadPreviousMenuSnapshot(restaurant, outputDir, fetchImpl = fetch) {
  const previousUrl = `${rawGithubFileUrl(restaurant.imageFileName)}?preserve=${Date.now()}`;
  const response = await fetchImpl(previousUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Cache-Control': 'no-cache',
    },
  });
  if (!response.ok) {
    throw new Error(`기존 메뉴 이미지 HTTP ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`기존 메뉴 응답이 이미지가 아닙니다: ${contentType || 'unknown'}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 500 || !isLikelyImageBytes(bytes)) {
    throw new Error(`기존 메뉴 이미지 형식 검증 실패: ${bytes.length} bytes`);
  }

  const previousPath = path.join(outputDir, `.previous-${restaurant.imageFileName}`);
  await fs.writeFile(previousPath, bytes);
  return { ...restaurant, localPath: previousPath, stale: true };
}

async function tryFetchLargestVisibleImageAcrossFrames(page, outPath) {
  const candidates = [];
  for (const f of page.frames()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const pick = await f.evaluate(() => {
        function isVisible(el) {
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          )
            return false;
          const r = el.getBoundingClientRect();
          return r.width > 10 && r.height > 10;
        }

        const hasZoomControls = !!document.querySelector('div.btn_zoom');
        const found = [];
        for (const img of document.querySelectorAll('img')) {
          if (!(img instanceof HTMLImageElement)) continue;
          if (!isVisible(img)) continue;
          const url = (img.currentSrc || img.getAttribute('src') || '').trim();
          if (!url || url.startsWith('data:')) continue;
          if (!/^https?:\/\//i.test(url) && !url.startsWith('blob:')) continue;
          const r = img.getBoundingClientRect();
          const area = r.width * r.height;
          const inViewer = !!img.closest(
            '[role="dialog"], [class*="viewer"], [class*="Viewer"], [class*="zoom"], [class*="Zoom"]',
          );
          found.push({
            url,
            area: Math.round(area),
            naturalArea: (img.naturalWidth || 0) * (img.naturalHeight || 0),
            inViewer,
            hasZoomControls,
          });
        }
        return found;
      });
      if (Array.isArray(pick)) {
        for (const candidate of pick) {
          if (candidate?.url) candidates.push({ frame: f, ...candidate });
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (candidates.length === 0) {
    console.log('[봄봄] 이미지 URL 다운로드: 후보 img 없음');
    return false;
  }

  candidates.sort((a, b) => {
    const priority = (candidate) =>
      (candidate.hasZoomControls ? 1_000_000_000 : 0) +
      (candidate.inViewer ? 100_000_000 : 0) +
      candidate.area +
      Math.min(candidate.naturalArea || 0, 10_000_000) / 100;
    return priority(b) - priority(a);
  });
  const best = candidates[0];
  if (best.area < MIN_IMAGE_AREA_FOR_URL_DOWNLOAD) {
    console.log(
      `[봄봄] 이미지 URL 다운로드: 최대 면적이 작아 스킵 (area=${best.area} < ${MIN_IMAGE_AREA_FOR_URL_DOWNLOAD})`,
    );
    return false;
  }

  const { url: imageUrl, frame } = best;

  try {
    let bytes = null;

    if (imageUrl.startsWith('blob:')) {
      try {
        const byteList = await frame.evaluate(async (u) => {
          const res = await fetch(u);
          if (!res.ok) throw new Error(`http ${res.status}`);
          const ab = await res.arrayBuffer();
          return Array.from(new Uint8Array(ab));
        }, imageUrl);
        if (byteList && byteList.length >= 500) {
          const candidateBytes = Buffer.from(byteList);
          if (isLikelyImageBytes(candidateBytes)) bytes = candidateBytes;
        }
      } catch (e) {
        console.warn('[봄봄] blob URL fetch(프레임 내) 실패:', String(e?.message || e));
      }
    } else {
      bytes = await downloadImageBytesFromNode(imageUrl);
    }

    if (!bytes) {
      console.warn('[봄봄] 이미지 바이트 수신 실패 → fullPage 스크린샷 폴백');
      return false;
    }

    await fs.writeFile(outPath, bytes);
    const preview =
      imageUrl.length > 120 ? `${imageUrl.slice(0, 120)}…` : imageUrl;
    console.log(`[봄봄] 메인 이미지 저장 OK (Node fetch, area=${best.area}, ${preview})`);
    return true;
  } catch (e) {
    console.warn('[봄봄] 이미지 저장 중 오류 → fullPage 스크린샷 폴백:', String(e?.message || e));
    return false;
  }
}

function naverMenuDateTokens(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return [
    `${month}월 ${day}일`,
    `${month}월${day}일`,
    `${month}.${day}`,
    `${month}/${day}`,
    `${mm}.${dd}`,
    `${mm}/${dd}`,
    `${year}-${mm}-${dd}`,
    `${year}.${mm}.${dd}`,
  ];
}

function scoreNaverMenuCandidate(candidate, dateTokens = naverMenuDateTokens()) {
  const reasons = [];
  let score = 0;
  const text = `${candidate.alt || ''} ${candidate.text || ''} ${
    candidate.ariaLabel || ''
  }`.replace(/\s+/g, ' ');
  const src = String(candidate.src || '');
  const searchable = text.toLowerCase();
  const natural = candidate.natural || [0, 0];
  const rect = candidate.rect || [0, 0];
  const [nw, nh] = natural;
  const [rw, rh] = rect;
  const hasMenuWord = /(오늘의\s*)?메뉴|식단|특식|중식|금일\s*메뉴/.test(searchable);
  const matchedDate = dateTokens.find((token) => searchable.includes(token.toLowerCase()));
  const knownSize = [
    [240, 300],
    [339, 226],
  ].some(
    ([w, h]) =>
      (Math.abs(nw - w) <= 4 && Math.abs(nh - h) <= 4) ||
      (Math.abs(rw - w) <= 4 && Math.abs(rh - h) <= 4),
  );

  if (/captcha|캡차|보안\s*확인/.test(`${searchable} ${src.toLowerCase()}`)) {
    return { score: -1000, reasons: ['captcha'] };
  }
  if (!/^https?:\/\//i.test(src)) {
    return { score: -900, reasons: ['non-http-image'] };
  }

  if (hasMenuWord) {
    score += 90;
    reasons.push('menu-text');
  }
  if (matchedDate) {
    score += 85;
    reasons.push(`today:${matchedDate}`);
  }
  if (hasMenuWord && matchedDate) {
    score += 45;
    reasons.push('menu-and-today');
  }
  if (knownSize) {
    score += 65;
    reasons.push('known-size');
  }
  if (candidate.inPlaceThumb) {
    score += 12;
    reasons.push('place-thumb');
  }
  if (/ldb-phinf\.pstatic\.net/i.test(src)) {
    score += 12;
    reasons.push('business-image');
  }
  if (/pup-review|blogfiles|clip-service|myplace-phinf/i.test(src)) {
    score -= hasMenuWord ? 15 : 50;
    reasons.push('visitor-image');
  }
  if (nw >= 200 && nh >= 200 && nh / Math.max(nw, 1) >= 1.15) {
    score += 12;
    reasons.push('portrait');
  }
  if (rw * rh >= 120 * 120) {
    score += 5;
    reasons.push('large-enough');
  }
  if (!candidate.clickable) {
    score -= 25;
    reasons.push('not-clickable');
  }

  return { score, reasons };
}

async function naverBlockReason(page) {
  for (const frame of page.frames()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const blocked = await frame.evaluate(() => {
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 5000);
        const hasCaptcha = !!document.querySelector(
          'img.captcha_img, img[alt*="캡차"], input[placeholder*="정답"]',
        );
        const hasSecurityText =
          bodyText.includes('보안 확인을 완료해 주세요') ||
          bodyText.includes('스팸을 방지하는 데 도움이 됩니다');
        if (hasCaptcha || hasSecurityText) {
          return hasCaptcha ? 'captcha' : 'security-check';
        }
        return null;
      });
      if (blocked) return blocked;
    } catch {
      /* 다른 origin으로 전환 중인 프레임은 다음 프레임에서 확인 */
    }
  }
  return null;
}

async function throwIfNaverBlocked(page, stage) {
  const reason = await naverBlockReason(page);
  if (!reason) return;
  throw new Error(
    `[봄봄] 네이버 보안 확인(CAPTCHA/요청 제한) 감지: ${stage} (${reason}). ` +
      '메뉴 선택 규칙으로 해결할 수 없는 상태이므로 다음 예약 실행에서 재시도합니다.',
  );
}

async function captureNaverMapNews(page, url, imageFileName) {
  const debugCapture = process.env.CAPTURE_DEBUG === '1';
  await page.goto(url, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1500));
  await throwIfNaverBlocked(page, '장소 페이지 진입');

  // 네이버 지도 place 상세는 보통 iframe#entryIframe 안에서 렌더링됩니다.
  const entryIframe = await page.waitForSelector('iframe#entryIframe', {
    timeout: 30000,
  });
  const frame = await entryIframe.contentFrame();
  if (!frame) throw new Error('네이버 지도 entryIframe 프레임을 얻지 못했습니다.');
  await throwIfNaverBlocked(page, '장소 상세 로드');

  // "소식(News)" 탭 클릭.
  // CI에서 언어/렌더링이 달라도 동작하도록 텍스트 + href/feed 패턴을 함께 사용합니다.
  const clickedNews = await frame.waitForFunction(
    () => {
      function isVisible(el) {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 6 && r.height > 6;
      }

      function isNewsTab(el) {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const href = (el.getAttribute('href') || '').toLowerCase();
        return txt.includes('소식') || txt === 'news' || href.includes('/feed');
      }

      const nodes = Array.from(document.querySelectorAll('a, button, [role="tab"]')).filter(
        (el) => isVisible(el) && isNewsTab(el),
      );
      if (nodes.length === 0) return false;

      const inTablist = nodes.find((el) => el.closest('[role="tablist"]'));
      const target = inTablist || nodes[0];
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      return false;
    },
    { timeout: 30000 },
  );
  const clickedNewsValue = await clickedNews.jsonValue();
  if (!clickedNewsValue) throw new Error('소식 탭 요소를 찾지 못했습니다.');

  // 화면 전환 및 지연 로딩 대기
  await new Promise((r) => setTimeout(r, 8000));
  await throwIfNaverBlocked(page, '소식 탭 로드');

  /**
   * 이미지의 고정 px 크기만 보던 예전 규칙 대신, 현재 날짜·메뉴 문구·업체 이미지 여부·
   * 세로형 비율·기존 알려진 규격을 함께 점수화합니다. 네이버가 썸네일을 정사각형으로
   * 리사이즈해도 주변 카드에 날짜/메뉴 문구가 있으면 선택할 수 있습니다.
   */
  async function tryClickMenuPhotoButton(fr) {
    const dateTokens = naverMenuDateTokens();
    const imageCandidates = await fr.evaluate((todayTokens) => {
      function isVisible(el) {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      }

      document
        .querySelectorAll('[data-babb-menu-candidate]')
        .forEach((el) => el.removeAttribute('data-babb-menu-candidate'));

      return Array.from(document.querySelectorAll('img'))
        .filter((img) => img instanceof HTMLImageElement && isVisible(img))
        .map((img, index) => {
          const src = (img.currentSrc || img.getAttribute('src') || '').trim();
          const rect = img.getBoundingClientRect();
          const clickable = img.closest('a, button, [role="button"], [tabindex="0"]');
          let contextText = '';
          let cursor = img.parentElement;
          for (let depth = 0; cursor && depth < 8; depth += 1, cursor = cursor.parentElement) {
            const candidateText = (cursor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!candidateText || candidateText.length > 900) continue;
            contextText = candidateText;
            if (
              /메뉴|식단|특식|중식/.test(candidateText) ||
              todayTokens.some((token) => candidateText.includes(token))
            )
              break;
          }

          const id = String(index);
          img.setAttribute('data-babb-menu-candidate', id);
          return {
            id,
            alt: (img.getAttribute('alt') || '').slice(0, 160),
            ariaLabel: (
              img.getAttribute('aria-label') ||
              clickable?.getAttribute('aria-label') ||
              ''
            ).slice(0, 160),
            natural: [img.naturalWidth || 0, img.naturalHeight || 0],
            rect: [Math.round(rect.width), Math.round(rect.height)],
            src,
            clickable: !!clickable,
            inPlaceThumb: !!img.closest('.place_thumb, [class*="place_thumb"]'),
            text: contextText.slice(0, 900),
          };
        });
    }, dateTokens);

    const rankedCandidates = imageCandidates
      .map((candidate) => ({
        ...candidate,
        ...scoreNaverMenuCandidate(candidate, dateTokens),
      }))
      .sort((a, b) => b.score - a.score);

    if (debugCapture) {
      console.log(
        '[봄봄] 메뉴 후보 점수:',
        JSON.stringify(
          rankedCandidates.slice(0, 10).map((candidate) => ({
            score: candidate.score,
            reasons: candidate.reasons,
            natural: candidate.natural,
            rect: candidate.rect,
            text: candidate.text.slice(0, 160),
            src: candidate.src.slice(0, 160),
          })),
        ),
      );
    }

    const best = rankedCandidates[0];
    if (best && best.score >= 70) {
      const clicked = await fr.evaluate((candidateId) => {
        const img = document.querySelector(
          `img[data-babb-menu-candidate="${candidateId}"]`,
        );
        if (!(img instanceof HTMLImageElement)) return false;
        const target =
          img.closest('a, button, [role="button"], [tabindex="0"]') || img;
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      }, best.id);
      if (clicked) {
        console.log(
          `[봄봄] 점수 기반 메뉴 이미지 클릭: score=${best.score}, reasons=${best.reasons.join(
            ',',
          )}, natural=${best.natural.join('x')}, rect=${best.rect.join('x')}`,
        );
        return { ok: true, reason: `scored-image:${best.reasons.join(',')}` };
      }
    }

    // 이미지 주변 텍스트를 DOM 구조상 묶지 못한 경우, 메뉴/오늘 날짜가 있는 카드 안의
    // 첫 이미지를 마지막 의미 기반 폴백으로 사용합니다. 상단 탭은 카드가 아니므로 제외됩니다.
    const semanticCardResult = await fr.evaluate((todayTokens) => {
      function isVisible(el) {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 6 && r.height > 6;
      }

      const cards = Array.from(
        document.querySelectorAll(
          'article, li, [class*="feed"], [class*="news"], [class*="post"], [class*="card"]',
        ),
      );
      for (const card of cards) {
        if (!(card instanceof HTMLElement) || !isVisible(card)) continue;
        const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
        const hasMenu = /메뉴|식단|특식|중식/.test(text);
        const hasToday = todayTokens.some((token) => text.includes(token));
        if (!hasMenu && !hasToday) continue;
        const img = Array.from(card.querySelectorAll('img')).find(isVisible);
        if (!(img instanceof HTMLImageElement)) continue;
        const target =
          img.closest('a, button, [role="button"], [tabindex="0"]') || img;
        if (target instanceof HTMLElement) {
          target.click();
          return { ok: true, hasMenu, hasToday };
        }
      }
      return { ok: false };
    }, dateTokens);
    if (semanticCardResult.ok) {
      const reason = semanticCardResult.hasToday ? 'semantic-card:today' : 'semantic-card:menu';
      console.log(`[봄봄] 의미 기반 카드 이미지 클릭: ${reason}`);
      return { ok: true, reason };
    }

    return {
      ok: false,
      reason: best
        ? `고신뢰 후보 없음(bestScore=${best.score}, reasons=${best.reasons.join(',')})`
        : '표시된 이미지 후보 없음',
    };
  }

  const menuClick = await tryClickMenuPhotoButton(frame);
  if (!menuClick.ok) {
    throw new Error(`[봄봄] 메뉴 사진 버튼 탐색 실패: ${menuClick.reason}`);
  }

  // 줌 UI는 클릭 후 다른 레이어/프레임으로 이동할 수 있어, 전체 프레임에서 다시 찾습니다.
  let zoomPlusClicks = 0;
  let zoomWheelDispatches = 0;
  let effectiveZoomIn = 0;
  let lastMinusEnabled = null;

  async function getZoomButtonsState(ctx) {
    try {
      return await ctx.evaluate(() => {
        const plus = document.querySelector('div.btn_zoom button.btn_plus');
        const minus = document.querySelector('div.btn_zoom button.btn_minus');

        function btnInfo(el) {
          if (!(el instanceof HTMLButtonElement)) return { exists: false };
          const rect = el.getBoundingClientRect();
          return {
            exists: true,
            disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        }

        return { plus: btnInfo(plus), minus: btnInfo(minus) };
      });
    } catch {
      return null;
    }
  }

  async function getMainImageMetrics(ctx) {
    try {
      return await ctx.evaluate(() => {
        function isVisible(el) {
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          )
            return false;
          const r = el.getBoundingClientRect();
          return r.width > 10 && r.height > 10;
        }

        const imgs = Array.from(document.querySelectorAll('img')).filter(isVisible);
        if (imgs.length === 0) return null;

        // 가장 크게 보이는 이미지를 "메인 뷰어"로 간주
        let best = imgs[0];
        let bestArea = 0;
        for (const img of imgs) {
          const r = img.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) {
            bestArea = area;
            best = img;
          }
        }
        const rect = best.getBoundingClientRect();
        const src = (best.getAttribute('src') || '').slice(0, 200);
        const nw = best.naturalWidth || 0;
        const nh = best.naturalHeight || 0;
        return {
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          natural: [nw, nh],
          srcPreview: src,
        };
      });
    } catch {
      return null;
    }
  }

  async function sampleMinus(ctx, label) {
    const cur = await isMinusEnabledInContext(ctx);
    const state = await getZoomButtonsState(ctx);
    const img = await getMainImageMetrics(ctx);
    const prev = lastMinusEnabled;
    if (prev === false && cur === true) {
      effectiveZoomIn += 1;
      console.log(`[봄봄] 줌 반영 감지(+): ${label} (effective=${effectiveZoomIn})`);
    }
    console.log(
      `[봄봄] 줌 상태(${label}): minusEnabled=${cur} prev=${prev} buttons=${state ? JSON.stringify(state) : 'n/a'} img=${img ? JSON.stringify(img) : 'n/a'}`,
    );
    lastMinusEnabled = cur;
    return cur;
  }

  async function tryClickZoomPlusInContext(ctx, attempts = 5) {
    const zoomPlusSelector = 'div.btn_zoom button.btn_plus';
    try {
      await ctx.waitForSelector(zoomPlusSelector, { timeout: 2000 });
      await sampleMinus(ctx, 'before-plus');
      for (let i = 0; i < attempts; i += 1) {
        const st = await getZoomButtonsState(ctx);
        if (st?.plus?.exists && st.plus.disabled) {
          console.log(`[봄봄] plus 버튼이 disabled라 클릭 스킵 (i=${i})`);
          break;
        }
        await ctx.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el instanceof HTMLElement) el.click();
        }, zoomPlusSelector);
        zoomPlusClicks += 1;
        await sampleMinus(ctx, `after-plus-${i + 1}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      return true;
    } catch {
      return false;
    }
  }

  async function isMinusEnabledInContext(ctx) {
    const zoomMinusSelector = 'div.btn_zoom button.btn_minus';
    try {
      return await ctx.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!(el instanceof HTMLButtonElement)) return null;
        return !(el.disabled || el.getAttribute('aria-disabled') === 'true');
      }, zoomMinusSelector);
    } catch {
      return null;
    }
  }

  // 0) 클릭 직후 약간 대기(레이어 생성 시간)
  await new Promise((r) => setTimeout(r, 1200));

  async function findContextWithZoomControls(preferredCtx, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const st = await getZoomButtonsState(preferredCtx);
        if (st?.plus?.exists || st?.minus?.exists) return preferredCtx;
      } catch {
        /* ignore */
      }

      for (const f of page.frames()) {
        if (f === preferredCtx) continue;
        // eslint-disable-next-line no-await-in-loop
        const st = await getZoomButtonsState(f);
        if (st?.plus?.exists || st?.minus?.exists) {
          console.log(`[봄봄] 줌 컨트롤 프레임 전환 감지: ${f.url()}`);
          return f;
        }
      }

      await new Promise((r) => setTimeout(r, 350));
    }
    return null;
  }

  async function zoomInUntilStuck(ctx) {
    // “안 될 때까지” = plus 버튼이 disabled(최대 줌) 될 때까지
    // 혹시 DOM이 꼬여도 무한 루프 방지용으로 상한만 둡니다.
    const MAX_STEPS = 40;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const st = await getZoomButtonsState(ctx);
      if (!st?.plus?.exists) {
        console.log('[봄봄] plus 버튼을 찾지 못해 줌인 루프 종료');
        break;
      }
      if (st.plus.disabled) {
        console.log('[봄봄] plus 버튼 disabled(최대 줌) → 종료');
        break;
      }

      // 1회 클릭
      await sampleMinus(ctx, `before-plus-step-${step + 1}`);
      await ctx.evaluate(() => {
        const el = document.querySelector('div.btn_zoom button.btn_plus');
        if (el instanceof HTMLElement) el.click();
      });
      zoomPlusClicks += 1;

      await new Promise((r) => setTimeout(r, 300));
      const after = await getZoomButtonsState(ctx);
      console.log(
        `[봄봄] 줌인 step=${step + 1} plusDisabled=${after?.plus?.disabled ?? null}`,
      );
      await sampleMinus(ctx, `after-plus-step-${step + 1}`);
    }
  }

  // 1) entryIframe 안에서 먼저 “안 될 때까지” 줌인
  const zoomCtx = await findContextWithZoomControls(frame, 15000);
  if (!zoomCtx) {
    console.warn('[봄봄] 줌 컨트롤을 찾지 못했습니다. (줌 스킵)');
  } else {
    await zoomInUntilStuck(zoomCtx);
  }

  // 디버그: 줌(-) 버튼이 활성화되었는지(=확대된 흔적) 로그
  const minusEnabled = await isMinusEnabledInContext(frame);
  if (minusEnabled === true) console.log('[봄봄] 줌(-) 활성화 감지(확대된 것으로 추정)');
  console.log(
    `[봄봄] 줌 시도 요약: plusClick=${zoomPlusClicks}, wheelDispatch=${zoomWheelDispatches}, effectiveZoomIn=${effectiveZoomIn}`,
  );

  // 클릭 후 화면이 바뀔 시간을 확보 (요청사항: 10초)
  await new Promise((r) => setTimeout(r, 10000));
  // 우선: 뷰어에서 가장 큰 img의 URL을 fetch해 저장(배경 없이 메뉴 원본에 가깝게).
  // 실패 시: 전체 페이지 캡처(배경 포함).
  const savedFromImageUrl = await tryFetchLargestVisibleImageAcrossFrames(page, imageFileName);
  if (!savedFromImageUrl) {
    await page.screenshot({ path: imageFileName, fullPage: true });
  }
}

async function screenshotLargestVisibleImage(ctx, outPath) {
  try {
    const imgs = await ctx.$$('img');
    if (!imgs || imgs.length === 0) return false;

    let best = null;
    let bestArea = 0;

    for (const h of imgs) {
      // eslint-disable-next-line no-await-in-loop
      const bb = await h.boundingBox();
      if (!bb) continue;
      const area = bb.width * bb.height;
      if (area < 10 * 10) continue;

      // eslint-disable-next-line no-await-in-loop
      const visible = await h.evaluate((el) => {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        )
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      });
      if (!visible) continue;

      if (area > bestArea) {
        bestArea = area;
        best = h;
      }
    }

    if (!best) return false;
    await best.screenshot({ path: outPath });
    return true;
  } catch {
    return false;
  }
}

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

function loadGithubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('.env에 GITHUB_TOKEN이 필요합니다. (repo 쓰기 권한이 있는 PAT)');
  }
  return token;
}

/**
 * GitHub 원격 URL (토큰을 URL에 포함 — clone/push 인증용)
 * 로컬: https://hiemsnocte:${GITHUB_TOKEN}@github.com/hiemsnocte/babb.git
 * GitHub Actions: https://x-access-token:${GITHUB_TOKEN}@github.com/... (자동 주입 토큰)
 */
function githubRemoteUrl(token) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    return `https://x-access-token:${token}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
  }
  return `https://${GITHUB_OWNER}:${token}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
}

/** 에러 메시지·스택에서 토큰·자격 증명 URL이 로그에 노출되지 않게 마스킹 */
function redactSecretsForLog(text, token) {
  if (text == null) return '';
  let s = String(text);
  if (token) {
    s = s.split(token).join('***');
  }
  s = s.replace(
    new RegExp(`https://${GITHUB_OWNER}:[^\\s@]+@github\\.com`, 'g'),
    `https://${GITHUB_OWNER}:***@github.com`,
  );
  s = s.replace(
    /https:\/\/x-access-token:[^\s@]+@github\.com/g,
    'https://x-access-token:***@github.com',
  );
  return s;
}

function logErrorWithoutSecrets(err, token) {
  const msg = redactSecretsForLog(err?.message ?? err, token);
  console.error(msg);
  if (err?.stack) {
    console.error(redactSecretsForLog(err.stack, token));
  }
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureClone(remoteUrl, repoPath) {
  const gitDir = path.join(repoPath, '.git');
  if (await pathExists(gitDir)) {
    return;
  }
  await fs.mkdir(path.dirname(repoPath), { recursive: true });
  await simpleGit().clone(remoteUrl, repoPath);
}

/**
 * 레포를 "단일 커밋 스냅샷"으로 유지하며 강제 푸시합니다.
 * - origin/main 내용을 워킹트리에 받음
 * - 메뉴 이미지들만 교체
 * - checkout --orphan 로 히스토리 제거(워킹트리 유지)
 * - add -A 후 커밋 1개 만들고 main으로 force-push
 */
async function gitForcePushSnapshotWithMenus({ repoPath, remoteUrl, branch, menuFiles }) {
  const git = simpleGit({ baseDir: repoPath });
  const gitUserName = process.env.GITHUB_GIT_USER_NAME || 'Menu Bot';
  const gitUserEmail = process.env.GITHUB_GIT_USER_EMAIL || 'menu-bot@users.noreply.github.com';

  await git.addConfig('user.name', gitUserName, false, 'local');
  await git.addConfig('user.email', gitUserEmail, false, 'local');
  await git.remote(['set-url', 'origin', remoteUrl]);

  // menus 브랜치는 "이미지 파일만" 남기고 스냅샷 1커밋으로 유지합니다.
  const orphanName = `orphan_${Date.now()}`;
  await git.raw(['checkout', '--orphan', orphanName]);
  // orphan checkout은 "히스토리만" 비우고 워킹트리는 그대로 유지합니다.
  // 따라서 기존(main)에서 트래킹되던 파일들은 git clean만으로는 제거되지 않습니다.
  // menus 브랜치에 이미지 외 파일이 섞이지 않게, .git을 제외한 모든 파일을 직접 삭제합니다.
  const entries = await fs.readdir(repoPath, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === '.git') continue;
    // eslint-disable-next-line no-await-in-loop
    await fs.rm(path.join(repoPath, ent.name), { recursive: true, force: true });
  }
  // 안전망: 남아있는 untracked도 정리
  await git.raw(['clean', '-fdx']);

  for (const f of menuFiles) {
    const dest = path.join(repoPath, f.destFileName);
    await fs.copyFile(f.localPath, dest);
  }

  await git.add(['-A']);
  await git.commit('Snapshot update (menus)');

  try {
    await git.deleteLocalBranch(branch, true);
  } catch {
    /* 로컬에 해당 브랜치 없음 */
  }

  await git.raw(['branch', '-m', branch]);
  await git.raw(['push', '--force', 'origin', branch]);
  const names = menuFiles.map((m) => m.destFileName).join(', ');
  console.log(`[menus] force-push 완료: origin/${branch} (파일: ${names})`);
}

function todayDateKorea() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function captureRestaurantWithRetries(page, restaurant, localPath) {
  const configuredAttempts = Number(process.env.NAVER_CAPTURE_ATTEMPTS || 2);
  const maxAttempts =
    restaurant.type === 'naverMap'
      ? Math.min(3, Math.max(1, Number.isFinite(configuredAttempts) ? configuredAttempts : 2))
      : 1;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (restaurant.type === 'kakao') {
        await captureKakaoProfileMenu(page, restaurant.profileUrl, localPath);
      } else if (restaurant.type === 'naverMap') {
        await captureNaverMapNews(page, restaurant.profileUrl, localPath);
      } else {
        throw new Error(`지원하지 않는 type 입니다: ${restaurant.type}`);
      }
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const nonRetriable = /CAPTCHA|보안 확인|ERR_NETWORK_ACCESS_DENIED/.test(message);
      if (nonRetriable || attempt >= maxAttempts) break;
      console.warn(
        `[${restaurant.name}] 캡처 재시도 ${attempt + 1}/${maxAttempts}: ${message}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError;
}

async function main() {
  const dryRun = process.env.CAPTURE_DRY_RUN === '1';
  const captureOnly = (process.env.CAPTURE_ONLY || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!dryRun && captureOnly.length > 0) {
    throw new Error('CAPTURE_ONLY는 원격 메뉴를 일부만 덮어쓰지 않도록 dry-run에서만 허용됩니다.');
  }
  const selectedRestaurants =
    captureOnly.length === 0
      ? RESTAURANTS
      : RESTAURANTS.filter((restaurant) => captureOnly.includes(restaurant.id));
  if (selectedRestaurants.length === 0) {
    throw new Error(`CAPTURE_ONLY에 해당하는 식당이 없습니다: ${captureOnly.join(', ')}`);
  }

  let db = null;
  let remoteUrl = null;
  if (!dryRun) {
    const firebaseConfig = loadFirebaseConfig();
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);

    const token = loadGithubToken();
    remoteUrl = githubRemoteUrl(token);
  }

  const cacheRoot = path.join(process.cwd(), '.menu-github-cache');
  const repoPath = path.join(cacheRoot, `${GITHUB_OWNER}_${GITHUB_REPO}`);
  const outputDir = path.resolve(process.cwd(), process.env.CAPTURE_OUTPUT_DIR || '.');
  await fs.mkdir(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=ko-KR',
    ],
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  });
  // 로컬 브라우저와 CI(헤드리스)에서 레이아웃·줌 UI 위치가 달라지는 것을 줄이기 위해 고정
  // 너무 큰 뷰포트는 "이미지+회색 여백" 비중을 키워 결과가 작아 보일 수 있어 적당히 낮춥니다.
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  const captured = [];
  const captureErrors = [];
  for (const r of selectedRestaurants) {
    const localPath = path.join(outputDir, r.imageFileName);
    try {
      await captureRestaurantWithRetries(page, r, localPath);
      captured.push({ ...r, localPath });
    } catch (e) {
      captureErrors.push({ id: r.id, name: r.name, error: String(e?.message ?? e) });
      console.error(`[캡처 실패] ${r.name}: ${String(e?.message ?? e)}`);
      if (dryRun) {
        const parsed = path.parse(localPath);
        const errorScreenshotPath = path.join(parsed.dir, `${parsed.name}.error.png`);
        try {
          await page.screenshot({ path: errorScreenshotPath, fullPage: true });
          console.log(`[dry-run] 실패 화면 저장: ${errorScreenshotPath}`);
        } catch (screenshotError) {
          console.warn(
            `[dry-run] 실패 화면 저장 실패: ${String(
              screenshotError?.message || screenshotError,
            )}`,
          );
        }
      }
    }
  }

  await browser.close();
  console.log('캡처 완료! 폴더를 확인해 보세요.');

  if (captured.length === 0) {
    throw new Error('모든 식당 캡처에 실패했습니다.');
  }

  const publishedMenus = captured.map((entry) => ({ ...entry, stale: false }));
  if (!dryRun && captureErrors.length > 0) {
    for (const captureError of captureErrors) {
      const restaurant = selectedRestaurants.find((item) => item.id === captureError.id);
      if (!restaurant) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const previous = await downloadPreviousMenuSnapshot(restaurant, outputDir);
        publishedMenus.push(previous);
        console.warn(
          `[${restaurant.name}] 새 캡처 실패 → 직전 정상 메뉴 이미지를 유지합니다: ${previous.localPath}`,
        );
      } catch (preserveError) {
        throw new Error(
          `[${restaurant.name}] 새 캡처와 직전 이미지 보존이 모두 실패하여 원격 갱신을 중단합니다. ` +
            `캡처 오류: ${captureError.error}; 보존 오류: ${String(
              preserveError?.message || preserveError,
            )}`,
        );
      }
    }
  }
  const menuOrder = new Map(selectedRestaurants.map((restaurant, index) => [restaurant.id, index]));
  publishedMenus.sort((a, b) => (menuOrder.get(a.id) ?? 999) - (menuOrder.get(b.id) ?? 999));

  if (dryRun) {
    console.log(
      `[dry-run] 외부 갱신 없이 로컬 캡처만 완료했습니다: ${captured
        .map((c) => c.localPath)
        .join(', ')}`,
    );
    if (captureErrors.length > 0) {
      throw new Error(
        `[dry-run] 일부 캡처 실패: ${captureErrors
          .map((e) => `${e.name}: ${e.error}`)
          .join(' | ')}`,
      );
    }
    return;
  }

  await ensureClone(remoteUrl, repoPath);
  await gitForcePushSnapshotWithMenus({
    repoPath,
    remoteUrl,
    branch: GITHUB_MENUS_BRANCH,
    menuFiles: publishedMenus.map((c) => ({
      localPath: c.localPath,
      destFileName: c.imageFileName,
    })),
  });

  const date = todayDateKorea();
  const restaurants = publishedMenus.map((c) => ({
    id: c.id,
    name: c.name,
    imageUrl: withCacheBust(rawGithubFileUrl(c.imageFileName)),
    stale: !!c.stale,
  }));
  await setDoc(
    doc(db, 'menus', FIRESTORE_MENU_DOC_ID),
    {
      restaurants,
      captureErrors,
      date,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  console.log(`Firestore menus/${FIRESTORE_MENU_DOC_ID} 문서를 갱신했습니다. (date: ${date})`);
  console.log(`restaurants: ${restaurants.map((r) => r.imageUrl).join(', ')}`);
}

if (require.main === module) {
  main().catch((err) => {
    logErrorWithoutSecrets(err, process.env.GITHUB_TOKEN);
    process.exit(1);
  });
}

module.exports = {
  downloadPreviousMenuSnapshot,
  isLikelyImageBytes,
  naverMenuDateTokens,
  scoreNaverMenuCandidate,
};
