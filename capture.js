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

async function captureNaverMapNews(page, url, imageFileName) {
  await page.goto(url, { waitUntil: 'load' });

  // 네이버 지도 place 상세는 보통 iframe#entryIframe 안에서 렌더링됩니다.
  const entryIframe = await page.waitForSelector('iframe#entryIframe', {
    timeout: 60000,
  });
  const frame = await entryIframe.contentFrame();
  if (!frame) throw new Error('네이버 지도 entryIframe 프레임을 얻지 못했습니다.');

  // "소식" 탭 클릭
  // Puppeteer는 text="..." 셀렉터를 지원하지 않으므로 XPath로 텍스트를 찾습니다.
  const newsXPath =
    "//*[self::a or self::button][contains(normalize-space(.), '소식')]";
  const newsElHandle = await frame.waitForFunction(
    (xpath) => {
      const r = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      return r.singleNodeValue || null;
    },
    { timeout: 60000 },
    newsXPath,
  );
  const newsEl = await newsElHandle.asElement();
  if (!newsEl) throw new Error('소식 탭 요소를 찾지 못했습니다.');
  await newsEl.click();

  // 화면 전환 대기 (요청사항: 10초 정도)
  await new Promise((r) => setTimeout(r, 10000));

  /**
   * 네이버가 클래스를 자주 바꿔서, 고정 클래스보다
   * 1) .place_thumb 안 img(썸네일 — ::after는 DOM에 없어 부모/이미지로 클릭)
   * 2) 텍스트 "메뉴" (소식 피드 쪽; 상단과 겹치면 잘못 누를 수 있어 2순위)
   * 3) 예전 구조(Hqj1R/zmCWt) 폴백
   * 순으로 시도합니다.
   */
  async function tryClickMenuPhotoButton(fr) {
    const menuTextXPath =
      "//*[self::a or self::button][contains(normalize-space(.), '메뉴')]";

    // 1) .place_thumb — ::after는 선택 불가.
    //    소식 피드에 이미지가 많아도, "규격(339x226)"에 가까운 썸네일을 먼저 집습니다.
    const thumbResult = await fr.evaluate(() => {
      const TARGET_W = 339;
      const TARGET_H = 226;
      const TOL = 3; // px 오차 허용

      function approx(n, t) {
        return Math.abs(n - t) <= TOL;
      }

      function isVisible(el) {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      }

      const roots = Array.from(
        document.querySelectorAll('.place_thumb, [class*="place_thumb"]'),
      );

      // 1-a) place_thumb 내부 img 중 규격 매칭 우선
      for (const root of roots) {
        const imgs = Array.from(root.querySelectorAll('img'));
        for (const img of imgs) {
          if (!(img instanceof HTMLImageElement)) continue;
          if (!isVisible(img)) continue;
          const src = (img.getAttribute('src') || '').trim();
          if (!src || src.startsWith('data:')) continue;

          // 자연 크기 or 표시 크기(둘 다 검사)
          const nw = img.naturalWidth || 0;
          const nh = img.naturalHeight || 0;
          const rect = img.getBoundingClientRect();
          const rw = Math.round(rect.width);
          const rh = Math.round(rect.height);

          const sizeOk =
            (nw && nh && approx(nw, TARGET_W) && approx(nh, TARGET_H)) ||
            (approx(rw, TARGET_W) && approx(rh, TARGET_H));
          if (!sizeOk) continue;

          const clickable =
            root.closest('a, button, [role="button"]') ||
            (root instanceof HTMLElement ? root : null) ||
            img;
          if (clickable instanceof HTMLElement) {
            clickable.click();
            return {
              ok: true,
              reason: 'place_thumb:size',
              srcPreview: src.slice(0, 200),
              size: { natural: [nw, nh], rect: [rw, rh] },
            };
          }
        }
      }

      // 1-b) place_thumb에서 못 찾으면, 전체 img 중 규격 매칭 (피드 외부까지 넓힘)
      const allImgs = Array.from(document.querySelectorAll('img'));
      for (const img of allImgs) {
        if (!(img instanceof HTMLImageElement)) continue;
        if (!isVisible(img)) continue;
        const src = (img.getAttribute('src') || '').trim();
        if (!src || src.startsWith('data:')) continue;
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        const rect = img.getBoundingClientRect();
        const rw = Math.round(rect.width);
        const rh = Math.round(rect.height);
        const sizeOk =
          (nw && nh && approx(nw, TARGET_W) && approx(nh, TARGET_H)) ||
          (approx(rw, TARGET_W) && approx(rh, TARGET_H));
        if (!sizeOk) continue;

        const clickable =
          img.closest('.place_thumb, [class*="place_thumb"]')?.closest('a, button, [role="button"]') ||
          img.closest('a, button, [role="button"]') ||
          (img instanceof HTMLElement ? img : null);
        if (clickable instanceof HTMLElement) {
          clickable.click();
          return {
            ok: true,
            reason: 'img:size',
            srcPreview: src.slice(0, 200),
            size: { natural: [nw, nh], rect: [rw, rh] },
          };
        }
      }

      return { ok: false };
    });
    if (thumbResult.ok) {
      console.log(
        '[봄봄] 썸네일 클릭:',
        thumbResult.reason,
        thumbResult.size ? JSON.stringify(thumbResult.size) : '',
        thumbResult.srcPreview,
      );
      return true;
    }

    // 2) 텍스트로 "메뉴" (피드/버튼)
    try {
      const h = await fr.waitForFunction(
        (xpath) => {
          const r = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
          );
          return r.singleNodeValue || null;
        },
        { timeout: 8000 },
        menuTextXPath,
      );
      const el = await h.asElement();
      if (el) {
        await el.click();
        console.log('[봄봄] 텍스트 "메뉴" 요소 클릭');
        return true;
      }
    } catch {
      /* 다음 */
    }

    // 3) 예전 클래스 기반 폴백
    const trySelectors = [
      'div.Hqj1R div.zmCWt',
      'div.Hqj1R button',
      'div.Hqj1R [role="button"]',
      'div[class*="Hqj1R"] div[class*="zmCWt"]',
      '[class*="zmCWt"]',
    ];
    for (const sel of trySelectors) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await fr.waitForSelector(sel, { timeout: 8000 });
        // eslint-disable-next-line no-await-in-loop
        const el = await fr.$(sel);
        if (el) {
          // eslint-disable-next-line no-await-in-loop
          await el.click();
          console.log('[봄봄] 레거시 셀렉터 클릭:', sel);
          return true;
        }
      } catch {
        /* 다음 */
      }
    }

    const clicked = await fr.evaluate(() => {
      const root =
        document.querySelector('div.Hqj1R') ||
        document.querySelector('[class*="Hqj1R"]') ||
        document.body;
      const candidates = root.querySelectorAll(
        'button, [role="button"], a, img, div[tabindex="0"]',
      );
      for (const c of candidates) {
        const t = (c.textContent || '').replace(/\s+/g, ' ').trim();
        const alt = (c.getAttribute && c.getAttribute('alt')) || '';
        if (t.includes('메뉴') || alt.includes('메뉴')) {
          if (typeof c.click === 'function') c.click();
          return true;
        }
      }
      const firstInHqj = root.querySelector('img, [class*="zmCWt"]');
      if (firstInHqj && typeof firstInHqj.click === 'function') {
        firstInHqj.click();
        return true;
      }
      return false;
    });
    return clicked;
  }

  const menuClicked = await tryClickMenuPhotoButton(frame);
  if (!menuClicked) {
    console.warn(
      '[봄봄] 메뉴 사진 버튼을 찾지 못했습니다. 소식 탭 화면으로 스크린샷합니다.',
    );
    await new Promise((r) => setTimeout(r, 3000));
    await page.screenshot({ path: imageFileName, fullPage: true });
    return;
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
  // 네이버 지도 뷰어는 회색 배경/여백이 커서 fullPage로 찍으면 메뉴 이미지가 작아 보입니다.
  // 프레임 내부에서 가장 큰 이미지(메뉴)를 찾아 "이미지 자체"만 캡처합니다.
  const saved = await screenshotLargestVisibleImage(frame, imageFileName);
  if (!saved) {
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

function nowKstMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

function shouldRunCaptureNowKst({ toleranceMin = 3 } = {}) {
  // 목표 실행 시각(KST). GitHub 스케줄 지연/편차를 감안해 ±toleranceMin 분만 허용.
  const targets = ['10:07', '11:07', '23:57']
    .map((s) => s.split(':').map((n) => Number(n)))
    .map(([h, m]) => h * 60 + m);
  const cur = nowKstMinutes();
  return targets.some((t) => Math.abs(cur - t) <= toleranceMin);
}

(async () => {
  // 수동 실행(workflow_dispatch)은 항상 실행. 스케줄은 KST 목표 시간대에만 실행.
  const runEvent = (process.env.RUN_EVENT || '').trim();
  const force = (process.env.FORCE_RUN || '').trim();
  const isManual = runEvent === 'workflow_dispatch' || force === '1' || force.toLowerCase() === 'true';
  if (!isManual) {
    const ok = shouldRunCaptureNowKst({ toleranceMin: 3 });
    if (!ok) {
      const date = todayDateKorea();
      const mins = nowKstMinutes();
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      console.log(`[skip] 스케줄 실행이지만 목표 시간대가 아님 (KST ${date} ${hh}:${mm})`);
      process.exit(0);
    }
  }

  const firebaseConfig = loadFirebaseConfig();
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  const token = loadGithubToken();
  const remoteUrl = githubRemoteUrl(token);
  const cacheRoot = path.join(process.cwd(), '.menu-github-cache');
  const repoPath = path.join(cacheRoot, `${GITHUB_OWNER}_${GITHUB_REPO}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage();
  // 로컬 브라우저와 CI(헤드리스)에서 레이아웃·줌 UI 위치가 달라지는 것을 줄이기 위해 고정
  // 너무 큰 뷰포트는 "이미지+회색 여백" 비중을 키워 결과가 작아 보일 수 있어 적당히 낮춥니다.
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  const captured = [];
  const captureErrors = [];
  for (const r of RESTAURANTS) {
    const localPath = path.resolve(process.cwd(), r.imageFileName);
    try {
      if (r.type === 'kakao') {
        await captureKakaoProfileMenu(page, r.profileUrl, r.imageFileName);
      } else if (r.type === 'naverMap') {
        await captureNaverMapNews(page, r.profileUrl, r.imageFileName);
      } else {
        throw new Error(`지원하지 않는 type 입니다: ${r.type}`);
      }
      captured.push({ ...r, localPath });
    } catch (e) {
      captureErrors.push({ id: r.id, name: r.name, error: String(e?.message ?? e) });
      console.error(`[캡처 실패] ${r.name}: ${String(e?.message ?? e)}`);
    }
  }

  await browser.close();
  console.log('캡처 완료! 폴더를 확인해 보세요.');

  if (captured.length === 0) {
    throw new Error('모든 식당 캡처에 실패했습니다.');
  }

  await ensureClone(remoteUrl, repoPath);
  await gitForcePushSnapshotWithMenus({
    repoPath,
    remoteUrl,
    branch: GITHUB_MENUS_BRANCH,
    menuFiles: captured.map((c) => ({
      localPath: c.localPath,
      destFileName: c.imageFileName,
    })),
  });

  const date = todayDateKorea();
  const restaurants = captured.map((c) => ({
    id: c.id,
    name: c.name,
    imageUrl: withCacheBust(rawGithubFileUrl(c.imageFileName)),
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
})().catch((err) => {
  logErrorWithoutSecrets(err, process.env.GITHUB_TOKEN);
  process.exit(1);
});
