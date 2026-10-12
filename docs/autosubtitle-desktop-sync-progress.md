# AutoSubtitle 싱크 개발 진행 기록

## 2026-10-12 21시 — 구간 PCM 재생·추출/파형 취소 (최신)

- 기준 HEAD `2be3a7b`, 이번 변경은 로컬 미커밋. 기존 개발 내용은 사용자 커밋에 포함되어 있다.
- 재생: 전체 WAV 디코딩 대신 6초 PCM 구간 읽기, 12초 선행 예약, 종료 버퍼 해제. RIFF/RF64/전용 캐시 경로/범위 검증. 컷 연결 및 원본 clock 추적, underrun 오류 정지, 백그라운드 타이머 제한 해제.
- 실앱: 실제 한국어 22초 연속 재생 최대 clock 차이 0.048686초, 컷 적용 0.087295초. 30분 fixture 시작 22초는 0.040052초, 1780초 탐색 정상. 보유 버퍼 최대 18초, 정지 후 0개. 전체 decodeAudioData 호출 없음. 3시간 가상 길이는 단위 검증이며, 실제 30분 전체 재생/스피커 청취/사람 경계 정확도 검사는 아니다.
- 최초 추출 취소 버튼: 준비 소비자 취소·Python 프로세스 트리 종료·늦은 결과 폐기·다음 추출 재시작. 실제 취소 약 250ms, 이후 8초 한국어 파일 재추출 완료(WhisperX 19/20 coverage).
- 파형 생성: ASR과 독립 worker, 요청 ID별 취소, 고유 임시 출력으로 동시 ASR 캐시 생성과 충돌 방지. 실제 준비/worker 단계 취소→재시도, 오래된 ID 취소 무시, ASR 모델 유지, 잔여 work 파일 0개 확인.
- 추출 오류 원인 안내와 취소 실패 메시지 보존을 추가했다.
- 검증: **Vitest 50 files/320 tests**, **Python 32 tests 재검사**, web/node 타입·production build·diff 통과. 일반 재생 **36/36**, HTML fallback 회귀 통과. 최신 빌드에서 취소 약 248ms 및 손상 MP4 추출 실패 안내·모달 종료도 확인했다.
- 결과/재현: `tools/sync-validation-output/stream-cancel-vitest-final.log`, `stream-cancel-build-final.log`, `cancel-retry-result.json`; E2E README에 새 스크립트 사용법 추가.
- 미완료: 사람 정답 평가/미지원 음절, 전체 PCM 디스크 및 ASR 메모리, 캐시 용량 상한/강제 종료 파형 임시 파일 정리, 설치본 runtime/model/GPU/오프라인 검증, 실제 Windows IME·여러 줄 선택·긴 4K/VFR/대형 RF64 등. 전체 개발 완료나 싱크 정확도 보장을 뜻하지 않는다.

사용자 원본/기존 pyc 변경은 보존했으며 reset credit을 사용하지 않았다. 상세는 인계서의 같은 시각 절을 참조한다.

마무리: 5시간 한도 약 5% 잔여, 주간 69% 잔여에서 새 범위를 중단하고 검증·기록을 완료했다. 마지막 테스트 전용 Electron(PID 27244)은 정상 종료했고 최신 빌드를 보존했다. 커밋/배포는 하지 않았다.

---

## 2026-10-12 15시 — 재생 예외·취소·선택 단어 정렬 (최신)

- HTML fallback: WebAudio 오류 시 음소거를 해제하고 HTML `playing` 이벤트로 UI를 갱신한다. 정상 WebAudio 재시도에서는 HTML을 음소거/정지하며, 오래된 canplay/seek/재시도 타이머는 요청 세대로 차단한다. 두 번째 오디오 조각 실패 시 앞서 연결한 소스도 모두 정리한다.
- 준비 취소: 영상 전환/창 종료, 부분 정렬 취소, 오디오 export 종료를 공통 PCM 준비 AbortSignal에 연결했다. 소비자별 참조를 세어 다른 정렬/export가 공유 중이면 그 작업은 계속한다. 마지막 소비자 취소 시 FFmpeg를 종료한다. 파형 생성은 공통 준비가 끝난 후 시작한다.
- 미디어 probe: 공통 준비와 영상 export의 ffprobe를 비동기·AbortSignal·30초 timeout·출력 크기 제한으로 변경했다. 실제 로컬 HTTP에서 media body를 멈춰 둔 ffprobe 취소와 이벤트 루프 응답 검증 통과. 최신 native 준비 취소는 약 85ms, PTS5/audio+0.5초 파일의 재생/실제 export도 재통과했다.
- WebAudio 로드: 같은 URL의 진행 중 fetch/decode를 공유하며 이전 파일 읽기를 취소한다. 오래된 응답은 decode 전/후 모두 폐기하고 전체 WAV `slice(0)` 복사를 제거했다. 전체 PCM/AudioBuffer 구조 자체를 스트리밍으로 바꾼 것은 아니다.
- 선택 단어 정렬: 발음 패널의 체크박스로 같은 줄의 한 개/비연속 여러 단어를 선택한다. 줄 전체 음성/문장을 정렬 문맥으로 사용하되 선택 ID에만 결과를 적용한다. 비선택 슬롯의 시간/ID/메타는 보존한다. 선택 결과가 고정된 이웃의 시간 순서를 뒤집으면 전체 결과 적용을 거부한다.
- 실제 앱: fallback 재생/정지/복귀/지연 취소, 일반 재생 36/36, 600초 무음 fixture 준비 취소(약 76ms)/재시도, 실제 WhisperX 단일·복수 선택 정렬/저장/Undo/Redo 통과. 비선택 단어는 JSON 전체 동일성을 비교했다.
- Chromium 조합 입력: 한글 중간 조합이 확정되기 전 단어 모델을 변경하지 않고, 확정/취소/한 번 Undo/3,000자 입력 후 복구 통과. 붙여넣기 확인까지 약 215ms(200ms 테스트 대기 포함); 성능 SLA나 실제 Windows IME 후보 창 검증은 아니다.
- 검증: **Vitest 48 files/312 tests**, web/node 타입 검사, production build 통과. Python은 이전 **32 tests** 이후 변경 없음. 로그 `resume-48-vitest-final.log`, `selected-final-build.log`, 결과 `selected-word-result-2.autosub`와 `.png`는 `tools/sync-validation-output` 내부(git 제외).
- 남음: 사람 경계 정답/CER·WER·median/p95, 모델 미지원 `캡`/`둡`, 장시간 스트리밍/캐시 용량 상한, 설치본 정렬 runtime/model/GPU/오프라인 새 설치, 실제 Windows IME·긴 4K 부하·임의각/반사/VFR/RF64 검증. 여러 줄을 가로지르는 단어 선택 UI도 아직 없다.

