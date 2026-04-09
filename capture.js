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
  await page.screenshot({ path: imageFileName, fullPage: true });
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

  // <div class="Hqj1R"> 안의 <div class="zmCWt"> (업로드된 메뉴사진 버튼) 클릭
  const menuButtonSelector = 'div.Hqj1R div.zmCWt';
  await frame.waitForSelector(menuButtonSelector, { timeout: 60000 });
  const menuButton = await frame.$(menuButtonSelector);
  if (!menuButton) throw new Error('메뉴 사진 버튼(zmCWt)을 찾지 못했습니다.');
  await menuButton.click();

  // 줌 UI는 클릭 후 다른 레이어/프레임으로 이동할 수 있어, 전체 프레임에서 다시 찾습니다.
  async function tryClickZoomPlusInContext(ctx, attempts = 5) {
    const zoomPlusSelector = 'div.btn_zoom button.btn_plus';
    try {
      await ctx.waitForSelector(zoomPlusSelector, { timeout: 2000 });
      for (let i = 0; i < attempts; i += 1) {
        await ctx.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el instanceof HTMLElement) el.click();
        }, zoomPlusSelector);
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

  let zoomed = false;
  // 1) entryIframe 안에서 먼저 시도
  zoomed = await tryClickZoomPlusInContext(frame, 5);

  // 2) 안 되면 페이지의 모든 프레임(최상위 포함)에서 탐색
  if (!zoomed) {
    for (const f of page.frames()) {
      // 같은 frame 중복 시도 방지
      if (f === frame) continue;
      // eslint-disable-next-line no-await-in-loop
      const ok = await tryClickZoomPlusInContext(f, 5);
      if (ok) {
        zoomed = true;
        break;
      }
    }
  }

  // 3) 그래도 안 되면 ctrlKey 포함 wheel 이벤트를 프레임에 디스패치(지도에서 ctrl+wheel만 받는 케이스 대응)
  if (!zoomed) {
    try {
      await frame.evaluate(() => {
        const target =
          document.querySelector('div.btn_zoom') ||
          document.querySelector('div.Hqj1R') ||
          document.body;
        for (let i = 0; i < 60; i += 1) {
          const evt = new WheelEvent('wheel', {
            deltaY: -250,
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          });
          target.dispatchEvent(evt);
        }
      });
      console.log('[봄봄] 줌: ctrl+wheel 이벤트로 확대 시도 완료');
    } catch {
      console.warn('[봄봄] 줌(+) 버튼/휠 확대를 모두 실패해 스킵했습니다.');
    }
  }

  // 4) "- 버튼 비활성화(=최소 줌)" 상태면 추가 확대를 조금 더 시도
  //    (버튼/휠이 '실행'된 것과 '줌이 실제로 반영'된 것은 다를 수 있어 상태 기반으로 재시도)
  try {
    const minusEnabled0 = await isMinusEnabledInContext(frame);
    if (minusEnabled0 === false) {
      // 최대 3라운드 추가 시도
      for (let round = 0; round < 3; round += 1) {
        // eslint-disable-next-line no-await-in-loop
        const ok1 = await tryClickZoomPlusInContext(frame, 5);
        if (!ok1) {
          // eslint-disable-next-line no-await-in-loop
          await frame.evaluate(() => {
            const target =
              document.querySelector('div.btn_zoom') ||
              document.querySelector('div.Hqj1R') ||
              document.body;
            for (let i = 0; i < 40; i += 1) {
              const evt = new WheelEvent('wheel', {
                deltaY: -250,
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
              });
              target.dispatchEvent(evt);
            }
          });
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        // eslint-disable-next-line no-await-in-loop
        const minusEnabledN = await isMinusEnabledInContext(frame);
        if (minusEnabledN === true) break;
      }
    }
  } catch {
    /* ignore */
  }

  // 디버그: 줌(-) 버튼이 활성화되었는지(=확대된 흔적) 로그
  const minusEnabled = await isMinusEnabledInContext(frame);
  if (minusEnabled === true) console.log('[봄봄] 줌(-) 활성화 감지(확대된 것으로 추정)');

  // 클릭 후 화면이 바뀔 시간을 확보 (요청사항: 10초)
  await new Promise((r) => setTimeout(r, 10000));
  await page.screenshot({ path: imageFileName, fullPage: true });
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
}

function todayDateKorea() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

(async () => {
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
