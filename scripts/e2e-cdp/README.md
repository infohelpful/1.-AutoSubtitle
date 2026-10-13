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
- `drop-video.mjs <영상> [결과 JSON 경로] --fast`는 준비가 완료된 앱에서 빠른 싱크 모드를 선택하고 결과 엔진이 RMS인지 확인한다.

추가 미디어/export 검증:

- `electron scripts/e2e-cdp/export-layout.cjs`: build 후 단독 실행. 실제 offscreen 렌더러에서 4K/세로/작은 캔버스의 원본 픽셀 배치와 BGRA 크기를 검사한다. `--force-device-scale-factor=2`로 200% DPI도 검사할 수 있다.
- `source-clock.mjs`: `launch-test-app.cjs`에서 3초 PTS5/audio+0.5초 fixture 프로젝트를 제공한다. 브라우저 원점, WebAudio의 앞 무음, 실제 영상 export를 확인한다.
- `export-layout-ui.mjs`: 파일 선택 큐에 4K 프로젝트, 720×480/SAR8:9/90도 프로젝트 순으로 제공한다. 4K export 후 SAR 미리보기 크기를 검사한다. `--sar-only`는 SAR 프로젝트 하나를 제공하고 실제 export까지 검사한다.
- `export-audio.mjs [출력 WAV 경로]`: 2초 프로젝트의 cuts를 `[4801/48000,9603/48000]`, `[16003/48000,19207/48000]`로 준비하고 실제 WAV 내보내기 PCM을 비교한다. 기본 출력은 `tools/sync-validation-output/audio-ui-cut-export_AutoSubtitle.wav`.
- `audio-fallback.mjs`: 10초 이상 발화 프로젝트를 불러온다. WebAudio start 오류를 주입해 HTML 음소거 해제/UI 재생 상태, 정지, WebAudio 재시도, 지연된 fallback 취소를 확인한다. 실제 스피커 청취 검사는 아니다.
- `prepare-cancel.mjs [영상 경로]`: 아직 캐시되지 않은 긴 영상의 준비 IPC 취소/같은 원본 재시도를 검사한다. 작은 fixture는 FFmpeg `-f lavfi -i color=blue:s=64x64:r=1/60:d=600 -c:v libx264 -an`으로 만들 수 있다. 재시도에서 600초 PCM 약 115MB를 생성한다. 재실행에는 새로운 원본 경로를 사용한다.
- `korean-composition.mjs`: 로드된 발화 프로젝트에서 Chromium `imeSetComposition`으로 한글 조합/확정/취소, 한 번의 Undo, 3,000자 붙여넣기/복구를 검사한다. Windows IME 후보 창/키보드 레이아웃의 수동 검증을 대체하지 않는다.
- `realign-selected.mjs [저장 프로젝트 경로]`: `reading-fixture.autosub`(3배가 있는 마지막 줄)와 새 `AUTOSUBTITLE_E2E_SAVE_PROJECT`를 제공한다. 실제 모델로 단일·비연속 복수 단어 정렬, 비선택 단어 보존, 저장·Undo/Redo를 확인한다. 저장 경로 뒤 `.png`로 선택 패널 캡처도 남긴다.
- `launch-test-app.cjs`는 `AUTOSUBTITLE_E2E_PROJECT`, `AUTOSUBTITLE_E2E_OUTPUT` 절대경로를 요구한다. 선택 큐는 `AUTOSUBTITLE_E2E_OPEN_QUEUE` JSON 배열이다. 경로는 `tools/sync-validation-output` 내부에 두고 출력은 기존 파일과 겹치지 않는 새 이름으로 지정한다. 테스트 fixture와 큰 결과 파일은 git에서 제외되어 있다.

구간 PCM 재생/작업 취소 검증:

- `stream-playback.mjs [--tail]`: 23초 이상의 프로젝트를 launcher로 제공한다. 22초 재생 중 전체 decodeAudioData 미호출, 실제 노드의 source clock/영상 오차 250ms 이내, 보유 AudioBuffer 18초 이내, 정지 후 버퍼 해제를 검사한다. `--tail`은 1780초 단어칩이 있는 30분 프로젝트를 요구하고 끝부분 탐색도 검사한다. 컷이 6초 블록 경계에 걸리는 프로젝트로 반복하면 연결 경계도 검사할 수 있다.
- `cancel-transcription.mjs [긴 영상 경로]`: 기본은 `tools/sync-validation-output/stream-30min.mp4`. 영상 드롭 후 2.5초에 취소 버튼을 눌러 모달 종료·늦은 완료 없음·worker 재시작을 검사한다. 당시 작업이 모델 준비/PCM 준비/인식 중 어느 단계인지는 이 테스트만으로 구분하지 않는다. 이후 `drop-video.mjs`로 짧은 한국어 영상을 추출해 실제 재시도를 검증한다.
- `cancel-waveform.mjs [긴 영상 경로] [취소 지연 ms]`: 짧은 영상 추출로 ASR 모델이 로드된 상태에서 실행한다. 파형 취소/재시도, 오래된 취소 ID 무시, ASR 모델 유지 및 work 파일 정리를 검사한다. 기본 지연 100ms는 준비 단계, 이 PC에서 500ms는 worker 단계 취소를 확인했다(컴퓨터별 속도에 따라 달라질 수 있음).
- 30분 fixture는 64×64/1fps 단색 영상+48kHz 440Hz AAC로 만들었다. canonical PCM은 약 345MB다. 테스트는 시작 22초와 끝부분 탐색이며 전체 30분 재생/실제 스피커 청취/단어 경계 정확도 평가는 아니다.

캐시/메모리/패키징 추가 검사:

- `node scripts/e2e-cdp/cache-startup.mjs`: build 후 실행. 포트 9334의 새 격리 프로필을 생성하고 시작 시 오래된 캐시/work 정리·무관한 파일 보존·중복 앱 종료·활성 캐시 보존을 확인한 뒤 종료한다. `real-video-fixture.autosub`가 필요하다. 용량/LRU·변경 감지·링크 제외는 `mediaCacheRetention.test.ts`의 작은 파일 예산으로 검사한다.
- `python -B scripts/rms-stream-bench.py --media <영상> --ffmpeg <실행 파일>`: 모델 없이 RMS 전체 길이를 블록 처리하고 frame/kernel 크기·추적 메모리를 출력한다. 짧은 fixture에만 `--compare`를 추가하면 이전 전체 오디오 mask와 비교한다. 추적 수치는 앱/모델/FFmpeg 전체 RSS가 아니다.
- `scripts/frozen-sidecar-smoke.py`: 실제 패키징된 helper에서 로컬 모델을 사용한 전사/파형/빠른 보정/선택적인 외부 정밀 정렬을 검증한다. 인자/환경/한계는 `docs/sidecar-packaging.md` 참조.
