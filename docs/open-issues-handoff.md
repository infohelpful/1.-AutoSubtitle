# AutoSubtitle 데스크톱 — 미해결 문제 인계서

작성: 2026-10-11. 다음 개발자(GPT 등)가 바로 이어받을 수 있게 **재현 방법·측정값·의심 위치·검증 방법**을 함께 적었다.
확인되지 않은 것은 "미확인"으로 표시했다. 추측을 사실처럼 적지 않았다.

관련 문서: `docs/autosubtitle-desktop-sync-development-plan.md`(계획), `docs/autosubtitle-desktop-sync-progress.md`(진행 기록).

## 0. 먼저 알아둘 것

- 대상은 `E:\Develop Program\1. AutoSubtitle` Electron 앱이다(웹이 아님).
- 실제 앱 입력을 자동화하는 e2e 스크립트가 있다: `scripts/e2e-cdp/` (README 참고). **먼저 이걸로 재현**하고 고친 뒤 같은 스크립트로 확인할 것.
  - 재생 판정은 `document.querySelector('video').paused/currentTime` 이다(`audio` 요소는 쓰이지 않음, 실제 소리는 WebAudio `AudioBufferSourceNode`).
  - 앱은 `npm run build` 후 `electron . --remote-debugging-port=9333 --user-data-dir=<임시>` 로 별도 데이터 폴더에 띄운다(사용자의 실행 중인 앱을 건드리지 않음).
  - 영상 드롭은 `Input.dispatchDragEvent`(files) 로 실제 드롭 경로를 탄다. `window.api.sendVideoDropPath` 로 직접 보내면 렌더러 상태가 안 바뀌어 칩이 안 뜬다.
- 테스트: `npm test`(전체 vitest 255개, 실제 FFmpeg 통합은 `AUTOSUBTITLE_TEST_FFMPEG_DIR=tools\sync-validation-bin` 필요), Python: `.venv-alignment\Scripts\python.exe -B -m unittest discover -s python_sidecar/tests`.
- `tsconfig.web.json` 은 이 작업 이전부터 오류가 28개 있다(peaks.js 타입 등). 새 오류는 만들지 말 것. `tsconfig.node.json` 은 0개.
- 이 세션 커밋: `7c35b35`, `17464b1`, `5efaa63`, `c187b40`, `6910f7a`, `0ecee55`.

---

## 1. 사용자가 직접 보고한 문제 (우선순위 순)

### P0-1. "클릭하자마자 재생 버튼을 누르면 소리가 안 난다" — **미재현**

사용자 원문: "지금 클릭 하자마자 재생 버튼 누르니까 소리가 안나오네".

이 PC(Windows 11, RTX 4060 Ti)의 실앱에서 재현을 시도한 결과:

| 시도 | 결과 |
|---|---|
| 멈춘 상태 → 칩 클릭 → 재생 버튼/Space (지연 0~400ms) | 매번 재생됨. `AudioBufferSourceNode.start` 1회, 클릭한 칩 위치 offset, `AudioContext.state==='running'` |
| 클릭/재생버튼/Space/←/→ 를 무작위 2~4개 짧은 간격(0~180ms)으로 섞은 40회 | "video 는 재생 중인데 연결·미정지 상태의 오디오 소스가 0개 또는 2개 이상" 인 경우 **0건** |

해석과 다음 단계:

- **수정 전 빌드에서는** 클릭 직후 Space/재생이 조용히 버려져 *아예 재생이 시작되지 않았다*(P1 의 원인 1). 사용자가 아직 이전 빌드(또는 HMR 이 덜 반영된 dev 세션)를 쓰고 있었다면 "소리가 안 난다" 로 보였을 수 있다. 앱/`npm run dev` 를 완전히 재시작한 뒤 다시 확인 필요 — **미확인**.
- 재현이 안 되는 환경 차이 후보(모두 **미확인**): (a) 실제 오디오 출력 장치 전환·Bluetooth 지연, (b) 영상 로드 직후 WebAudio 마스터 버퍼가 아직 준비되지 않은 구간, (c) 긴 영상/큰 파일, (d) `AudioContext` 가 사용자 제스처 전에 `suspended`.
- 재현되면 확인할 로그: `%APPDATA%\autosubtitle\logs\waveform.log` 의 `startSyncedPlayback 진행 [diag-6]` 줄(`masterAudioPaused/ReadyState`, `targetAudioSec`)과 `[perf] playback session`. 이 줄이 **아예 없으면** 재생 요청이 앞단(디듑/가드/라우터)에서 버려진 것이다.
- 권장: 재생 시작 경로(`App.tsx startSyncedPlayback`, `timeline/webAudioMasterPlayback.ts`)에 "요청 무시됨" 사유를 항상 로그로 남기게 하고, 재생 중인데 오디오 소스가 없는 상태를 감지하면 경고를 띄운다. `scripts/e2e-cdp/` 에 오디오 소스 추적(`AudioBufferSourceNode.start/stop/connect/disconnect` 래핑)을 정식 스크립트로 올릴 것(이 세션의 임시 스크립트는 저장소에 넣지 않았다).

