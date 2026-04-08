require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const simpleGit = require('simple-git');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, serverTimestamp } = require('firebase/firestore');

/** GitHub: hiemsnocte/babb, main — menu_today.png 강제 푸시 */
const GITHUB_OWNER = 'hiemsnocte';
const GITHUB_REPO = 'babb';
const GITHUB_BRANCH = 'main';
const MENU_RAW_URL =
  'https://raw.githubusercontent.com/hiemsnocte/babb/main/menu_today.png';
const FIRESTORE_MENU_DOC_ID = 'current';

/** 캐시 버스팅: https://.../menu_today.png?t=[현재시간(ms)] */
function menuImageUrlWithCacheBust() {
  return `${MENU_RAW_URL}?t=${new Date().getTime()}`;
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

async function gitPushSingleMenuImage({ repoPath, remoteUrl, branch, localImagePath }) {
  const git = simpleGit({ baseDir: repoPath });
  const gitUserName = process.env.GITHUB_GIT_USER_NAME || 'Menu Bot';
  const gitUserEmail = process.env.GITHUB_GIT_USER_EMAIL || 'menu-bot@users.noreply.github.com';

  await git.addConfig('user.name', gitUserName, false, 'local');
  await git.addConfig('user.email', gitUserEmail, false, 'local');
  await git.remote(['set-url', 'origin', remoteUrl]);

  let hasHead = false;
  try {
    await git.revparse(['HEAD']);
    hasHead = true;
  } catch {
    hasHead = false;
  }

  if (hasHead) {
    await git.fetch('origin').catch(() => {});
    try {
      await git.checkout(branch);
    } catch {
      try {
        await git.checkout(['-b', branch]);
      } catch {
        /* empty repo */
      }
    }
    try {
      await git.reset(['--hard', `origin/${branch}`]);
    } catch {
      /* 원격에 브랜치 없음(첫 푸시 등) */
    }
  }

  const orphanName = `orphan_${Date.now()}`;
  await git.raw(['checkout', '--orphan', orphanName]);
  await git.raw(['clean', '-fdx']);

  const dest = path.join(repoPath, 'menu_today.png');
  await fs.copyFile(localImagePath, dest);

  await git.add('menu_today.png');
  await git.commit('Update menu');

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
  await page.goto('http://pf.kakao.com/_xdLzxgG', { waitUntil: 'load' });

  await page.waitForSelector('div.item_profile_head button.btn_thumb', {
    timeout: 60000,
  });
  await page.click('div.item_profile_head button.btn_thumb');

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const imageFileName = 'menu_today.png';
  const imagePath = path.resolve(process.cwd(), imageFileName);
  await page.screenshot({ path: imageFileName, fullPage: true });

  await browser.close();
  console.log('캡처 완료! 폴더를 확인해 보세요.');

  await ensureClone(remoteUrl, repoPath);
  await gitPushSingleMenuImage({
    repoPath,
    remoteUrl,
    branch: GITHUB_BRANCH,
    localImagePath: imagePath,
  });

  const date = todayDateKorea();
  const imageUrl = menuImageUrlWithCacheBust();
  await setDoc(
    doc(db, 'menus', FIRESTORE_MENU_DOC_ID),
    {
      imageUrl,
      date,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  console.log(`Firestore menus/${FIRESTORE_MENU_DOC_ID} 문서를 갱신했습니다. (date: ${date})`);
  console.log(`imageUrl: ${imageUrl}`);
})().catch((err) => {
  logErrorWithoutSecrets(err, process.env.GITHUB_TOKEN);
  process.exit(1);
});