HEAD `a603f07` 이후 로컬 미커밋 변경을 보존했다. 사용자 원본/기존 pyc는 되돌리거나 삭제하지 않았다. 전체 계획 완료나 배포 완료가 아니며 reset credit을 사용하지 않았다.

마무리: usage 잔여 약 7%에서 새 범위를 중단하고 최종 기록을 정리했다. 마지막 테스트 전용 Electron(PID 35560)은 정상 종료했다. 최신 소스와 production build는 남아 있으며, 기존 일반 앱 인스턴스를 종료한 것은 아니다.

최종 사용량 확인: 5시간 한도 **3% 남음**, 주간 **85% 남음**. reset credit 2개는 그대로 유지했다.

## 2026-10-12 오후 — 최신 진행

- SAR/회전 표시 크기를 Chromium과 일치시키고 원본 영상/자막을 같은 SAR1 캔버스로 export하도록 수정했다. 실제 720×480/SAR8:9/90도 파일의 미리보기·출력 모두 540×720 확인.
- 4K 축소 캡처에서 글자가 커지거나 줄바꿈이 달라지는 오류를 원본 픽셀 배치 공간으로 수정했다. 실제 4K export, 세로·다중 줄·200% DPI offscreen 배치 검증 통과.
- WAV/MP3 컷을 sample 단위로 수정하고 임시 출력·전체 decode·취소/timeout·기존 출력 보존을 추가했다. 실제 UI WAV 결과 87,994 stereo samples를 원본 구간과 바이트 단위 비교해 통과했다.
- 검증: **Vitest 47 files/301 tests**, web/node 타입·build·diff 통과. Python은 오전 32 tests 이후 변경 없음.
- 남음: 한국어 미지원 음절과 사람 라벨 평가, 긴 영상 스트리밍/캐시 용량·전환 취소, 설치본 runtime/model/GPU, 실제 IME/장문/임의 단어 선택. 임의각 회전·반사·폰트 fallback·모니터 DPI 전환 등 미검증 범위는 인계서 최신 절에 기록했다.
- 마무리 점검에서 WebAudio 실패 시 HTML fallback의 음소거/UI 상태 문제를 추가 발견했다. 미검증 시도는 되돌렸고 다음 최우선 수정으로 인계했다. 사용량 잔여 약 3%에서 새 범위를 중단하고 검증된 변경만 보존했다.

변경은 로컬 미커밋 상태이며 전체 계획 완료나 배포 완료를 의미하지 않는다.


## 2026-10-12 오전 — 최신 진행

- 완료: nonzero A/V PTS를 영상 0초 기준 공통 PCM/필요 시 영상 remux로 통일. 최초 전사·RMS·정렬·부분 재정렬·파형·WebAudio·오디오 export 연결, 원본 보존, 캐시 버전/정리/중복 요청·timeout 처리.
- 추가 수정: 탐색 목표 시간이 설정된 즉시 음성을 시작하던 경합을 실제 `seeked` 대기로 변경. 준비 완료 후 실앱 클릭·버튼/Space 재생 **36/36** 통과.
- 실앱: PTS=5초/오디오 +0.5초 파일의 재생·export 무음 보존 확인. 실제 한국어 8초 변형 파일의 첫 단어 0.532초, 19/20 aligned(사람 기준 정확도 아님).
- 검증: **Vitest 46 files/295 tests, Python 32 tests**, web/node 타입·build·diff 검사 통과.
- 잔여: 미지원 음절/사람 라벨, 긴 파일 스트리밍·캐시 용량 상한/전환 취소, 설치본 runtime/model/GPU, SAR/회전/4K/DPI, 실제 IME·장문. SAR 무시 경로를 새로 발견했으며 아직 수정 전이다. 최신 상세/재현/제한은 인계서 최상단.

전체 계획은 미완료다. 로컬 소스와 빌드를 갱신했으며 사용자 기존 앱은 종료하지 않았다. 재시작 후 최신 빌드를 사용해야 한다. 커밋·배포·reset credit 사용은 하지 않았다.


## 2026-10-12 새벽 — 최신 진행