### P0-2. 재생 중에 칩을 클릭한 뒤 **화면의 재생 버튼**을 누르면 클릭한 칩이 아니라 예전 위치에서 재생 — **재현됨**

재현(실앱, 칩 5개 × 지연 0/50/150ms):

| 상황 | 결과 |
|---|---|
| 재생 중 → 칩 클릭 → 화면 재생 버튼 | **0/5** (매번 멈춘 옛 위치에서 이어 재생. 예: 목표 3.48s, 실제 1.72s) |
| 재생 중 → 칩 클릭 → Space | 5/5 |
| 멈춘 상태 → 칩 클릭 → 재생 버튼 / Space | 5/5 |

- Space 는 캐럿 핸들러가 `playAtCaret → seekAndPlayTo` 로 클릭 위치를 다시 지정하지만, **화면 재생 버튼은 `togglePlay` 가 `video.currentTime` 에서 시작**한다. 재생 중 클릭은 일시정지만 하고 플레이헤드를 칩으로 옮기지 않는 것으로 보인다(시크가 건너뛰어졌는지 큐로 밀렸는지는 **미확인**).
- 의심 위치: `src/renderer/src/App.tsx` `seekToSubtitleStart`(≈2540), `dispatchSeekIntent`(≈2620, `isPlaybackTransactionLocked` 시 큐잉), `togglePlay`(≈4388); `SubtitleVirtualList.tsx` 칩 `onClick`(`onWordBlockClick` 후 `onRequestPausePlayback`).
- 기대 동작: 재생 중이든 아니든 칩 클릭 = "그 칩 시작으로 이동(+일시정지)", 이후 어떤 재생 입력이든 그 위치에서 재생.
- 검증: 위 표의 12개 조합이 모두 N/N 이어야 한다.

### P1-1. 영상 드래그 앤 드롭이 안 됨 — **원인 추정(정황), 확정 아님**

- 코드 문제로 보이지 않았다(드롭 처리 `App.tsx onDrop`, preload `webUtils.getPathForFile`, main `video-drop-path` 는 정상 동작 — CDP 드롭으로 확인).
- 사용자 PC 의 개발 인스턴스(`npm run dev` node 와 electron)는 명령줄/실행경로를 일반 권한 프로세스에서 읽을 수 없었다 → **관리자 권한으로 실행된 것으로 추정**. Windows 는 관리자 권한 창에 일반 탐색기 드래그를 차단한다(UIPI). 드롭 오버레이도 안 뜬다.
- 개선 제안: 앱이 관리자 권한으로 떠 있으면(예: `process.getProcessMemoryInfo` 가 아니라 `net session`/토큰 확인) 드롭이 막힌다는 안내를 보여주고 "영상 열기" 버튼(파일 대화상자, 이미 있음)을 눈에 띄게 한다.

### P1-2. 자막 추출이 CPU 모드로 돈다 — **원인 미확정**

