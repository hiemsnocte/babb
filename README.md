# babb

오늘의 급식 메뉴를 자동 캡처해 Firestore와 GitHub Pages에 반영하는 프로젝트입니다.

## 로컬에서 캡처 봇 실행 (자주 까먹을 때 여기만 보기)

1. **의존성 설치** (처음이거나 `package-lock.json`이 바뀐 뒤)

   ```bash
   npm ci
   ```

   또는

   ```bash
   npm install
   ```

2. **`.env` 파일**을 프로젝트 루트에 두고, `capture.js`가 요구하는 값을 채웁니다.  
   (`FIREBASE_*` 전부 + `GITHUB_TOKEN` — repo 쓰기 권한이 있는 PAT)

3. **캡처 실행** (이게 본 명령)

   ```bash
   node capture.js
   ```

4. **Chromium이 없다는 오류**가 나면 (선택)

   ```bash
   npx puppeteer browsers install chrome
   ```

   CI나 특정 환경에서는 `PUPPETEER_EXECUTABLE_PATH`로 브라우저 경로를 지정할 수 있습니다.

성공 시 로컬에 `menu_*.png`가 생기고, 원격 `menus` 브랜치와 Firestore `menus/current`가 갱신됩니다.

## 기타

- 정리 스크립트(이모지/댓글 일일 정리): `node cleanup.js` (같은 `.env`의 Firebase 변수 필요)
- 자동 실행: `.github/workflows/main.yml`(캡처·Pages), `cleanup.yml`(정리)