- 완료: 프로젝트 v2/v1 migration, 빈 슬롯·삭제/분할·수동/정렬 메타·강조 설정 저장 보존, 전체 미디어 SHA-256과 누락/불일치 재연결, 원자적 프로젝트 저장, 새 영상 선택 시 저장 경로 해제.
- 추가 오류 수정: 영상 미연결 상태에서 자막/컷이 초기화됨, 메타데이터만 변경한 편집/Undo 누락, 실패한 정렬의 이전 charSpans 재사용.
- 완료: 발음 입력/복원 UI, 실제 정렬이 성공한 수정 문장의 어절 분할과 자식 ID, 30초 초과 줄의 bounded window/overlap 및 충돌 검토, 최초 추출의 정밀/빠른 모드 선택(기본 정밀, 개발 runtime 자동 탐색).
- 실앱: 프로젝트 저장/재열기/원본 재연결, 발음만 수정한 Undo/Redo, `3배` 표기를 유지한 발음 정렬, 문장 재입력 → 어절 분할 → 저장/Undo/Redo 통과.
- 실영상: 일반 최초 추출 정밀 모드 CPU 40,083ms, **122/128 aligned(6 unaligned)**. 기존 raw를 한 긴 줄로 합친 검사 **121/128 aligned**, 추가 1개는 chunk 경계 충돌로 검토. 두 수치 모두 coverage이며 사람 정답 정확도가 아니다.
- 검증: Vitest **43 files/287 tests**, Python **31 tests**, web/node 타입·build·diff 검사 통과.
- 잔여: 미지원 음절/사람 경계 평가, nonzero PTS의 ASR/RMS/waveform/WebAudio 공통 원점, 장시간 스트리밍·임의 단어 선택, 설치본 runtime/model/GPU, 4K·IME·장문·전체 편집 조합. 상세 재현/결과 파일/제한은 `open-issues-handoff.md` 최상단.

이전 미커밋 변경을 포함해 로컬에 보존했다. 배포·reset credit 사용은 하지 않았다.

## 2026-10-11 저녁 재개 — 최신 진행

완료한 범위: 숫자 발음·표기 매핑, 문자 정렬 메타 저장, 현재 줄 부분 재정렬 IPC/UI, 실제 worker 취소·timeout 종료, 오래된 정렬 응답 폐기, 재정렬 Undo/Redo, 문장 전체 삭제 후 칩 복구, 전체 출력 decode 검사, 내보내기 결과 안내.

실영상 결과: 128개 중 **122개 aligned/6개 unaligned(95.3125% coverage)**. 정확도 측정값이 아니다. `1초만에`/`5종을` 개선, `캡`/`둡` 미지원과 `3배` 읽기는 남았다. 실제 앱 취소·편집 중 응답 폐기·Undo·정상 재정렬·단어 강조 내보내기 통과. 결과 영상은 1920×1080/AAC48kHz/64.266667초이며 전체 decode 통과. 최초 출력 0.5초 프레임에서 단어 강조 확인.

검증: 최종 전체 Vitest **39 files/273 tests**, Python **25개**, web/node 타입 검사, production build, diff 공백 검사 통과. 상세 결과/잔여 작업은 `open-issues-handoff.md` 최상단에 있다.

**전체 계획은 미완료**: 프로젝트 v2, 설치본 runtime, 30초 초과 chunk, 새 어절 자동 분할, 미지원 문자/읽기 UI, 사람 기준 품질평가, 최초 전사 PTS 통합, 4K/SAR/회전/DPI 검증이 남아 있다. 이번 작업은 개발 환경의 실행·회귀 검증까지이며 커밋/배포하지 않았다.

---

## 2026-10-11 재개 작업 결과 (최신)

사용자가 Claude 수정 이후 재점검을 요청했고, 글자 단위 삭제를 선택했으며 실제 한국어 영상을 제공했다. 아래 이전 기록은 당시 결과이며 최신 상태는 이 절과 `open-issues-handoff.md` 상단을 따른다.

| 범위 | 이번 완료 | 남은 일 |
|---|---|---|
| 재생·싱크 UI | 칩 클릭 정지/이동 원자화, 즉시 Space 포커스 수정, 비동기 재생 취소 세대, WebAudio 중복/무음 방지 | 장시간·장치 전환·Bluetooth 검증 |
| 편집 | 글자 단위 Backspace/Delete, IME draft 처리, 칩 실시간 갱신, 텍스트 수정 stale·원본 시간 보존 | 정확한 새 단어 분할/재정렬, 실제 한글 IME·Undo/Redo·장문 성능 |
| 타입·데이터 | renderer 기존 오류 28개 제거, token 변환의 정렬 메타/edge-merge 보존 | 프로젝트 v2·전체 ID 수명 검증 |
| 전사 장치 | 준비/CPU/GPU 상태·진단 표시, lazy CUDA 오류도 CPU 재시도 | 사용자 설치 GPU DLL·패키징 |
| 정밀 정렬 | 제공 영상 64.266초의 앱 accurate 경로 성공, 128개 중 120개 aligned/8개 unaligned | 미지원 문자·숫자, 사람 기준 경계 오차, 충분한 검증 세트 |
| 내보내기·런타임 | 기존 FFmpeg 회귀 검사 포함 전체 테스트 통과 | UI부터 단어 강조 export, 전체 decode, DPI/4K/SAR/회전, 취소 worker |

