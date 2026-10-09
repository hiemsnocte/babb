# 인터랙티브 버전 보관

메뉴 중심 최적화 전의 `public/index.html`, `public/script.js`를 그대로 보관합니다.
기준 커밋: `5ee0c88728acaea5b157e89e8f5bb4a7a4dbcfe5`.

- 핀볼 물리, 왕관 합체, 충돌·희생 및 묘지
- 투표 연속 클릭 콤보, 파괴 콤보와 메시지 효과
- 댓글 전광판과 투표 UI, 이미지 확대·비교 UI

이 폴더는 GitHub Pages 배포 대상(`public/`)에 포함되지 않습니다.
원본의 Firebase 연결 코드도 보존되어 있으므로 그대로 실행하면 운영 데이터에
연결됩니다. 다른 게임에 재사용할 때는 먼저 Firebase 연결을 테스트 프로젝트나
로컬 저장소로 교체하세요. 특히 `scheduleLivePersist`, `scheduleMergePersist`,
`scheduleSacrificePersist`, `persistCrownMergeReset`이 게임 결과를 기록합니다.

이 파일들은 완성된 독립 게임 라이브러리가 아니라 원형 보존본입니다.
새 화면은 이 코드를 import하지 않으며, `public/social.js`가 전광판·투표만 담당합니다.
