# AutoSubtitle 데스크톱 — 단어칩·음성 싱크·자막 버닝 개발 수정계획서

> 2026-10-12 15시 갱신: WebAudio 실패 시 HTML 무음/UI 상태·취소 후 재시작·부분 오디오 소스 누수를 수정했다. 영상 준비 소비자별 취소, WebAudio 중복 fetch/decode 공유·이전 fetch 취소·불필요한 WAV 복사 제거를 적용했다. 발음 패널에서 단일/복수 단어 ID 선택 정렬을 추가하고 비선택 단어 보존·저장·Undo/Redo를 실제 WhisperX로 검증했다. Chromium 한글 조합/취소/3,000자 입력도 통과. 최종 Vitest 48 files/312 tests 및 타입·build 통과. 전체 계획은 미완료이며 정확도 사람 평가·미지원 음절·장시간 스트리밍/캐시 용량·설치본 runtime·실제 Windows IME 검증이 남았다. 아래 과거 상태보다 진행 기록/인계서의 최신 절을 우선한다.

> 2026-10-12 오후 갱신: SAR/90도 회전의 미리보기·export 표시 크기와 4K 원본 픽셀 자막 배치를 수정했다. 실제 4K·SAR UI export 및 기본/200% DPI offscreen 다중 줄 검증 통과. 오디오 export의 sample 단위 컷·임시 출력·전체 decode·취소/timeout 보호까지 구현했다. Vitest 301개 통과. 남은 핵심은 미지원 음절/사람 경계 평가·장시간 스트리밍·설치본 runtime·실제 IME이며 상세는 진행 기록/인계서 최신 절 참조.

> 2026-10-12 오전 갱신: nonzero PTS 공통 PCM·영상 remux를 최초 ASR/RMS/정렬·부분 재정렬·파형·WebAudio·오디오 export에 연결했다. 실제 오디오 +0.5초 파일의 전사·재생·영상 export를 검증했고 탐색 완료 전 재생 경합도 수정했다. Vitest 295/Python 32, 실앱 재생 조합 36/36 통과. 사람 라벨 평가·미지원 음절·장시간 스트리밍·설치본 runtime 및 SAR/회전/4K/IME는 남았다. SAR 무시 경로는 발견했으나 아직 수정하지 않았다. 상세는 진행 기록과 인계서 최신 절 참조.

> 2026-10-12 새벽 갱신: 프로젝트 v2/v1 migration·전체 미디어 SHA-256/재연결·편집 메타 저장 보존, 발음 입력 UI, 수정 문장 어절 재분할, 긴 줄 bounded window/overlap, 최초 추출 정밀/빠른 모드를 구현했다. 실앱 저장·재연결·발음/분할 Undo/Redo 검증 통과. 일반 전사 122/128 aligned, 한 긴 줄 검사 121/128(경계 충돌 1개 추가 검토). 사람 경계 정확도 측정, nonzero PTS 공통 원점, 장시간 스트리밍, 설치본 runtime/model 배포와 4K/IME 검증은 남아 있다. 최신 상세는 진행 기록과 인계서 최상단 참조.

> 2026-10-11 재개 결과: 재생 입력 경합·글자 편집·진단·타입 오류를 수정하고 사용자 실영상의 accurate 경로를 검증했다. 128개 중 120개 aligned이며 사람 기준 정확도는 미측정이다. 전체 계획 완료를 뜻하지 않는다. 최신 완료/미완료 범위는 `autosubtitle-desktop-sync-progress.md` 상단과 `open-issues-handoff.md` 최신 절을 참조한다.

작성일: 2026-10-03. 전달 대상: 구현을 이어받을 Claude Code.

## 1. 작업 대상과 목표

**완성할 제품은 `E:\Develop Program\1. AutoSubtitle`에 있는 Electron 데스크톱 프로그램이다. 웹서비스를 만드는 작업이 아니다.**