- 이 PC 는 RTX 4060 Ti + CUDA DLL(`%APPDATA%\autosubtitle\dll`) 이 있고, 앱과 같은 PATH 조건에서 사이드카가 `device=cuda float16` 로 정상 로드·전사했다(0.4s/짧은 음성).
- 재현된 폴백 경로: **CUDA DLL 폴더가 PATH 에 없으면 모델은 `cuda` 로 "로드"되지만 첫 전사에서 cublas 오류 → CPU 재로딩**. 사용자 앱에서 이 경로로 갔는지는 **미확인**.
- 화면 표시: 드롭 직후 `transcribeMode` 가 일단 `'cpu'` 로 초기화되고(`App.tsx` `setTranscribeMode('cpu')`) 모델 상태 확인이 끝나야 GPU 로 바뀐다. 로드가 느리면 "CPU모드…" 가 잠깐 보인다. 또 `onTranscribeComplete` 가 끝에서 다시 `'cpu'` 로 돌린다.
- 이미 추가됨: `main.log` 에 `모델 로드 장치=…`, `GPU 전사 중 오류로 CPU 로 전환됨` 이 남는다(`C:\Users\<user>\AppData\Roaming\autosubtitle\logs\main.log`). 사용자가 추출한 뒤 이 로그를 보면 바로 구분된다.
- `onTranscribeDiag(() => {})` 로 진단 메시지가 UI 에서 버려진다. 상태 표시줄 등에 노출할 것.
- `AUTOSUBTITLE_ALIGNMENT=accurate` 를 켜면 **단어 정렬 단계는 항상 CPU**(정렬 venv 의 torch 가 CPU 빌드)라 진행률이 80%대에서 오래 머문다. 이것도 "CPU 로 돈다" 로 보일 수 있다.

---

## 2. 키보드·마우스 편집 UX (실앱 CDP 로 재현·수정한 것과 남은 것)

### 이미 고친 것 (참고용, 회귀 테스트는 `scripts/e2e-cdp`)

- 클릭 직후 Space 재생 누락(`seekAndPlayTo` 하드 디듑이 직전 `seek` 에도 적용되던 것) — 멈춘 상태 3~4/7 → 7/7.
- 재생 중 클릭 시 재생 중이던 줄의 "멈춘 위치 캐럿 복귀" 동기화가 클릭 포커스를 덮어쓰던 것 — 0/7 → 7/7.
- 줄 끝 `→` 가 텍스트창으로 들어가 글자 단위로 이동하던 것 → 다음 줄 첫 칩.
- `↓` 칩 → 곧바로 이 카드의 편집창(칩이 줄바꿈돼도), 편집창 `↓` → 다음 자막 줄 칩, `↑` 반대. 문장 사이 무음(`--`) 카드는 상하 이동에서 건너뜀.
- 칩 사이에서 글자/IME 를 치면 그 위치에서 바로 편집창 입력.

### 남은 것

| # | 증상 | 상태 | 비고 |
|---|---|---|---|
| U1 | `Backspace`/`Delete` 가 글자가 아니라 **단어 하나를 통째로 삭제**(무음이면 오디오도 삭제) | 미변경 | `SubtitleVirtualList.tsx onCaretKeyDown`. Vrew 처럼 글자 단위 지우기를 원하면 정책 변경 필요(삭제=비파괴 tombstone 과의 관계 정리 필요) |
| U2 | 편집창에 친 글자가 **포커스를 잃을 때(blur)에야** 칩/단어에 반영 | 미확인 정도 | `textarea onBlur → updateSubtitleAt`. 입력 중 실시간 칩 반영/오디오 재정렬은 없음 |
| U3 | 재생 중 방향키는 "캐럿 기준 ±1" 이 아니라 **지금 말하는 단어로 스냅** | 의도로 보이나 혼란 | `caretIndexBeforePlayheadWord`. 재생 중 첫 방향키가 0→4번 칩으로 점프하는 것처럼 보임 |
| U4 | 칩 더블클릭 = 파형 열기. 칩 자체를 인라인 편집하지 않음 | 설계 | Vrew 처럼 단어 인라인 편집이 필요하면 별도 설계 |
| U5 | 한글 IME **조합 중** 방향키·Enter, 칩 더블클릭(파형 경로)에서의 키보드 조합 | **미검증** | 영문/IME 확정 입력만 확인함 |
| U6 | `↑/↓` 후 편집창에서 바로 Space 를 치면 공백 입력(정상)이지만 재생하려면 포커스를 칩으로 되돌려야 함 | 설계 | 필요하면 `Ctrl+Space` 등 별도 재생 키 |

---

## 3. 싱크 정확도·정렬 (계획서 2~3단계)