검증: **Vitest 36 files/264 tests**, **Python 17 tests**, web/node 타입 검사, production build, git diff --check 통과. 실앱 재생 조합은 합성 음성·실영상 기본 정렬·실영상 accurate 각각 **36/36**. 실제 출력 WebAudio 소스 수와 clock 차이 검사. 실영상 문자 삭제·포커스·blur 이전 칩 갱신도 통과. accurate의 무음 칩 옆 Backspace는 미디어 삭제이므로 문자 테스트는 인접 발화 칩을 골라 검증했다.

실영상 accurate: CPU fallback 포함 **67.721초**, coverage **93.75%**. 미정렬 8개는 unsupported_character(`캡쳐…`, `모아둡니다`, 숫자 혼용어). coverage를 경계 정확도로 해석하면 안 된다. 수동 경계가 없어 median/p95와 CER/WER는 아직 미측정이다. `tools/sync-validation-output/real-video-accurate.json`에 raw/정렬 결과를 보관했다.

전체 계획 완료는 아니다. 남은 항목의 우선순위·재현 정보는 `open-issues-handoff.md`의 최신 절에 기록했다. 변경은 로컬 저장, 커밋/배포하지 않았다. 기존 pyc 변경 보존, 사용량 초기화 크레딧 미사용.

---

작성: 2026-10-11. 기준 계획: `autosubtitle-desktop-sync-development-plan.md`.
이번 작업은 전체 완료가 아니다. 사용량 잔여 약 1%에 접근하면 진행 중 변경을 정리하고 종료한다는 사용자 요청에 따른 중간 인계다. 사용량 초기화 크레딧은 사용하지 않았다.

## 단계별 상태

| 계획 단계 | 상태 | 완료 내용 / 남은 내용 |
|---|---|---|
| 1. 기준 측정 | 부분 완료 | 기존 180개 테스트·빌드 통과 확인, 컷 미적용 재현, clock/export 코드 추적. 실제 한국어 라벨 측정·앱 동작 비교 미완료 |
| 2. 정렬 PoC | 부분 완료 | 격리 Python 3.12 CPU 환경, WhisperX 어댑터·품질 집계·CLI·모델 추론 확인. 실제 한국어 품질·GPU·RAM/VRAM 평가 미완료 |
| 3. 계약 도입 | 일부 구현 | source/program clip plan, PoC 단어 상태, **`SubtitleWord` 정렬 메타데이터(ID·상태·엔진 추정치·manual lock) 파싱·저장·Peaks 편집 경로 보존**(2차). 사이드카→앱 IPC 연결·프로젝트 v2 migration·undo 트랜잭션 미완료 |
| 4. 칩·재생 | 일부 구현 | 공통 `activeWordResolver` 도입, 칩 목록 4곳 적용(2차). 실제 출력 clock 통합·부분 재정렬(`realign_words`)·undo·웹 UX 비교표 미완료 |
| 5. 버닝 | 상당 부분 구현 | 1차: A/V 컷·반복 clip·종료/timeout·CPU 재시도·임시 출력 검증. 2차: **단어 강조 렌더 스케줄·프레임 단위 스트리밍 오버레이·메모리 제한 캡처 풀·내보내기 UI 옵션**. 전체 decode 검증·DPI/폰트/SAR/회전/4K 검사·실앱 UI 통합 검증 미완료 |
| 6. 설치본 | 미착수 | 개발 빌드만 통과. 새 정렬 런타임은 설치본에 포함하거나 기본 활성화하지 않음 |

1단계에서 발견한 컷 미적용을 재현·수정하기 위해 5단계의 일부 작업을 선행했다. 품질 검증 전 UI 대규모 변경은 하지 않았다.

## 2차 작업 (같은 날 이어서)

계획서 3~5단계 중 검증 영상·수동 라벨 없이 진행 가능한 부분을 구현했다. 정렬 정확도 측정(2단계)·설치본(6단계)은 자료/환경이 없어 그대로다.

### 추가·변경

