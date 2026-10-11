# AutoSubtitle 데스크톱 — 미해결 문제 인계서

## 2026-10-12 새벽 재개 결과 (최신)

HEAD `951990b`에서 이전 미커밋 변경을 보존하고 이어서 작업했다. 아래 이전 절의 미완료 목록 중 **프로젝트 v2, 발음 입력 UI, 긴 줄 분할, 수정 문장 어절 재분할**을 이번에 진행했다.

### 완료·검증

- **프로젝트 v2 / v1 migration**: v1 시간은 그대로 유지하고 상태 없는 단어만 estimated/legacy_project로 가져온다. 기존 v1 확장에 저장된 aligned/manual 메타는 보존한다. 열기만 해서는 재정렬·파일 덮어쓰기를 하지 않는다. 신규/중복 발화 ID를 편집 진입점에서 보완하며, 재분할 자식은 parentWordId를 보존한다.
- 저장 왕복에서 빈 글자 슬롯, 줄/단어 tombstone, mergedByEdgeTrim, splitChain, 수동 lock, 정렬 문자·발음 map, 단어 강조 활성/색상 보존. 이전 parser가 빈 슬롯과 편집 플래그를 버리던 경로 수정. 잘못된 자막/컷/타임라인을 조용히 누락시키지 않고 열기를 거부한다.
- **원본 전체 SHA-256**: 새 영상 선택 시 식별 계산을 시작하고 프로젝트에 저장한다. v2를 열 때 원본 내용 비교, 불일치/누락이면 자막·컷을 보존한 채 영상 재생/정렬/내보내기를 보류한다. `원본 영상 연결`에서 동일 내용의 이동된 파일을 허용한다. 기존 v1에는 비교 근거가 없음을 안내하고 현재 파일을 기준으로 삼는다. 파일을 연 뒤 외부에서 바뀌는 상황을 계속 감시하는 기능은 아니다.
- **저장 안전성**: JSON 검증 → 같은 폴더 임시 파일 → flush → rename. 실패 시 이전 프로젝트를 보존하고 임시 파일 정리. 새 영상을 드롭할 때 이전 프로젝트 저장 경로를 해제한다.
- 실앱 테스트에서 발견한 추가 오류: `videoPath=null`이면 자막/컷도 초기화하던 effect를 수정했다. 원본 연결 보류 상태에서도 편집 데이터가 남는다.
- **발음 입력**: 현재 줄에서 단어를 선택하고 실제 읽기를 지정/초기화한다. 자막 표기/시간/ID는 유지하며 stale 처리. 해당 줄 정렬 버튼 연결. 작은 창에서도 입력 패널 버튼에 접근할 수 있게 위치/스크롤 조정.
- 발음·lock·품질 등 메타데이터만 달라지면 편집을 무시하던 비교 함수를 수정했다. 정렬 결과의 시간이 같아도 품질 변경을 적용하고 Undo/Redo에 남긴다. 실패한 재정렬이 이전 charSpans를 되살리던 merge도 수정했다.
- **수정 문장 어절 분할**: 재정렬 요청에서 공백으로 분리한 자식에 ID를 부여한다. 실제 측정 시간이 모두 확보된 경우에만 원래 슬롯을 자식들로 교체한다. 일부 미정렬/역전이면 원래 문구와 시간을 유지하고 retokenization_unaligned 사유를 남긴다. 수동 시작 lock은 첫 자식, 끝 lock은 마지막 자식에 유지. 전체 슬롯의 명시적 발음 override가 있으면 임의로 쪼개지 않는다.
- **30초 초과 줄**: ASR 단어 시간 기준 최대 24초 core + 인접 단어 overlap, 모델 입력은 최대 30초. 단어당 core 출력 1회. overlap 추정 차이가 200ms 초과하거나 연결 순서가 뒤집히면 chunk_boundary_conflict로 원래 시간 복원. 긴 단일 슬롯/잘못된 시간 anchor는 여전히 미정렬로 남긴다. VAD 기반 장시간 파일 스트리밍은 아니다.
- **최초 추출 정밀도 UI**: `추출 싱크`에서 정밀 정렬/빠른 추정을 선택하고 설정을 유지한다. 기본은 정밀. 개발 환경 `.venv-alignment` 자동 탐색을 최초 전사에도 연결했다. runtime 부재/한국어 외 전사는 사유를 남기고 RMS 추정으로 fallback한다. 배포용 정렬 runtime 자동 설치는 아직 없다.

