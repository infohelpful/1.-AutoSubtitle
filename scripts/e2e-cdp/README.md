# 실제 앱 키보드·마우스 e2e (Chrome DevTools Protocol)

빌드된 Electron 앱(`npm run build`)을 원격 디버깅 포트로 띄우고 실제 입력 이벤트를 넣어 칩 편집/재생 조합을 검증한다.
Node 22+ (전역 `WebSocket`) 필요. 사용자의 실행 중인 앱과 겹치지 않게 별도 `--user-data-dir` 을 쓴다.

```powershell
npm run build
electron . --remote-debugging-port=9333 --user-data-dir=<임시폴더>      # 앱 실행
node scripts/e2e-cdp/drop-video.mjs "<절대경로>\test.mp4"                # 영상 드롭 → 전사 → 칩 표시까지 대기
node scripts/e2e-cdp/click-then-space.mjs     # 칩 클릭 직후 Space 재생 (멈춤/재생 중, 지연 0~300ms)
node scripts/e2e-cdp/mouse-keyboard-combo.mjs # 클릭+방향키+Space, 연속 클릭, 편집창 Space
node scripts/e2e-cdp/vertical-navigation.mjs  # ↑/↓ 칩 ↔ 편집창 ↔ 다음 줄
```

- 테스트 영상은 말이 있는 짧은 mp4 면 된다(8~20초, 자막 4줄 이상). 한국어 합성음성은 `scripts/alignment-tts-bench.ps1` 로 만들 수 있다.
- 재생 여부는 `video.paused/currentTime` 으로 판정한다(재생은 `video` 요소가 담당하고 `audio` 요소는 쓰이지 않는다).