- 수정 대상 D: `E:\Develop Program\1. AutoSubtitle`
- 참고 대상 W: `E:\Develop Program\2. itmatzip-platform\web-Tool\itmatzip-platform`의 auto-subtitle. 웹 자막칩의 유용한 동작·편집 규칙을 D의 단어칩에 반영하는 참고 자료다.
- 기술 참고: [VoiceStudio](https://github.com/debpalash/VoiceStudio)의 음성 전사·정렬·더빙 관련 구현.

완료 목표는 데스크톱에서 영상을 불러오면 사람의 말이 자막으로 추출되고, 말하는 단어와 단어칩 하이라이트·영상 자막이 일치하며, 편집 후 저장한 영상에서도 같은 싱크가 유지되는 것이다. 기존 칩·파형·캐럿·컷 편집 UX를 보존하면서 웹의 개선 사항 중 필요한 것만 반영한다.

권장 구조는 **기존 faster-whisper 전사 → 한국어 WhisperX 강제 정렬 → 단어 데이터 확정 → 자막 줄 구성 → 공통 타임라인 기반 재생·버닝**이다. 실제 한국어 영상에서 성능을 측정한 후 채택한다. TTS 재합성이나 더빙용 음성/영상 속도 변경은 이번 범위가 아니다.

겹말·소음·연음·잘못 인식한 글자는 경계가 불명확할 수 있다. 모든 자료에서 오차 0을 약속하지 않는다. 검증된 구간은 자동 완료하고 불확실한 구간만 검토 표시한다. 아래 수치는 개발 목표이며 측정 결과가 아니다.

## 2. 조사 기준과 기존 변경 보호

| 항목 | 조사 시점 기준 |
|---|---|
| D HEAD | `eda4bfb73d98322c98775737df64afc7d3d90762` |
| W HEAD | `926522f17aebaba50c72009bb7fbaf35431d7923` |
| VoiceStudio SHA | `befc0a6f5b552b0b99e6eea574bc3c55e3d0519a` |
| D 기존 미커밋 변경 | `python_sidecar/main.py`, `python_sidecar/__pycache__/main.cpython-314.pyc` |

사용자 기존 변경을 보존하고 diff를 확인한 뒤 구현한다. 이번 작업은 소스 정적 분석과 문서 작성이며 프로그램 수정·모델 설치·음향 평가·실제 버닝 실행은 하지 않았다. 코드로 확인한 사실과 실행 검증할 가설을 구분한다.

이하 별도 표시 없는 경로는 D 기준이다. 웹 파일은 `W/`를 붙인다. `신규 제안`은 아직 구현되지 않은 설계다. 기존 웹 대상 계획서는 폐기되었으며 이 문서가 우선한다.

## 3. 데스크톱 현재 구조와 확인된 문제

### 3.1 실행 구조

`package.json` 기준 Electron 35, React 19, TypeScript, electron-vite, Peaks.js, Vitest를 사용한다.

1. React renderer의 파일 선택·드롭 → preload → Electron main.
2. `src/main/index.ts`가 모델 준비 및 `PythonSidecar.call('transcribe', ...)` 호출.
3. `python_sidecar/main.py`가 faster-whisper 전사와 후처리 수행.
4. main의 `transcribe:complete` 이벤트로 renderer의 자막·파형·단어칩 갱신.
5. export는 `export:by-format` IPC → offscreen 자막 캡처 → main의 FFmpeg 합성.

수정 경계는 React/공유 TypeScript, preload/IPC, Electron main, Python sidecar다. 웹 Agent나 HTTP 서버를 새로 만들 필요가 없다.

### 3.2 RMS 보정은 기본 실행된다

`python_sidecar/main.py`의 transcribe 분기는 `word_timestamps=True`로 전사한 뒤 `params.get('rms_vad_align', True)` 조건으로 `apply_rms_vad_word_align()`을 실행한다. 이후 `_fill_unvoiced_gaps()`가 실행된다. main은 현재 path와 파형 캐시 경로를 중심으로 전달하므로 RMS 기본값이 적용된다.

이전 웹 계획서의 “기본 정렬 옵션이 꺼져 있다”는 진단은 데스크톱에 해당하지 않는다.

확인된 개선 지점:

- RMS 예외를 `except Exception: pass`로 넘기므로 적용 실패가 드러나지 않는다.
- RMS/음량은 한국어 연속 발화의 단어 경계를 구별하는 음향 언어 모델이 아니다.
- `_fill_unvoiced_gaps()`와 `_extend_last_cue_end()` 계열은 gap 처리 중 마지막 단어 끝을 늘릴 수 있다. 발화 종료와 자막 표시 종료를 분리해야 한다.
- 전사 단계에서 100%를 표시한 뒤 후처리하는 구조는 정렬 단계 추가 시 단계별 진행률로 변경한다.

### 3.3 데스크톱 칩 판정과 시계는 별도 확인해야 한다

`src/renderer/src/SubtitleVirtualList.tsx`에는 `playheadSec >= word.start && playheadSec < word.end` 판정이 확인된다. 웹의 70ms 선행 하이라이트 상수를 데스크톱에도 있다고 가정하지 않는다.

`App.tsx`, `sync/SyncEngine.ts`, `timeline/webAudioMasterPlayback.ts`, `timeline/mapping.ts`에는 video master와 audio master, stitched audio의 편집 축을 원본 video 축으로 바꾸는 경로가 함께 있다. 어느 경로가 실제 소리를 출력하는지 추적하고 그 시계를 기준으로 통일한다.

### 3.4 export에서 단어 정보가 사라진다

`src/shared/exportCuePipeline.ts`의 ExportCueLine과 `src/shared/ipc.ts`의 ExportVideoRequest.subtitles는 `{start,end,text}`다. ExportSubtitleUpdatePayload도 기본적으로 text·style·resolution만 전달한다.

따라서 현재 줄 자막 버닝 계약만으로 단어 하이라이트를 출력할 수 없다. word ID·시간·활성 상태를 전달하는 snapshot과 렌더 스케줄을 추가해야 한다. 일반 자막 버닝은 유지한다.

### 3.5 컷 후 버닝의 시간 불일치 — 우선 검증 대상

`src/main/index.ts`는 `buildMappedSubtitles(req.subtitles, cuts)`로 자막을 컷 이후 시간으로 매핑한다. 이어 원본 inputPath와 매핑된 자막을 `runSinglePassSubtitleBurnIn()`에 전달한다.

하지만 `src/main/ffmpeg-single-pass.ts`의 계약에는 cutRanges/clip plan이 없고, 필터는 원본 영상에 setpts·overlay를 적용하며 오디오는 `0:a?` copy다. 확인한 호출 경로에는 컷 구간별 video/audio trim·concat이 없다.

따라서 실제 컷이 있는 경우 **자막만 당겨지고 영상·음성은 원본 순서로 남을 수 있는 구조**다. 앞 2초 컷 fixture로 재현하고 renderer의 실제 inputPath와 cutRanges를 trace해 확정한다. Python의 다른 export 함수가 존재한다고 현재 Electron video export가 그것을 사용한다고 가정하지 않는다.

### 3.6 버닝 안정성 추가 점검

- raw 자막은 30fps이며 midpoint `(frameIndex+0.5)/fps`로 상태를 고른다. 원본/출력 FPS 계약을 명확히 한다.
- overlay와 출력의 shortest 설정이 뒤 무음·짧은 오디오 때문에 영상을 조기에 자르는지 검증한다.
- video만 PTS를 0으로 바꾸는 경우 audio copy와의 원래 offset을 잃지 않는지 확인한다.
- Promise.race timeout만으로 FFmpeg가 종료되지 않는다. 실제 취소/kill을 연결한다.
- 현재 waitFfmpegExit는 stdin pipeline 완료 뒤 호출된다. error/close는 spawn 직후부터 수집하도록 바꿔 조기 종료를 놓치지 않는다.
- out_time_ms와 duration×1000 비교는 단위 불일치 가능성이 있으므로 설치된 FFmpeg의 실제 progress 출력으로 검증한다.

위 항목은 정적 코드 관찰이며 실제 결과 영상의 실패를 측정한 것은 아니다.

## 4. 웹 자막칩의 선별 반영

| 참고 W/web-ui/tools/auto-subtitle/ | 데스크톱 적용 위치 | 내용 |
|---|---|---|
| `subtitle-list/word-caret-ui.js`, `shared/subtitle-word-caret-map.js` | `SubtitleVirtualList.tsx`, `src/shared/subtitleWordCaretMap.ts` | 캐럿·한글 편집 동작 비교 |
| `shared/subtitle-word-edge-drag.js`, `shared/cross-cue-boundary-sync.js` | `subtitleWordEdgeDrag.ts`, `useWordEdgeDrag.ts` | 이웃 단어/줄 경계 일관성 |
| `shared/subtitle-tombstone-cut.js`, `shared/block-word-edit-ops.js` | `subtitleTombstoneCut.ts`, renderer 편집 ops | 자막 삭제와 미디어 컷 구분 |
| `shared/program-clips-ssot.js`, `shared/program-playback-clock.js` | `virtualTimeline.ts`, renderer timeline/sync | 순서 변경·반복·시간 매핑 |
| `shared/overlay-timing-ssot.js`, `shared/overlay-capture-schedule.js` | 신규 공유 export schedule | preview/export 시간 계약 |
| `shared/line-mode/` | 필요 시 신규 `src/shared/subtitleReflow.ts` | 단어 시간을 보존하는 줄 배치 |

먼저 클릭, 재생 강조, drag, split/merge, 삭제/복구, 캐럿, 줄 이동, 파형, undo/redo별 동작 비교표를 만든다. 웹에 있다는 이유만으로 개선된 동작이라고 단정하지 않는다. 필요한 기능만 React/TypeScript 상태 모델에 맞게 반영한다.

웹 script.js 통째 복사, HTTP/Agent 의존성, React와 중복되는 직접 DOM 상태 관리, 선행 하이라이트 보정은 가져오지 않는다.

## 5. VoiceStudio에서 채택할 기술

`backend/services/asr_backend.py`의 WhisperXBackend.transcribe는 16kHz mono를 전사하고 언어별 음향 모델로 whisperx.align을 호출한다. 별도 forced_align 함수도 있다. 기존 faster-whisper를 유지하면서 정렬 단계만 추가할 근거다. 주석의 ±10–30ms는 우리 한국어 영상의 검증된 정확도가 아니다. [ASR 소스](https://github.com/debpalash/VoiceStudio/blob/befc0a6f5b552b0b99e6eea574bc3c55e3d0519a/backend/services/asr_backend.py)

onset_align.py는 분리 vocals의 지속적인 RMS 상승으로 문장 앞 무음을 보수적으로 줄인다. 혼합 음원에서는 적용을 제한한다. 단어 전체의 시작·끝을 맞추는 대체 기술이 아니다. [onset 소스](https://github.com/debpalash/VoiceStudio/blob/befc0a6f5b552b0b99e6eea574bc3c55e3d0519a/backend/services/onset_align.py)

fit_planner.py의 Smart Fit은 합성 음성과 영상 길이를 조절하는 더빙용 기능이므로 제외한다. karaoke_ass.py의 균등 분할 fallback과 다음 단어 시작까지 이어지는 sweep도 정확한 발화 종료/무음 강조 정책으로 복사하지 않는다. [Smart Fit](https://github.com/debpalash/VoiceStudio/blob/befc0a6f5b552b0b99e6eea574bc3c55e3d0519a/backend/services/fit_planner.py), [karaoke](https://github.com/debpalash/VoiceStudio/blob/main/backend/services/karaoke_ass.py)

VoiceStudio는 조사 리비전에서 AGPL-3.0-only다. 기본 계획은 저장소 직접 복사보다 공개 라이브러리 API를 사용하는 자체 어댑터다. 직접 소스를 도입한다면 데스크톱 배포 방식에 맞는 의무를 검토하고 모델·폰트도 별도로 확인한다. [라이선스](https://github.com/debpalash/VoiceStudio/blob/befc0a6f5b552b0b99e6eea574bc3c55e3d0519a/LICENSE-NOTICE.md)

## 6. 목표 파이프라인

1. main이 stream, 시작 PTS, time_base, rotation, SAR, FPS/VFR, duration을 probe한다.
2. 원본 사용 또는 호환 preview 생성을 결정하고 source↔preview 매핑을 저장한다. 불필요한 전체 재인코딩은 피한다.
3. 기준 미디어에서 분석용 16kHz mono PCM을 만든다. 출력 오디오를 16kHz로 낮추는 작업이 아니다.
4. faster-whisper로 원문과 초기 시간을 얻고 raw 결과를 보존한다.
5. 한국어 음향 모델로 텍스트를 강제 정렬한다.
6. 품질 검증·제한적 재시도 후 단어 시간과 상태를 확정한다.
7. 단어를 줄로 묶고 무음은 별도 gap으로 표현한다.
8. 칩·파형·프리뷰가 동일 단어 데이터와 clock을 사용한다.
9. 컷·순서·반복은 clip plan에 기록하고 source 시간은 보존한다.
10. 동일 clip plan과 고정 export snapshot으로 A/V·자막을 합성한다.

VAD는 발화 구간 탐지이며 forced alignment는 글자와 음향의 대응이다. RMS/골짜기/zero-cross만으로 단어 경계를 확정하지 않는다. 음악이 심할 때만 음원 분리를 선택적으로 평가한다. 분리된 오디오의 길이·패딩·지연을 원본 기준으로 검증하고 최종 음성은 사용자가 의도한 원본 편집 결과를 유지한다.

## 7. 데이터 계약과 시간 축

| 축 | 의미 |
|---|---|
| original | 원본 stream PTS |
| source | 분석 기준 미디어의 0 기준 시간 |
| program/edit | 컷·순서·반복을 반영한 재생 시간 |
| output | 최종 frame PTS |

`src/shared/virtualTimeline.ts`, `timelineCollapse.ts`, renderer `timeline/mapping.ts`, `sync/blockMapping.ts`를 중심으로 변환 책임을 통일한다. currentTime이라는 이름만으로 축을 판단하지 않는다. stitched audio와 원본 video의 currentTime은 다를 수 있다.

기존 초 단위 계약을 유지하면서 신규 저장은 정수 microsecond를 고려한다. 변환은 어댑터 경계에서 한다. 표시용 0.01초 반올림·CSS 좌표를 저장 시간으로 역반영하지 않는다.

### 단어 레코드 확장 — 신규 설계

| 필드 | 목적 |
|---|---|
| id, sourceMediaId, segmentId | index와 독립적인 ID |
| displayText / 기존 word | 표시 문자열 |
| alignmentText | 모델 입력 문자열 |
| source 시작·끝, raw ASR 시작·끝 | 확정 추정치와 원시 값 분리 |
| alignmentStatus | aligned / estimated / manual / unaligned / stale |
| engine, model ID/revision | 재현 정보 |
| alignmentScore, asrProbability | 서로 다른 점수, 없으면 null |
| charSpans, textSpanMap | 문자/표기/발음 연결 |
| manualStartLocked, manualEndLocked | 사용자 경계 보호 |
| revision, reviewReasons | 오래된 결과 방지·실패 사유 |

`src/shared/subtitles.ts`와 Python 응답, `wordContract.ts` gap-fill, `vrewSubtitleAdapter.ts`, 저장 parser를 함께 변경한다. 새 객체 생성 과정에서 ID·상태가 사라지지 않게 한다. 기존 word/start/end는 versioned adapter로 이행하며 source/program 값을 같은 필드에 번갈아 덮어쓰지 않는다.

못 찾은 시간은 null/unaligned로 남기고 UI 추정값을 따로 표시한다. 모델 score를 정답 확률로 표현하지 않는다. 음향 단어는 보존하고 칩은 sourceWordIds/문자 범위, 줄은 칩 배치로 표현한다. 반복 clip에는 occurrence ID가 필요하다.

줄 표시 displayStart/displayEnd와 실제 단어 발화 시간을 분리한다. 줄을 오래 보여도 마지막 단어 강조는 발화 종료에서 꺼진다. `--`는 편집기용이고 최종 글자에는 포함하지 않는다. 실제 겹말을 억지로 비겹침 단어로 바꾸지 않는다.

## 8. 한국어 정렬 구현

동일 오디오·동일 전사문으로 기존 Whisper, 현재 RMS, WhisperX를 비교한다. stable-ts는 선택적 비교 후보다. 전사 CER/WER와 경계 오차를 분리하고 실제 전사를 포함한 end-to-end도 평가한다.

첫 한국어 후보는 WhisperX 기본 매핑의 `kresnik/wav2vec2-large-xlsr-korean`이다. 모델카드의 인식 정확도는 경계 정확도가 아니므로 실영상으로 검증한다. [언어 매핑](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py), [모델카드](https://huggingface.co/kresnik/wav2vec2-large-xlsr-korean)

신규 제안 파일:

- `python_sidecar/forced_align.py`: 공개 WhisperX API 호출.
- `python_sidecar/alignment_contract.py`: 시간·ID·상태 검증과 cue 변환.
- `python_sidecar/alignment_text.py`: 표시/정렬 문자열 대응.
- `python_sidecar/alignment_quality.py`: coverage·누락·경계 이상·재시도.
- 필요 시 `python_sidecar/align_worker.py`: 별도 호환 runtime 프로세스.
- 필요 시 `src/main/mediaTiming.ts`: probe·분석 PCM 매핑.

main.py를 전사→정렬→검증→줄/gap 순서로 바꾼다. 정렬 뒤 RMS로 일괄 덮어쓰지 않는다. 보조 보정에는 조건·변경량·근거를 기록한다. 실패 시 raw 자막을 보존하고 적용 실패 상태를 반환한다.

한국어 처리 규칙:

1. 칩은 읽기 쉬운 어절 단위다. 모델 token 개수와 같다고 가정하지 않는다.
2. NFC/NFD·자모 처리는 vocabulary를 확인하고 문자 인덱스 map을 보존한다.
3. “3개”와 발화 “세 개”를 구분하며 읽기가 모호하면 검토 대상으로 둔다.
4. 영문·숫자·고유명사 OOV를 감지한다. 문장 전체 한국어 감지만으로 혼용 구간이 해결됐다고 보지 않는다.
5. 문장부호에 가짜 발화 시간을 부여하지 않는다.
6. 반복어는 segment/문자 범위로 연결한다. 입력과 출력 word 수가 같다는 가정은 금지한다.
7. 보간 시간·null score·지원되지 않는 문자는 estimated로 남긴다.
8. 단어 중간 분할에는 검증된 char alignment를 쓰고 글자 수 비례 시간은 근사값으로 표시한다.

WhisperX도 미지원 문자·겹말의 한계를 명시한다. 실패를 삭제나 가짜 정밀 시간으로 숨기지 않는다. [제한 사항](https://github.com/m-bain/whisperX#limitations-)

긴 파일은 초기 15–30초 문맥 창·overlap으로 실험하고 조정한다. crop offset을 한 번만 더하고 중복은 문자/ID로 합친다. VAD로 무음을 잘라 붙이면 원본 복원 map이 필요하다. 1차는 무음을 보존한 PCM이 단순하다. 실패 구간만 제한 재시도하고 무한 추론을 금지한다.

## 9. 런타임·IPC·프로젝트 저장

### 런타임

`requirements.txt`만 바꿔 끝내지 않는다. `src/main/python-resolve.ts`, `pip-sidecar-deps.ts`, `deps-prepare.ts`, `gpu-runtime.ts`, `scripts/bundle-sidecar.cjs`, `python_sidecar/main.spec`의 개발/배포 경로를 확인한다.

현재 Python과 torch/torchaudio/transformers/WhisperX wheel 호환성을 깨끗한 환경에서 검증하고 버전을 고정한다. CTranslate2와 torch CUDA 충돌 시 정렬 전용 runtime/worker를 둔다. CPU fallback과 실제 장치 표시를 제공한다. 모델은 app userData cache에 저장하며 packaged resources에 쓰지 않는다. revision/hash·라이선스, 다운로드 중단·오프라인 재사용·디스크 부족을 처리한다. VRAM은 측정 후 필요하면 전사/정렬 모델을 순차 로드한다.

### IPC와 작업 수명

`src/shared/ipc.ts`, preload 구현/선언, main/index, main/sidecar를 함께 확장한다. alignmentMode는 accurate/fast/off 후보이며 실험 후 accurate를 기본으로 전환한다. 응답에 schemaVersion, timelineId, alignmentSummary, requested/applied engine, 상태별 단어 수, 실패 사유를 포함한다.

stdout은 JSON-RPC 전용이며 모델 로그는 stderr다. 진행률에 단계와 requestId를 포함한다. 다른 파일을 연 후 도착한 이전 결과를 적용하지 않는다.

신규 `realign_words` RPC는 media/project ID, word IDs, text revision, 문맥 범위, manual locks를 받는다. 응답 revision이 달라졌으면 폐기하고 적용은 하나의 undo transaction으로 한다.

현재 sidecar는 stdin을 순차 처리하며 call도 chain이다. 추론 중 같은 stdin으로 cancel을 보내면 바로 처리된다고 가정하지 않는다. 실제 cooperative cancel 또는 worker 종료를 구현한다. timeout이 Promise만 reject하고 추론은 남는 상황을 막는다. 앱 종료 시 worker·FFmpeg·offscreen 창을 정리한다.

### 저장

`src/shared/autosubProject.ts`의 현재 `.autosub` version 1에 대해 v2와 migration을 설계한다. v1 시간은 estimated로 가져오고 ID를 생성한다. 원본 일치 여부를 확인하며 열기만 했다고 자동 재정렬/덮어쓰기하지 않는다. manual 경계·품질·ID·문자 map은 저장과 undo에 포함한다. cache key에는 미디어 hash·stream·모델 revision·텍스트 revision·옵션을 넣는다.

## 10. 단어칩 UI와 재생

편집 선택, 실제 발화 활성, hover, 캐럿을 분리한다. 무음에서 선택은 유지해도 speech 강조는 꺼진다.

| 동작 | 규칙 |
|---|---|
| 칩 클릭 | occurrence의 program 위치로 seek |
| 재생/무음 | interval 안의 단어만 강조, gap은 없음 |
| 정지/seek | 새 위치에서 즉시 판정 |
| 경계 drag | manual lock 저장·이웃 검증 |
| 줄 나누기/합치기 | word ID·source 시간 보존 |
| 표기만 수정 | 대응이 확실하면 display만 변경 |
| 발음/단어 변경 | 문맥 stale→부분 재정렬 |
| 단어 중간 split | char boundary 또는 estimated |
| 자막 삭제/미디어 컷 | 별도 의미·명령, 기존 의도된 단축키는 명시적으로 유지 |

신규 `src/shared/activeWordResolver.ts`를 칩·파형·프리뷰·export가 공유한다. 기본은 반개구간 `start <= t < end`이며 gap에서는 빈 결과다. 별도 offset 상수를 반복 추가하지 않는다. 줄 스크롤 hold는 speech 강조와 분리한다. 반복 clip은 `(occurrenceId,wordId)`로 구분한다.

순차 재생 cursor와 seek binary search를 사용하고 React는 활성 ID 변경 시 관련 칩만 갱신한다. 기존 가상 목록·Peaks 수명주기를 보존한다. 모델 추론은 renderer 밖에서 실행한다.

PlaybackClock은 실제 출력원별로 하나다. video가 소리도 내면 video media time, stitched/WebAudio가 소리를 내면 program audio clock이 master다. 양쪽 timeupdate가 서로 seek하는 loop를 만들지 않는다. video UI는 requestVideoFrameCallback/RAF를 검토하고 정지·seek·창 복귀는 별도 갱신한다. 배속이 반영된 media time에 다시 배속을 곱하지 않는다. 장치 latency는 정렬 시간에 하드코딩하지 않는다. [프레임 콜백](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)

## 11. 편집 타임라인과 A/V export 일치

신규 ExportSnapshot은 media ID, revision, clip plan, source words, display cues, style, output 설정을 담는다. export 시작 시 고정한다.

배속 없는 clip은 `program = programStart + source - sourceStart`다. 실제 배속 r을 지원할 때만 `/r`을 적용하고 A/V에도 동일하게 적용한다. 같은 원본 반복은 occurrence로 구분한다.

**컷 후 자막만 재매핑하지 않는다.** 구현 선택지는 다음과 같다.

1. 같은 FFmpeg graph에서 video trim/setpts, audio atrim/asetpts, concat 후 overlay.
2. 동일 clip plan으로 program A/V master를 생성한 뒤 program 자막과 합성.

우선 컷 없는 경로를 유지하고 컷 있는 경로를 명시적으로 추가한다. 복잡한 순서/반복은 검증된 master 경로로 통합할 수 있다. cutRanges만으로 순서 변경을 표현할 수 없으므로 clip plan을 IPC에 전달한다. 이미 program인 cue를 다시 컷 매핑하지 않도록 axis를 명시한다.

마지막 자막 끝을 영상 길이에 비례 확대하지 않는다. crossfade로 길이가 달라지면 동일 map에 반영한다. 1차는 hard cut 또는 길이 보존 정책으로 검증한다.

## 12. Electron 자막 버닝 상세 설계

기존 `src/main/exportLogic.ts` offscreen 창, `src/renderer/src/ExportSubtitle.tsx`, capturePage/toBitmap, `src/main/ffmpeg-single-pass.ts`를 확장한다. 기존 render-ready IPC와 document.fonts.ready는 재사용한다. 웹 Canvas/HTTP upload 방식으로 교체하지 않는다.

preview와 offscreen은 공통 React 자막 view 또는 동일 순수 layout/style 함수를 사용한다. payload에 text spans, active word IDs, render revision, style, native content rectangle을 추가한다. render-ready는 요청 ID와 연결하여 이전 프레임을 잘못 캡처하지 않는다.

### 이벤트 스케줄과 프레임

신규 `src/shared/exportRenderSchedule.ts`는 단어 시작/끝·cue 시작/끝·clip 경계·스타일 변경 시점을 모아 공통 resolver로 상태를 계산한다. 동일 상태를 한 번 렌더하고 재사용한다. 무음·자막 없음도 명시한다.

FPS를 유리수로 저장하고 frame n의 `t=n*fpsDen/fpsNum`에서 판정하는 정책을 권장한다. 기존 midpoint를 유지하면 모든 진단·비교도 같은 정책이어야 한다. 29.97/30, frame 시작/midpoint를 섞지 않는다. 기본 효과는 현재 발화 단어 전체 색 변경이다. 선형 sweep은 실제 음절 싱크가 아닌 별도 시각 효과다.

### 미디어·품질

- probe 결과로 출력 FPS/VFR 정책을 확정하고 video와 overlay PTS를 맞춘다.
- export 종료는 최종 program 미디어 길이이며 마지막 자막 끝이 아니다.
- A/V 시작 offset을 보존/명시적으로 보정한다. video만 0으로 바꾸지 않는다.
- 컷이 있으면 audio trim/concat 후 encode, 없고 컨테이너가 허용할 때만 copy다.
- shortest를 무조건 종료 정책으로 사용하지 않는다. audio 없음·짧은 audio·뒤 무음도 검사한다.
- rotation/SAR/세로/홀수 크기/색공간을 처리한다. HDR 미지원이면 범위를 알린다.
- NativeImage bitmap과 RAWVIDEO_PIXEL_FORMAT의 BGRA/RGBA·premultiplied alpha를 테스트 패턴으로 검증한다.
- font fallback, DPI 100/125/150/200%, 확대율, 1080p/4K의 위치·줄바꿈을 실제 캡처로 비교한다.
- 사용자 글자는 JSX text로 렌더한다. HTML 삽입을 하지 않는다.

현재 rawBgraBuffersOrdered로 모든 상태를 보유하는 방식은 단어별 상태가 늘면 RAM이 급증한다. 1080p RGBA 한 장은 약 8.3MB, 4K는 약 33.2MB다. bounded cache·임시 이미지·순차 캡처/streaming을 설계하고 전체 프레임 영상을 메모리에 쌓지 않는다. 자막 영역만 native 해상도로 캡처하는 대안도 평가한다.

### 실행 안정성

spawn 직후 error/close promise를 만들고 stdin writer와 stderr reader를 함께 관리한다. timeout/취소/앱 종료는 process 종료로 연결한다. worker 창·타이머·임시 파일도 정리한다. 인코더는 실제 encode probe 후 선택하고 실패 시 동일 snapshot으로 CPU 재시도한다.

출력은 임시 파일에 쓰고 exit 0, probe, 기본 decode 확인 후 최종 파일로 승격한다. 파일 존재만으로 성공 처리하지 않는다. progress 단위를 검증하고 100%는 결과 검증 후다. FFmpeg는 argv로 실행하며 filter의 경로 escaping을 통제한다.

ASS/libass는 고정 스타일의 별도 출력 옵션으로 고려한다. CSS와 동일 픽셀이라고 가정하지 않는다. 현재 줄 ASS와 단어 ASS를 구분하고 gap에서 강조가 꺼지는 실제 렌더를 검사한다. SRT만으로 단어 강조를 전달할 수 없다. [FFmpeg overlay](https://ffmpeg.org/ffmpeg-filters.html#overlay)

## 13. 파일별 작업표

| 우선순위 | 데스크톱 파일 | 작업 |
|---|---|---|
| P0 | `python_sidecar/main.py`, 신규 정렬 모듈 | 정렬 PoC·단계 순서·품질/실패 보고 |
| P0 | `src/main/index.ts` | 정렬 요청·결과 전달, 미디어 계약 |
| P0 | `src/main/ffmpeg-single-pass.ts` | 실제 A/V 컷, FPS/PTS, 종료/취소 |
| P0 | `src/shared/ipc.ts`, preload 구현/선언 | 단어/clip plan·revision·작업 계약 |
| P1 | `src/shared/subtitles.ts`, `wordContract.ts`, renderer `vrewSubtitleAdapter.ts` | ID·품질·시간 보존 |
| P1 | `SubtitleVirtualList.tsx`, 파형·캐럿 컴포넌트 | 웹 칩 개선 선별, 선택/발화 분리 |
| P1 | 신규 `src/shared/activeWordResolver.ts` | 동일 활성 단어 판정 |
| P1 | renderer `App.tsx`, `sync/`, `timeline/` | clock·축 변환·작업 상태 |
| P1 | shared 단어 split/drag/tombstone 함수 | manual/stale/문자 정렬·undo |
| P1 | `src/shared/autosubProject.ts` | v2와 v1 migration |
| P1 | `src/main/sidecar.ts` | requestId·진행률·cancel/timeout·재시작 |
| P2 | `src/shared/exportCuePipeline.ts`, 신규 snapshot/schedule | 단어·clip plan 전달 |
| P2 | `src/main/exportLogic.ts`, renderer `ExportSubtitle.tsx` | 단어 강조·ready revision·bounded capture |
| P2 | python-resolve/pip-sidecar-deps/deps-prepare/gpu-runtime | 실제 설치 환경 지원 |
| P2 | bundle-sidecar/main.spec/requirements | 버전 고정·설치본 포함 |

React 수정 시 저장소의 관련 지침/스킬을 먼저 확인한다. App 전체 재작성보다 책임별 모듈 추출로 회귀를 줄인다.

## 14. 검증·합격 기준

최소 20개 클립·30분·1,000개 수동 단어 경계로 시작한다. 깨끗한 독백, 빠른 말, 음악, 작은 목소리, 긴 무음, 반복어, 숫자/영문, 겹말을 포함한다. 30분 이상 긴 영상도 별도 검사한다. 일부 경계는 2인이 검수하고 애매한 경계는 허용 범위로 기록한다. 개발/최종 검증 자료를 분리한다.

| 항목 | 초기 목표, 측정 전 제안 |
|---|---|
| 깨끗한 한국어 시작/끝 오차 | 각각 median ≤50ms, p95 ≤120ms |
| 자동 정렬 coverage | ≥95%, 전체 단어를 분모로 사용 |
| 전사 정확도 | CER/WER·누락/환각을 별도 보고 |
| 데이터→칩 UI | foreground p95 1 화면 frame 이내 목표 |
| resolver→버닝 | 같은 PTS의 동일 상태, 1 output frame 이내 양자화 |
| 무음 강조 | 정확 모드 speech 잔류 0 |
| 컷/순서/반복 | A/V·자막 map 오류 0 |
| 저장·재열기 | ID·시간·manual·품질 동일 |
| fallback | 추정을 aligned로 오표시 0 |

미정렬률·검토율을 함께 보고하고 좋은 단어만 골라 오차를 계산하지 않는다. 어려운 자료는 난도별로 구분한다.

테스트 범위:

- Python: null/0길이/역전/OOV/반복어/문자 대응/crop offset/manual lock/실패/취소.
- TS: ID roundtrip, gap이 음향 end를 늘리지 않음, occurrence·source/program 변환.
- resolver: start/end와 1us 전후, gap, 마지막 단어, seek, 배속.
- 편집: split/merge/drag/delete/undo/redo, 한글 IME, 저장/열기.
- IPC: 오래된 응답, 앱 종료, sidecar 실패, timeout 후 다음 작업, stdout 오염.
- 미디어: 24/25/30/60fps와 NTSC, VFR, 비영점 PTS, A/V offset, 44.1/48kHz, audio 없음, 뒤 무음, 회전·세로·4K.
- export: 앞/중간/끝 컷, 순서/반복, 단어 경계 전후 프레임, 폰트·색·알파.
- 설치본: Python 없는 깨끗한 Windows, CPU/GPU, 한글 경로, DPI, 모델 재사용·오프라인.

기존 `npm test`, `npm run build`를 변경 범위에 맞게 실행한다. shared의 virtualTimeline/exportCuePipeline/subtitleWordEdgeDrag 테스트와 renderer의 timeline mapping/playbackSchedule, sync blockMapping, vrewSubtitleAdapter 회귀를 포함한다. Python fixture 테스트를 추가한다. 이 문서 작성 중 테스트를 실행한 것은 아니다.

최종 파일을 probe/decode하고 실제 단어 경계 직전/직후 프레임을 공통 resolver와 비교한다. 컷 부근과 영상 앞/중간/끝을 청취한다. 렌더 시점 일치와 실제 음향 경계 정확도는 각각 검증한다.

## 15. 단계별 산출물

1. **기준 측정:** desktop raw→RMS→gap 데이터, 실제 clock/export trace, 앞 2초 컷 재현, 웹 칩 비교표.
2. **정렬 PoC:** 격리 환경·한국어 비교 결과·coverage·RAM/VRAM·runtime 호환. 품질 확인 전 UI 대규모 개편 금지.
3. **계약 도입:** ID/품질/시간 축·IPC revision·프로젝트 v2 migration·roundtrip 검사.
4. **칩·재생:** 필요한 웹 UX 반영, resolver/clock, manual/stale/부분 재정렬/undo. 앱 재현 영상 제출.
5. **버닝:** 동일 clip plan A/V 편집·단어 상태 캡처·PTS·취소·메모리·DPI. 실제 출력 영상과 프레임 비교 제출.
6. **설치본:** dist의 runtime·모델 배포 검증, 깨끗한 PC에서 전사→편집→버닝 완료. 개발 모드 성공만으로 완료하지 않음.

공수는 초기 10–20 작업일 수준의 추정이며 한국어 품질과 패키징 실험 뒤 재산정한다. 일정 보장이 아니다.

## 16. Claude 전달용 실행 지시문

> 실제 개발 대상은 `E:\Develop Program\1. AutoSubtitle`의 Electron 데스크톱 프로그램이다. 웹 앱을 만들거나 웹 프로젝트를 수정하는 일이 아니다. `E:\Develop Program\2. itmatzip-platform\web-Tool\itmatzip-platform`의 auto-subtitle은 자막칩 UX·편집 규칙 참고용이다. 필요한 개선만 desktop React/TypeScript로 반영하라.
>
> 이 문서와 저장소 지침을 읽고 미커밋 변경을 보존하라. main.py는 현재 RMS 보정을 기본 실행하므로 웹의 옵션 off 현상을 데스크톱 원인이라고 혼동하지 마라. 기존 faster-whisper 뒤에 한국어 WhisperX 강제 정렬 PoC를 만들고 실제 음성 라벨로 비교하라.
>
> source 단어 시간·program 재생 시간·output PTS를 구분하고 ID·품질 상태를 adapter/IPC/저장까지 보존하라. 무음 표시 때문에 실제 단어 끝을 늘리지 마라. 칩·프리뷰·버닝은 동일 resolver를 사용하라. 글자 수 비례 분할이나 영상 길이 비례 보정으로 정밀 시간이 완성됐다고 주장하지 마라.
>
> main/index.ts가 자막을 컷 이후 시간으로 매핑하지만 ffmpeg-single-pass.ts가 원본 A/V를 합성하는 경로를 fixture로 검증하고 수정하라. 동일 clip plan으로 영상·오디오·자막을 함께 편집하라. Electron offscreen 캡처를 유지하고 단어 정보·상태 스케줄·PTS·취소·폰트·메모리를 보강하라.
>
> VoiceStudio는 강제 정렬 구조의 참고다. Smart Fit/TTS를 넣거나 저장소 전체를 복사하지 마라. 런타임/모델을 버전 고정하고 설치본까지 검증하라. 단계마다 수정 파일·검사·측정 결과·남은 문제를 보고하라. 최종 완료는 AutoSubtitle 앱에서 사람 목소리와 단어칩이 맞고 내보낸 영상에서도 같은 싱크가 검증된 상태다.

## 17. 완료 체크리스트

- [ ] 실제 변경 대상은 AutoSubtitle 데스크톱이고 웹 프로젝트는 참고만 했다.
- [ ] 기존 사용자 변경을 보존했다.
- [ ] 한국어 시작/끝 정확도와 미정렬률을 측정했다.
- [ ] 정렬/추정/실패/수동 확정 상태를 구분한다.
- [ ] 무음 강조가 꺼지고 줄 표시 유지와 분리된다.
- [ ] 한글 IME·칩 편집·undo·저장/열기가 유지된다.
- [ ] 컷·순서·반복의 A/V와 자막이 일치한다.
- [ ] 일반/단어 강조 버닝의 PTS·폰트·색·알파를 검사했다.
- [ ] 취소 후 추론·FFmpeg·offscreen 창이 남지 않는다.
- [ ] 설치된 앱에서도 모델 준비와 export가 동작한다.
- [ ] 사용자에게 전달할 결과 영상과 검증 보고서가 있다.