- `src/shared/activeWordResolver.ts`(+test): 반개구간 `start <= t < end`, gap은 빈 결과, 선행/지연 상수 없음. `SubtitleVirtualList.tsx`의 인라인 비교 4곳을 교체(기존 의미 보존: 삭제 단어 skip 여부 등 옵션으로 유지).
- `src/shared/wordAlignmentMeta.ts`(+test): `id/alignmentStatus/alignmentScore/sourceStart·End/rawStart·End/engine/modelRevision/reviewReasons/manualStartLocked·EndLocked` 검증 파싱. 상태 없는 레거시 단어는 `estimated`로 취급(aligned 오표시 방지). 편집 규칙: 경계 이동→해당 쪽 lock+`manual`(엔진 추정치 유지), 정렬된 단어의 글자 변경→`stale`.
- `subtitles.ts`: `SubtitleWord`에 메타 필드 추가, `parseSubtitleLines`가 보존(저장 파일 round-trip 포함). `vrewSubtitleAdapter.mergeVrewRowsIntoSubtitleLines`가 편집을 `markWordEdited`로 반영.
- `src/shared/exportRenderSchedule.ts`(+test): cue·단어(원본 시간)와 clip plan → 출력 프레임 상태 구간. 프레임 시작 시각 판정, 컷/반복 occurrence 처리, 무음 gap에서 강조 꺼짐·줄 유지, 마지막 단어를 줄 끝까지 늘리지 않음, 프레임에 닿지 않는 단어는 상태 미생성, 겹친 cue는 먼저 시작한 것이 우선(기존 오버레이와 동일). 줄 텍스트와 단어 조각이 다르면 일반 렌더로 되돌림.
- `ffmpeg-single-pass.ts`: 오버레이 입력을 프레임 구간 스트림(`createOverlayReadable`)으로 교체. `overlayStates` 팩토리(재시도 시 새 소스)와 기존 `rawBgraBuffers+timing`(레거시) 둘 다 지원. 스트림이 닫히면 캡처 소스도 정리.
- `exportLogic.ts`: `openSubtitleCapturePool().stream()` — 순서 보장·소비자보다 앞서 캡처하는 양 제한(`창수×2+2`장)·취소·실패 전파·조기 종료 정리.
- `index.ts`: 영상 export가 스케줄→캡처 풀→FFmpeg 스트림으로 동작. `wordHighlightColor`는 `#rgb/#rrggbb/#rrggbbaa`만 허용.
- `ExportSubtitle.tsx`: 단어 `<span>` 렌더. 프레임마다 강조 상태를 완전히 교체(이전 프레임 잔류 방지).
- `App.tsx`/`App.css`: 내보내기 형식이 영상일 때 "단어 강조" 체크+색 선택(기본 꺼짐, 세션 상태이며 `.autosub`에는 저장하지 않음).
- `ipc.ts`: `subtitles[].words`, `ExportSubtitleStyle.wordHighlightColor`, `ExportSubtitleUpdatePayload.words/activeIndex`.

### 2차 검증 결과

- 전체 vitest **33 파일 / 250 통과**(실제 FFmpeg 통합 7개 포함, `AUTOSUBTITLE_TEST_FFMPEG_DIR` 지정). 1차 대비 +57.
- 신규 FFmpeg 통합: 앞 2초 컷 + 단어 2개 → 컷 이후 program 1~2초/2~3초에 각각 초록/빨강 상태 프레임, 구간 밖은 베이스 영상, 출력 길이 4초.
- 신규 캡처 풀 테스트(Electron 모킹): 순서, 메모리 제한(40개 중 소비자 1개 소비 시 캡처 ≤13), 조기 종료·취소·실패 전파, 인코더 재시도용 재스트림.
- **실제 Electron offscreen 창**(`out/renderer/exportSubtitle.html`, 640×360)에서 확인: 강조 색 픽셀 무게중심이 activeIndex 0→x≈222(왼쪽), 1→x≈421(오른쪽)이고, 강조 없는 payload 뒤에는 강조 픽셀 0. 이 확인은 일회성 스크립트이며 저장소 테스트에는 포함하지 않았다.
- `tsc -p tsconfig.node.json` 통과, `npm run build` 통과, Python unittest 9개 통과. `tsconfig.web.json`은 기존부터 오류 30개가 있었고(HEAD 기준) 이번 변경 후 28개로 새 오류는 없다.

### 2차에서 하지 않은 것 / 알려진 한계

- **앱 전체 실행(IME·수동 편집·실제 내보내기 버튼) 검증 없음.** 내보내기 경로는 단위·통합·Electron 렌더 단위로만 확인했다.
- 정렬 엔진(WhisperX)은 여전히 앱에 연결되지 않았다. 그래서 단어 메타데이터는 앱이 생성하지 않고, 저장 파일/사이드카 응답에 있을 때만 보존된다. 정확도(coverage/오차)는 미측정.
- 단어 개수가 바뀌는 편집(분할·합치기)은 `vrewRowsToSubtitleLines` 전면 교체 경로를 타서 해당 줄 단어 메타데이터가 사라진다(레거시=estimated로 취급되므로 오표시는 아님). ID 기반 매칭은 미구현.
- 단어 강조는 현재 발화 단어 전체 색 변경이다. 줄이 2줄로 줄바꿈되는 경우·폰트 fallback·DPI는 미검증. 단어 상태가 많은 긴 영상은 캡처 횟수(상태 수×약 0.15초/창수)만큼 시간이 늘 수 있다.
- 오디오 단독 export와 SRT/VTT/ASS는 단어 강조를 지원하지 않는다(줄 단위 그대로).
- `.autosub` 버전은 1 그대로다(필드가 추가된 v1). v2 migration은 미구현.

## 3차 작업 — 정렬 실측과 accurate 모드 연결

### 합성 한국어 음성 실측 (첫 정확도 신호)

`scripts/alignment-tts-bench.ps1`(Windows SAPI Heami로 8문장·66단어 생성)와 `scripts/alignment-tts-bench.py`로 같은 음성에 세 방식을 비교했다. 전사(ASR) 텍스트는 66/66 일치했다.

| 방식 | 문장 첫 단어 시작 − 실제 소리 시작(에너지 5%) | 전체 단어 시작 − SAPI 이벤트 |
|---|---|---|
| Whisper 원본 | 중앙값 −120ms (−105~−150) | 중앙값 −60ms, p95 140ms |
| 현재 RMS 보정 | 중앙값 −120ms (Whisper와 동일) | 중앙값 −60ms, p95 140ms |
| WhisperX 강제 정렬 | **중앙값 +8ms (−29~+36)** | 중앙값 +61ms, p95 110ms |

해석과 한계:

- **SAPI 이벤트는 실제 소리 시작보다 15~80ms 빨라 기준 자체가 편향**되어 있다. 그래서 단어별 오차는 신뢰 구간이 넓고, 독립 기준(에너지 onset)은 문장 첫 단어 8개뿐이다. 따라서 "전체 단어 평균 몇 ms"라고 단정하지 않는다.
- 이 음성에서 현재 RMS 보정은 Whisper 원본을 거의 바꾸지 못했다(선행 무음 0.1초대). 첫 단어를 무음 구간 안에서 시작시키는 Whisper의 편향이 그대로 남는다.
- **합성 음성은 사람 목소리·잡음·음악·겹말·빠른 구어를 대표하지 않는다.** 실제 영상·사람이 표기한 경계로 20클립/1,000경계 평가가 여전히 필요하다.
- `.venv-alignment`의 PyAV가 faster-whisper 로더와 맞지 않아 벤치는 FFmpeg로 오디오를 직접 디코드한다(앱 런타임의 문제가 아니라 PoC venv의 문제).

### accurate 모드 (기본 꺼짐)

- `python_sidecar/align_worker.py`: 정렬 전용 인터프리터에서 실행되는 워커(stdout은 JSON 전용, 로그는 stderr).
- `python_sidecar/alignment_runner.py`: 워커를 서브프로세스로 호출하고 응답을 검증(단어 수 불일치·타임아웃·잘못된 응답은 `AlignmentUnavailable`). ASR 런타임에 torch/whisperx를 들이지 않는다.
- `forced_align.align_korean(strict=False)`: 30초 초과 등 정렬 불가 줄만 `unaligned`로 남기고 나머지는 계속 정렬한다.
- `main.py` `transcribe`: `alignment_mode="accurate"` 또는 환경변수 `AUTOSUBTITLE_ALIGNMENT=accurate`일 때 정렬을 시도하고, 성공하면 **RMS 보정을 덮어쓰지 않는다**. 실패하면 사유를 `alignmentSummary.reviewReasons`에 남기고 기존 RMS 경로로 돌아간다.
- 사용하려면 환경변수 `AUTOSUBTITLE_ALIGNMENT=accurate`, `AUTOSUBTITLE_ALIGN_PYTHON=<정렬 venv의 python.exe>`가 필요하다. 모델은 `AUTOSUBTITLE_ALIGN_CACHE`(기본 `<models>/hf-align-cache`)에 받는다. **설치본에는 정렬 런타임이 포함되어 있지 않으므로 UI 옵션은 아직 만들지 않았다.**
- Electron main이 `[진단] 단어 정렬: whisperx · 정렬됨 N/M · 검토 필요 K` 줄을 내보낸다.
- 실제 `transcribe` RPC를 두 모드로 돌려 확인: accurate 첫 단어 +8ms(−29~+36), 단어 수 일치 8/8, 폴백 사유 없음.
- 알려진 한계: 오디오 시작 PTS가 0이 아닌 파일은 Whisper 시간축과 정렬 시간축이 어긋날 수 있다(`source_origin_sec`를 사이드카가 아직 모른다). 렌더러의 추출 후 처리(`splitLeadingSilenceInSubtitleLines`)는 이미 소리 시작에 있는 정렬 단어를 바꾸지 않는 것을 단위 테스트로 확인했지만 실앱에서는 확인하지 않았다.

## 4차 작업 — 단어칩 키보드 편집 (실제 앱 CDP 재현으로 확인)

사용자 피드백("칩에서 키보드로 커서 옮기기가 불편, Vrew처럼")에 따라 실제 Electron 앱에 드롭→전사→키 입력을 넣어 재현했다.

재현된 문제:
- 줄 마지막 칩에서 `→`가 다음 줄이 아니라 **줄 텍스트 입력창**으로 들어가 글자 단위로 이동(37글자 줄이면 38번).
- `↓/↑`가 "칩 → 텍스트창 → 다음 줄 첫 칩"으로 한 줄에 두 번, 가로 위치는 항상 0번으로 리셋.
- 문장 사이 무음 카드(`--` 한 칩)를 매번 거침. 칩이 줄바꿈된 카드는 카드 안 다음 줄로 못 감.
- 칩 사이에서 글자를 쳐도 무시됨(수정하려면 텍스트창을 마우스로 눌러야 함).

변경(`SubtitleVirtualList.tsx`):
- 줄 끝 `→` = 다음 줄 첫 칩 앞(이전 줄로 가는 `←`와 대칭).
- `↓/↑` = 화면상 바로 아래/위 줄에서 **가로 위치가 가장 가까운 칩 사이**로 이동. 줄바꿈된 카드는 같은 카드의 다음 줄 먼저, 무음뿐인 카드는 건너뜀.
- `F2` = 텍스트 입력창으로 들어가기(줄 전체를 고칠 때). 텍스트창에서 `↓`는 다음 자막 줄 첫 칩.
- 칩 사이에서 글자·한글 조합을 시작하면 그 위치 오프셋으로 텍스트 입력창에 포커스를 옮겨 **그 자리에서 바로 입력**.
- 실앱 확인: `→` 줄 경계 통과, `↓/↑` 무음 카드 스킵과 가로 위치 유지, F2, 영문/IME 입력이 칩 사이 위치에 삽입됨.
- 건드리지 않은 것: `Backspace`/`Delete`는 여전히 단어 단위 삭제(+무음이면 오디오 삭제), `Enter`는 줄 분할.

## 5차 작업 — 클릭 직후 Space 재생 실패 수정, ↓ = 편집창

### 클릭 직후 Space 로 재생이 안 되던 문제 (실앱 재현 → 수정 → 재검증)