### 측정 결과와 재현

- 전체 Vitest **43 files / 287 tests**, Python **31 tests**, web/node 타입 검사 0 errors, production build, diff 공백 검사 통과.
- `project-roundtrip.mjs 2`: v1 열기 → 글자 전체 삭제 → v2 저장/재열기 → 재입력, ID/시간/강조 설정 보존. 다른 영상 차단 → 잘못된 재연결 거부 → 동일 원본 복사본 연결, 누락 원본 재연결 통과. 데이터 손실 effect를 찾은 뒤 재실행했다.
- `reading-and-retokenize.mjs`: 실제 영상 마지막 줄의 `3배`에 테스트 읽기 `세배` 입력 → 메타만 변경된 Undo/Redo → 실제 WhisperX 정렬 → 표시 3배 유지 확인. 이어 문장 전체 삭제/재입력 → 실제 측정 어절 분할 → 저장 JSON 기준 전체 Undo/Redo 동일성 통과. 사람 청취 정답으로 발음을 확정한 테스트는 아니다.
- `validate-long-alignment.py`: 기존 raw 128단어를 63.86초 한 줄로 합쳐 3개 window로 분석. 단어 ID/문자/개수 보존. **121 aligned / 7 unaligned**, 그중 `스넥크래프트입니다.` 1개는 chunk_boundary_conflict. 정렬된 비율은 정확도 수치가 아니다.
- 최초 추출 E2E: 정렬 관련 환경변수를 비운 일반 Electron에 실제 영상을 drag/drop. UI 기본 accurate → requested/applied 모두 whisperx, CPU **40,083ms**, **122/128 aligned, 6 unaligned, reviewWords 8**. 원본 영상은 변경하지 않았다.
- 결과(모두 git 제외): `tools/sync-validation-output/project-v2-e2e-2.autosub`, `reading-result-2.autosub`, `real-video-long-alignment.json`, `real-video-accurate-ui-default.json`, `resume-final-vitest.log`, `resume-final-build.log`.
- 프로젝트 E2E launcher: `AUTOSUBTITLE_E2E_SAVE_PROJECT`는 새 `.autosub` 출력, `AUTOSUBTITLE_E2E_OPEN_QUEUE`는 대화상자 선택 경로 JSON 배열. project-roundtrip 순서: legacy fixture, saved project, project-mismatch.autosub, project-wrong.mp4, project-copy.mp4, project-missing.autosub, project-copy.mp4. 모두 `tools/sync-validation-output` 내부다. `reading-and-retokenize.mjs`는 `3배`가 있는 마지막 줄만 넣은 `reading-fixture.autosub`와 새로운 저장 출력이 필요하다. 기존 출력 덮어쓰기를 막으므로 재실행 시 새 파일명을 쓴다.

### 다음 작업 (미완료)

1. 모델 사전 미지원 `캡`/`둡` 해결 및 한국어 모델 후보 비교. 발음 UI는 존재하지만 유사 음절로 임의 대체하는 해결은 하지 않았다. 사람 정답 기준 median/p95·CER/WER, 20 clips/30분/1,000 boundaries 합격 기준 미달.
2. 최초 전사·RMS·waveform·WebAudio의 **nonzero A/V PTS 공통 원점**. 현재 부분 정렬/내보내기는 probe 원점을 쓰지만 나머지는 디코더 기준이 달라질 수 있다. 사용자 테스트 영상의 원점은 0이므로 이 문제 검증을 대신하지 않는다.
3. 긴 파일 오디오 스트리밍/취소 부하, 긴 단일 편집 슬롯과 잘못된 ASR anchor 처리, 임의 word-ID 선택 정렬. 현재는 줄 단위 UI이며 전체 오디오를 한 번 decode한다.
4. 설치본 alignment runtime/model 다운로드·의존성·GPU/오프라인 새 설치 검증. 개발 `.venv-alignment` 자동 탐색은 배포 완료가 아니다.
5. 4K/SAR/회전/DPI/멀티라인·컷을 포함한 실제 UI export 픽셀/음성 비교, 실제 Windows 한글 IME·장문 성능, 전체 ID 수명/저장/undo의 모든 편집 조합. 이번 테스트는 구체적 저장·재분할 경로까지 검증한 것이다.