- accurate 모드는 **환경변수로만** 켠다: `AUTOSUBTITLE_ALIGNMENT=accurate`, `AUTOSUBTITLE_ALIGN_PYTHON=<.venv-alignment\Scripts\python.exe>`. **설치본에는 정렬 런타임·모델(≈1.2GB)이 없다.** UI 옵션 없음.
- 측정은 **합성 음성(SAPI Heami) 8문장 66단어뿐**: 문장 첫 단어 시작−실제 소리 시작, Whisper/현재 RMS 중앙값 −120ms, WhisperX +8ms(−29~+36). SAPI 이벤트 자체가 소리보다 15~80ms 빨라 단어별 오차는 신뢰도가 낮다. **사람 목소리·잡음·음악·겹말·빠른 구어는 미측정.** 재현: `scripts/alignment-tts-bench.{ps1,py}`.
- 필요한 것: 실제 한국어 영상 20클립/30분/1,000경계 이상의 수동 라벨(계획서 §14). 라벨이 있으면 `scripts/alignment-poc.py --labels` 로 coverage/median/p95 를 바로 낼 수 있다.
- 알려진 한계: 오디오 시작 PTS 가 0 이 아닌 파일은 Whisper 시간축과 정렬 시간축이 어긋날 수 있음(`source_origin_sec` 를 사이드카가 모름). 정렬 모델은 CPU 만 시도(GPU 미시도). 30초 초과 세그먼트는 정렬하지 않고 `unaligned`.
- 단어 수가 바뀌는 편집(분할/합치기)은 `vrewRowsToSubtitleLines` 전면 교체 경로라 그 줄의 정렬 메타데이터가 사라진다(오표시는 아님: 상태 없음=estimated). ID 기반 매칭 미구현.
- 미구현: `realign_words` RPC(텍스트 수정 후 부분 재정렬), 프로젝트 v2(`.autosub` 은 version 1 그대로), 정렬 취소, 설치본 패키징(`bundle-sidecar.cjs`, `main.spec`).

## 4. 내보내기 (계획서 5단계)

- 구현됨: 컷 A/V 동시 편집, 30fps CFR, 단어 강조 버닝(체크박스, 기본 꺼짐), 메모리 제한 캡처 풀, 취소/타임아웃/임시 출력 검증.
- **앱 UI 에서 "단어 강조" 내보내기를 끝까지 눌러 본 검증은 없다**(단위·FFmpeg 통합·Electron offscreen 렌더만 확인).
- 미검증: 줄바꿈 2줄 자막의 단어 강조, 폰트 fallback, DPI 100~200%, 4K, 회전/SAR, 전체 decode 검증(현재는 앞 1초만 decode).
- SRT/VTT/ASS/TXT 와 오디오 단독 내보내기는 단어 강조 미지원.
- 설치본(`npm run dist`)에서의 오프스크린 렌더·FFmpeg 경로 미검증.

## 5. 저장소 위생

- `python_sidecar/__pycache__/main.cpython-314.pyc` 가 **추적 중**이고 실행마다 바뀐다. `git rm --cached` 하고 `.gitignore` 의 `__pycache__/` 로 관리할 것(이 세션에서는 사용자 기존 변경 보존을 위해 커밋하지 않고 그대로 둠).
- `tools/sync-validation-bin`(ffmpeg/ffprobe), `tools/sync-validation-output`, `.venv-alignment` 는 `.gitignore` 처리됨(로컬 전용).
- `.venv-alignment` 의 PyAV 가 faster-whisper 로더와 맞지 않는다(PoC venv 한정). 벤치 스크립트는 FFmpeg 로 직접 디코드해서 우회한다.

## 6. 이어서 할 때 권장 순서

1. P0-2(재생 중 클릭 후 화면 재생 버튼) 수정 + `click-then-space.mjs` 를 "화면 버튼" 변형까지 확장해 회귀 고정.
2. P0-1: 사용자 PC 에서 앱 완전 재시작 후 재확인. 재현되면 `waveform.log` 의 `startSyncedPlayback` 줄과 오디오 소스 추적 결과를 확보. 재생 무시 사유 로깅 추가.
3. P1-1/P1-2: 관리자 권한 안내, 진단 메시지 UI 노출.
4. 실제 한국어 영상 + 수동 라벨 확보 후 정렬 정확도 측정 → accurate 기본값/설치본 포함 여부 결정.
5. U1/U2(편집 정책) 은 사용자와 정책부터 합의.