재현(`scripts/e2e-cdp/click-then-space.mjs`, 7개 칩 × 지연 0/20/60/120/300ms):

| 시나리오 | 수정 전 | 수정 후 |
|---|---|---|
| 멈춘 상태에서 칩 클릭 → Space (0~120ms) | 3~4 / 7 | **7 / 7** |
| 재생 중 칩 클릭 → Space (0~300ms) | 0~1 / 7 (엉뚱한 줄에서 계속 재생) | **7 / 7** |

원인 두 가지:
1. `App.tsx seekAndPlayTo` 의 "직전 이동과 같은 위치면 420ms 안에는 무시" 디듑이 **직전 종류가 단순 시크(클릭)여도** 적용되어, 클릭 직후의 Space 재생 요청이 조용히 버려졌다. `playEditRange` 와 같이 `kind === 'seek'` 는 디듑 대상에서 제외.
2. 재생 중 클릭으로 재생이 멈추면 **재생 중이던 줄**의 "멈춘 위치로 캐럿 복귀" 동기화가 뒤늦게 실행되어 사용자가 클릭한 캐럿의 포커스와 Space 의도를 덮어썼다(행마다 ref 라 가드가 다른 행에 닿지 않음). 클릭으로 인한 일시정지는 모듈 전역 시각(1.2초)으로 이 동기화를 건너뜀.

마우스+키보드 조합 9개 시나리오(`mouse-keyboard-combo.mjs`) 모두 통과: 클릭→→/←→Space(다음/이전 단어에서 재생), 연속 클릭→Space(두 번째 칩), Space 재생/정지/재생, 재생 중 다른 칩 클릭→Space, 편집창에서 Space 는 공백 삽입(재생 안 함).

### ↓ 로 편집창으로 내려가기

- 칩 줄에서 `↓` = **곧바로 이 카드의 텍스트 편집창**(캐럿 오른쪽 단어 첫 글자 앞). 칩이 줄바꿈되어 여러 줄이어도 한 번에 내려간다.
- 편집창에서 `↓` = 다음 자막 줄 칩(글자 위치 비율에 해당하는 칩 사이, 무음 카드 건너뜀), `↑` = 이 카드의 칩(커서 글자 위치에 해당하는 칩 사이).
- 칩 줄에서 `↑` = 앞쪽 자막 줄의 편집창. `F2` = 캐럿 위치로 편집창 진입.
- 칩 위치 ↔ 글자 오프셋 변환은 `subtitleWordCaretMap.ts`(`textOffsetForStorageCaret`, `storageCaretForTextOffset`)에 테스트와 함께 둠.

## 이번에 수정한 동작 (1차)

- `clipPlan.ts`: 원본 시간 보존, 컷 범위 제한·중복 처리, 순서·반복 occurrence와 자막 구간 변환.
- 영상 export: 같은 clip plan으로 A/V와 자막을 편집. 기존 renderer가 보내는 cutRanges를 계획으로 변환한다. 명시적 clipPlan IPC도 수용하지만 renderer의 순서 변경 UI와 연결은 아직 없다.
- 출력은 현재 **30fps CFR** 정책이다. 프레임 시작 시각으로 자막 상태를 판정한다. 짧은 반복 클립은 누적 경계를 반올림하고 음성은 별도 sample 단위 concat으로 처리한다.
- 공통 원점으로 A/V PTS 정규화. 늦게 시작하는 오디오·짧은 오디오는 무음 보존. 마지막 자막이 일찍 끝나도 영상 끝을 보존한다.
- ffprobe가 없는 기존 설치에서 export 시 준비하는 경로 추가.
- FFmpeg spawn 직후 종료 이벤트 수집, timeout/창 닫힘/앱 종료 시 프로세스 종료, 진행률 microsecond 단위 수정.
- 임시 출력에 인코딩하고 길이·오디오 존재·처음 1초 decode 검사 후 최종 경로로 승격. 하드웨어 인코더 실패 시 동일 데이터로 CPU 재시도. 전체 영상 decode 검증은 아직 구현하지 않았다.
- Python gap 처리: 줄 표시 종료 연장과 발화 종료 분리, 겹말 유지, 단어 메타데이터 보존, RMS 실패 보고, raw 전사 결과 보존, 후처리 완료 전 100% 표시 방지.
- 기존 main.py의 `temperature=0.0`, `condition_on_previous_text=False`, `no_speech_threshold=0.6` 변경과 기존 pyc 변경을 보존했다.
- 메인 타입 검사에서 발견한 offscreen 옵션 위치·dialog parent·stderr payload 타입·테스트 readonly·ES module 설정 오류를 수정했다.

## 검증 결과

- 변경 전: 26개 테스트 파일 / 180개 테스트 통과, 개발 빌드 통과.
- 변경 후: 29개 테스트 파일 / **193개 테스트 통과**. 이 중 실제 FFmpeg 통합 테스트 6개.
- Python unittest **9개 통과**.
- `npx tsc --noEmit -p tsconfig.node.json` 통과.
- `npm run build` 통과. 기존 package module type 및 Browserslist 경고는 남아 있다.
- FFmpeg 통합 테스트: 앞 2초 컷 화면색/음성 주파수, 자막 없는 tail, 오디오 없음/짧음, video PTS=5초와 audio +0.5초 offset, spawn 오류/timeout/사전 취소, 50ms clip 20회 반복 길이·오디오 연속성.
- 수정 전 앞 2초 컷 테스트는 삭제할 빨간 화면이 남아 실패했다. 수정 후 파란 화면과 880Hz 음성이 확인됐다.
- Electron 실제 창 캡처·한글 IME·수동 편집·최종 자막 픽셀 비교·설치본은 아직 실행 검증하지 않았다.