작업은 로컬 미커밋 상태이며 배포하지 않았다. 기존 pyc 변경은 그대로 보존했다. 사용량 잔여가 낮아 새 범위를 시작하지 않고 현 작업 검증·기록을 마무리했다. reset credit은 사용하지 않았다.

---

## 2026-10-11 저녁 재개 결과 (최신)

이번 재개 기준 HEAD는 `951990b`이다. 아래 이전 인계의 일부 미완료 항목을 다음과 같이 진행했다.

### 완료·검증

- **부분 재정렬 IPC/UI**: `realign_words`, `alignment:realign/cancel`, preload 타입, `현재 줄 싱크 재정렬`/`정렬 취소` 버튼 연결. 펼친 파형 줄 또는 재생 헤드의 현재 줄을 대상으로 한다. ASR 모델을 재전사하지 않는 별도 sidecar/worker를 사용한다.
- 요청 ID·영상 ID·revision·자막 snapshot을 검증한다. 응답 대기 중 수정/영상 전환 시 적용하지 않는다. 한 번의 undo transaction으로 적용하며 수동 경계·기존 단어 ID·무음/삭제 슬롯을 보존한다. worker의 단어 수/문자/ID/유효 시간/수동 경계도 검증한다.
- **취소/timeout**: PythonSidecar가 Promise만 종료하던 경로를 수정. Windows `taskkill /PID <앱이 생성한 PID> /T /F`, POSIX process group 종료로 자식 정렬/FFmpeg까지 종료한다. 대기열 취소와 이전 프로세스의 늦은 close 이벤트 차단. 실제 child PID 종료 테스트 통과.
- **숫자 발음 대응**: `alignment_text.py`에서 표시 문자열↔발음 문자열 범위 매핑. `1초만에→일초만에`, `5종을→오종을`을 실제 모델로 확인했다. 숫자 카운터·날짜·식별자·`3배`처럼 모호한 읽기는 추정하지 않는다. 읽기 override는 RPC 데이터 계약만 지원하며 별도 입력 UI는 아직 없다.
- 정렬 문자 구간/표기 매핑을 TypeScript parser와 단어 메타에 보존. 글자 수정 시 이전 charSpans/map/발음은 무효화한다. 수동 경계와 모델 source 추정치를 분리하도록 Python 보완.
- **내보내기**: 처음 1초 검사 → 전체 A/V decode 검사로 변경. 비동기·취소·timeout 지원. 처음 1초는 정상인데 뒤가 손상된 파일로 회귀 검증. 완료/실패 메시지를 앱 화면에 표시한다.
- **추가 편집 오류**: 문장 전체 삭제→재입력 시 칩이 되살아나지 않던 경우 수정. 기존 source 슬롯/오디오 시간을 보존한다.

### 실제 영상 검증

