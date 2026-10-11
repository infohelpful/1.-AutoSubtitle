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
node scripts/e2e-cdp/click-then-play.mjs       # 실제 0ms 포함 버튼/Space 36조합, 출력 소스/clock 검사
node scripts/e2e-cdp/character-edit.mjs        # 글자 삭제·textarea focus·blur 이전 칩 갱신 (테스트 데이터 변경)
```

- 테스트 영상은 말이 있는 짧은 mp4 면 된다(8~20초, 자막 4줄 이상). 한국어 합성음성은 `scripts/alignment-tts-bench.ps1` 로 만들 수 있다.
- 재생 영상은 `video.paused/currentTime`, 실제 출력은 WebAudio BufferSource의 연결·정지·스케줄 시간으로 검사한다. clock 허용 오차는 250ms이며 음성 인식 경계 정확도 평가는 아니다.
- `drop-video.mjs <영상> [결과 JSON 경로]`는 새 추출 완료 이벤트와 모달 종료를 기다린다. 이전 영상의 칩을 성공으로 오인하지 않는다.