통합 테스트 실행 시 PowerShell에서 `AUTOSUBTITLE_TEST_FFMPEG_DIR`를 `tools/sync-validation-bin`의 절대경로로 지정하고 `npm test`를 실행한다. 환경변수가 없으면 실제 FFmpeg 6개 테스트는 skip된다. Python 테스트는 `.venv-alignment/Scripts/python.exe -B -m unittest discover -s python_sidecar/tests -v`로 실행할 수 있다.

## 정렬 PoC 재현 정보

- `.venv-alignment`: Python 3.12, whisperx 3.8.6, torch/torchaudio 2.8.0+cpu, transformers 4.57.6. pip check 통과.
- `requirements-alignment.txt`에 주요 버전, `requirements-alignment-cpu-win.lock.txt`에 실제 설치 버전 전체를 기록했다. CPU wheel 설치에는 PyTorch CPU index가 필요하다.
- 한국어 모델: `kresnik/wav2vec2-large-xlsr-korean`, revision `629c9a3501c10ba128bf3fa1eebb12af3be03f61`.
- 모델 로드·0.5초 입력 forward 결과 `[1,24,1205]`, vocabulary 1207개. 합성 tone으로 어댑터 전체 호출·JSON 저장도 확인했다.
- **합성 tone의 aligned 결과는 정확도 증거가 아니다.** 강제 정렬은 잘못된 텍스트에도 시간을 줄 수 있다. 실제 음성·사람이 표기한 경계를 사용한 coverage/median/p95 검증이 필수다. 현재 CER/WER, 시작/끝 오차, 실영상 coverage는 모두 미측정이다.
- CLI `scripts/alignment-poc.py --help`: raw ASR JSON, 미디어, FFmpeg, 캐시 경로, 모델 SHA를 명시해야 한다. 수동 라벨 JSON `{id,start,end}` 목록을 주면 경계 평가한다. 라벨 없으면 `not_measured`다.
- 문자 대응 불일치·미지원 문자·누락 점수는 sourceStart/sourceEnd=null과 unaligned로 남긴다. legacy start/end는 raw fallback이므로 정확한 경계로 취급하면 안 된다.
- PoC는 30초 초과 세그먼트를 거부한다. 장시간 chunk/overlap, 작업 취소 worker, 미디어 범위 전체 검증, ASR raw/RMS/WhisperX 자동 비교, CER/WER 보고는 추가 구현이 필요하다.

## 다음에 이어갈 순서

0. (2차 이후) 실제 앱에서 영상 로드→편집→"단어 강조" 내보내기를 한 번 수동 확인하고 결과 영상의 단어 경계 전후 프레임을 눈/청취로 확인.
1. 사용자의 검증 영상 경로와 수동 단어 경계 확보. 최소 20 clips/30분/1,000 boundaries 목표에 맞게 개발/검증 자료 분리.
2. raw Whisper/RMS/WhisperX를 같은 전사문으로 측정하고 실제 전사를 포함한 평가도 별도 진행. 모델 score를 정확도 확률로 표시하지 말 것.
3. 실패 구간·OOV·숫자·혼용어·문자 매핑을 실영상에서 보완하고 runtime/메모리 검증 후 앱에 accurate 모드 연결.
4. 문서 3~4단계: ID/품질 보존을 wordContract·vrew adapter·저장 parser까지 확장, 공통 activeWordResolver, 실제 출력 clock 통합, 프로젝트 v2·undo·오래된 응답 방지.
5. 버닝: 단어 snapshot/render schedule·render-ready revision·bounded cache·전체 decode·DPI/폰트/SAR/회전/4K 검증. 오디오 단독 export는 현재 기존 cut 경로이며 명시적 순서/반복 clipPlan은 오류로 거부한다.
6. GPU, Python 없는 Windows 설치본, 취소와 정리, 오프라인 모델 재사용 검증.

## 산출물과 참고

- `tools/sync-validation-output/`: 합성 원본/결과 mp4·mkv, vitest/build 로그, 모델/어댑터 smoke JSON. 용량이 큰 바이너리·캐시·venv와 함께 git에서 제외했다.
- 웹 참고 정적 확인: 캐럿 focus/키 이동/재생 복귀 함수, edge-drag flatten/apply 함수, overlay timing module. 웹의 `PREVIEW_OVERLAY_BRIDGE_SEC=0.07`은 가져오지 않았다. 클릭·split/merge·삭제/복구·파형·undo/redo의 실제 앱 간 비교표는 미완료다.
- desktop clock 정적 확인: `WebAudioMasterPlayback`이 BufferSource 출력과 source media time을 제공하고 App에서 여러 곳이 읽는다. 현재 실제 앱 재생 trace로 master 통합을 검증한 상태는 아니다.
- 기술 확인: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [WhisperX alignment API](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py), [WhisperX 3.8.6](https://pypi.org/project/whisperx/3.8.6/). VoiceStudio 소스는 복사하지 않았다.

변경은 작업 폴더에 저장되어 있으며 커밋/배포하지 않았다. 전체 작업 완료율은 단순 파일 개수로 계산하지 않는다.