- 기존 raw 전사문으로 오프라인 WhisperX 재검사: **128개 중 122개 aligned, 6개 unaligned, coverage 95.3125%**. 이전 120/128에서 숫자 2개 개선. 숫자 정규화 2개는 사유를 남겨 reviewWords는 8개다. 사람 정답 기준 정확도는 여전히 미측정이다.
- 미정렬 사전 원인: `캡쳐…`는 **‘캡’이 모델 사전에 없음**(‘쳐’는 있음), `모아둡니다`는 ‘둡’ 미지원. 비슷한 음절로 임의 대체하지 않았다. `3배`는 읽기 모호성+숫자 미지원.
- `realign-and-export.mjs`: 취소 → 정렬 중 텍스트 편집 → 오래된 응답 폐기 → 텍스트 Undo → 정상 재정렬 → 단어 강조 영상 내보내기 모두 통과. `realign-undo.mjs`로 정렬 전체 Undo/Redo도 통과.
- 파일 선택 대화상자 결과만 테스트 fixture/output으로 고정했다. 실제 renderer 버튼·preload·main·Python worker·offscreen 렌더·FFmpeg 경로를 사용했다. 원본 영상은 수정하지 않았다.
- 출력 `tools/sync-validation-output/real-ui-export-2_AutoSubtitle.mp4`: H264 1920×1080, AAC 48kHz, **64.266667초**, 전체 decode 통과. 첫 출력의 0.5초 캡처에서 ‘자료를’ 노란 강조를 육안 확인 (`real-ui-frame.png`). 전 구간 자막 정확도 수동 검증은 아니다.
- 결과 JSON `real-video-normalized.json`, E2E 로그 `realign-export-e2e-final.log`, 전체 검사 `continue-*-final.log` (모두 tools/sync-validation-output, git 제외).
- 최종 자동 검사: Vitest 39 files/273 tests, Python 25 tests, web/node 타입 및 build 통과.
- E2E 재현: build 후 `AUTOSUBTITLE_E2E_PROJECT`를 fixture `.autosub` 절대경로, `AUTOSUBTITLE_E2E_OUTPUT`을 존재하지 않는 output `.mp4` 절대경로로 설정한다. 둘 다 `tools/sync-validation-output` 내부여야 한다. Electron 진입점을 `scripts/e2e-cdp/launch-test-app.cjs`로, 포트를 9333으로, user-data-dir을 별도 테스트 폴더로 실행한 뒤 `node scripts/e2e-cdp/realign-and-export.mjs`, 이어서 `node scripts/e2e-cdp/realign-undo.mjs`를 실행한다. 결과 이름에는 앱이 `_AutoSubtitle`을 덧붙인다. 기존 출력은 덮어쓰지 않는 새 이름을 사용한다.

### 남은 우선 작업

1. 사전 미지원 한국어 음절·모호한 숫자를 처리할 모델/읽기 입력 UI, 사람이 표기한 경계로 median/p95·CER/WER 측정.
2. 현재는 **줄 단위·기존 단어 슬롯 재정렬**이다. 새 문장 어절 재분할, 임의 word-ID 선택, 30초 초과 chunk/overlap 미완료.
3. 프로젝트 v2·v1 migration·미디어 fingerprint, 전체 ID 수명/저장/undo 검증. char/map은 기존 v1 필드 확장으로 보존하지만 v2 구현은 아니다.
4. 최초 전사 경로의 nonzero A/V PTS·RMS·waveform 공통 원점 처리. 이번 부분 재정렬에는 probe의 sourceOriginSec을 전달했다.
5. 설치본 정렬 runtime 배포/의존성/모델 다운로드 UI·GPU·오프라인 새 설치. 개발 중에는 환경변수 또는 `.venv-alignment`를 사용한다.
6. 4K/SAR/회전/DPI/멀티라인·컷 포함 실앱 export 픽셀/음성 비교, 실제 Windows 한글 IME·긴 문장 성능. 기존 36조합 재생 회귀 검증 기록은 이전 절 참조.

변경은 로컬 저장이며 이번 재개 변경은 아직 커밋/배포하지 않았다. 기존 pyc 변경을 보존했고 reset credit은 사용하지 않았다.

---

## 2026-10-11 Codex 재점검 갱신 (아래 최초 인계보다 우선)

- P0-1/2 수정: 클릭 시 정지→이동을 한 경로로 처리. 캐럿 포커스를 다음 프레임까지 미루어 즉시 Space가 이전 단어로 전달되던 문제 수정. 오래된 decode/resume/seek 완료와 pause 이벤트가 새 재생을 덮어쓰지 않게 요청 세대 검사 추가.
- 합성 음성과 사용자 영상 각각 정지/재생 중 × 화면 버튼/Space × 0/50/150ms × 3단어, **36/36 통과**. 실제 WebAudio 활성 소스 1개 및 video/audio 차이 <250ms 검사. 정확한 단어 경계 품질 측정과는 구분한다.
- P1-1: 사용자 영상을 실제 CDP drag/drop으로 성공시켰다. 기존 사용자 인스턴스의 관리자 권한/UIPI 차이는 미확인.
- P1-2 수정: 준비 중 CPU로 단정하는 문구 제거, 장치·진단 표시, GPU→CPU 전환을 처리 도중 IPC로 전달. lazy segment iteration CUDA 오류도 부분 결과를 폐기하고 CPU 재시도. 실제 격리 프로필에서 GPU runtime 실패→CPU 안내 확인. 기본 프로필 GPU DLL 검증은 남음.
- U1: 사용자가 **글자 단위 삭제** 선택. 발화 칩 경계의 Backspace/Delete는 한 grapheme 삭제 후 textarea 문자 커서로 전환. 선택한 단어 범위/무음 블록 삭제는 기존 미디어 편집 유지.
- U2 수정: textarea 변경을 칩에 즉시 반영. IME 조합 중 draft, compositionend에 반영. 시간/ID 보존, aligned 텍스트 수정은 stale 처리. 새 문구의 정확한 단어별 시간은 재정렬 전까지 보장하지 않음.
- 추가 수정: SentenceTokenTimeline 참조 캐시를 통하지 않는 변환에서 정렬 메타데이터·edge-merge 플래그 손실. 명시적 보존과 JSON clone round-trip 테스트 추가.
- 기존 renderer TypeScript 오류 28개 → **0개**. shared 경로, React 19 JSX/이벤트/행 컴포넌트, 브라우저 타이머, nullable waveform, Peaks 이벤트/타입 정리.
- 최종 검증: Vitest **36 files /264 tests**, Python **17 tests**, web/node 타입 검사·production build 통과. 기존 pyc 변경 보존. 커밋/배포하지 않음.

### 실영상 정렬 결과

- 제공받은 `Rec 0001.mp4`: 1920×1080, AAC 48kHz, 64.266초, video/audio start PTS=0.
- 격리 앱에서 accurate 환경변수 + `.venv-alignment/Scripts/python.exe`로 전사→WhisperX→편집 화면 완료. CPU fallback 포함 67.721초.
- 128단어 중 aligned 120, unaligned 8 (**coverage 93.75%**). 정확도가 93.75%라는 의미가 아니다.
- 미정렬: `캡쳐를` 2회, `캡쳐된`, `모아둡니다`, `캡쳐들은`, `1초만에`, `5종을`, `3배` — unsupported_character. 표기·숫자 정규화와 원문 대응 보완 필요. 임의로 aligned 처리하지 않았다.
- 사람 정답 경계가 없어 median/p95 오차, CER/WER는 미측정. 20 clips/30분/1,000 boundaries 합격 기준 미달.
- 결과: `tools/sync-validation-output/real-video-accurate.json`, `real-video-accurate-drop.log`, `real-click-play.log`, `click-play-after2.log` (git 제외).

### 다음 작업 (미완료)

1. 실영상 미지원 음절/숫자 정규화, 재정렬 RPC, 새 텍스트의 단어 분할과 정확한 경계. 지금은 기존 구간에 수정 라벨을 보존한다.
2. 실제 한글 IME·Undo/Redo 반복·장문 성능 검증. 기존 U3/U4/U6의 의도한 동작 여부 검토.
3. 프로젝트 v2, worker 취소·오래된 IPC 응답 차단, 30초 초과 정렬 chunk, nonzero source PTS 전달.
4. 실제 UI 편집→단어 강조 export, 전체 decode, 4K/SAR/회전/DPI/줄바꿈 비교, Windows 설치본·GPU 검증.

---

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
