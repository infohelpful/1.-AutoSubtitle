# Vrew 단어 편집기: Peaks.js → Canvas 전면 이전 (설계 노트)

코드 위치 기준. 목표는 **`peaks.js` 런타임 제거** 후 **`package.json` 의존성 삭제**까지.

---

## 1. 현재 상태 (Peaks가 하는 일)

단일 진입점: **`VrewPeaksSubtitleEditor.tsx`**

| 영역 | 구현 위치 | 비고 |
|------|-----------|------|
| 행·단어 블록 UI, 더블클릭으로 행 활성화 | 같은 파일 렌더 (`rows.map`) | 유지 |
| 포털로 파형 DOM 붙이기 (`parkingRef`, `rowWaveMountRef`, `portalHostEl`) | `useLayoutEffect` + `createPortal` | 레이아웃 규칙 유지 가능 |
| 무음 WAV / `<audio>` / `AudioContext` | `silentWav`, `audioRef`, `audioContextRef` | **재생·seek는 유지** (Web Audio 또는 `<audio>`) |
| 파형·줌·오버뷰·세그먼트 드래그 | `Peaks.init({ zoomview, overview, … })` | **교체 대상** |
| 세그먼트 ↔ 단어 동기화 | `applyWordsToPeaks`, `wordsFromPeaksSegments`, `assignFlatWordsToRows`, `applyAdjacentWordMergesToRows` | 드래그 종료 시 **`words[]`만 갱신**하면 됨 — 데이터 경로는 유지 |
| 단어 포커스 시 줌·seek | `focusWordAtTime` → `peaks.player.seek`, `zoomview.setStartTime`, `setZoom` | **`viewWin` 상태 + 오디오 seek**로 치환 |
| 컨테이너 리사이즈 | `safeFitPeaksContainerView` (`peaksSafeFit.ts`) | Canvas면 **`ResizeObserver` + canvas 픽셀 재설정** |
| 세그먼트 마커 UI | `createVrewSegmentMarker.ts` (Konva + `peaks.js` 타입) | **Canvas 오버레이 또는 HTML 오버레이**로 이전 |
| 증분 세그먼트 업데이트 힌트 | `flatWordsPeaksSyncHelpers.ts` (`SegmentOptions`) | Peaks 제거 후 **단어 배열 diff** 또는 전량 repaint 로 단순화 가능 |

---

## 2. 목표 아키텍처 (책임 분리)

### 2.1 유지·얇게 두는 셸

**`VrewPeaksSubtitleEditor` (이름은 나중에 `VrewSubtitleEditor` 등으로 변경 가능)**  

- 행/단어 버튼, 아코디언 그리드, 자막 textarea, 포털 타깃 결정만 담당.
- **파형은 자식 컴포넌트에 위임**: `precomputedWaveformJson`(또는 상위에서 내리는 동일 데이터) + 활성 행의 단어 목록만 props로 전달.

데모 전용 **`VrewPeaksEditorDemo.tsx`**는 같은 props만 넘기도록 유지하면 됨.

### 2.2 새·합치는 파형 패널 (제안 모듈명)

| 모듈 | 책임 | 재사용 소스 |
|------|------|-------------|
| **`VrewRowWaveformCanvas`** (신규, 예: `vrewPeaksEditor/VrewRowWaveformCanvas.tsx`) | 활성 행 한 줄용 **zoom strip + overview strip** (두 캔버스 또는 한 컴포넌트 두 ref) | `SubtitleWaveformCanvas.tsx` 의 `drawWaveformCanvas` / 패닝·휠 줌 / overview 로직 복제·추출 |
| **`waveformCanvasDrawing.ts`** (선택, 추출) | `resolvePeaksTimelineMetrics` + 픽셀 루프 그리기 | `SubtitleWaveformCanvas.tsx` ↔ `SentenceLineWaveformCanvas.tsx` 중복 제거용 공통화 |
| **`viewWindowController.ts`** (선택) | `{ start, end }` 초 단위 뷰포트, 휠 줌 앵커, 드래그 패닝 | `SubtitleWaveformCanvas` 의 `viewWin` / wheel 핸들러 정리 |
| **`segmentHandlesOverlay.tsx`** (신규) | 단어별 `[start,end]`를 픽셀로 투영해 **좌우 핸들 드래그** | Peaks 세그먼트 대신 **상태: 드래그 중인 word id + edge**; 좌표는 `mediaSecToPeakPixelIndex` 역함수 또는 선형 매핑 (`peakPixelMapping.ts`) |

기존 **`WaveformWordConnector.tsx`**  

- 이미 `connectorEditZoomRef` + 칩 DOM으로 세로선 연결.
- Peaks 없을 때는 `peaksReady={false}` 경로 — **줌 창만 부모 ref와 동기화**하면 됨 (`SubtitleWaveformCanvas` 와 동일 패턴).

### 2.3 데이터·시간 축

| 항목 | 담당 |
|------|------|
| 피크 JSON → 샘플 배열·duration | `resolvePeaksTimelineMetrics` (`waveform/peakPixelMapping.ts`) |
| 편집 축 vs 미디어 축 | `precomputedWaveformIsEditAxis` / App 쪽 정책과 동일하게 props 전달 |
| 줄 단위 줌 윈도우 후보 | `computeLineZoomWindow` / `computeLineZoomWindowFromCardBounds` (`lineZoomWindow.ts`) — `focusWordAtTime` 의 pad·이웃 단어 로직과 합칠 수 있음 |

### 2.4 오디오

- **옵션 A**: 기존처럼 `<audio>` + `currentTime` seek (구현 단순).
- **옵션 B**: 메인 앱과 맞추려면 `timeline/webAudioMasterPlayback.ts` 등 기존 재생 스케줄과 동일한 소스 — 상위 `App`에서 이미 쓰는 경로가 있으면 **props/callback으로만 연결** (에디터 단독 데모는 A로도 충분).

---

## 3. 단계별 마이그레이션 (권장 순서)

### Phase A — 추출 (Peaks 유지 병행 가능 아님, 바로 교체 시나리오)

1. `SubtitleWaveformCanvas.tsx`에서 **그리기 + viewWin 상태기**를 함수/훅으로 분리해 **`VrewRowWaveformCanvas`**가 같은 JSON으로 동작하게 만든다.
2. `VrewPeaksSubtitleEditor`의 `zoomRef`/`overviewRef` 자리에 위 컴포넌트를 넣고, **아직 Peaks.init은 호출하지 않음**으로 중간 커밋 가능(파형만 Canvas).

### Phase B — 상호작용

3. 세그먼트 드래그 대체: **오버레이에서 word 경계 핸들 드래그** → `onRowsChange`로만 반영 (기존 `onDragEnd` 체인과 동일).
4. `focusWordAtTime`를 **`setViewWin` + audio seek**로 재작성; `peaksZoomClamp` / App 주석의 샘플레이트 클램프는 **`viewWin.span` 최소·최대**로 이식.

### Phase C — 제거

5. `Peaks.init`, `peaksRef`, `applyWordsToPeaks`, `createVrewSegmentMarker` Peaks 경로 삭제.
6. `peaksSafeFit.ts`, `peaksZoomClamp.ts`(Peaks 전용), `flatWordsPeaksSyncHelpers`의 Peaks 전제 제거 또는 로컬 타입만 남김.
7. **`package.json`에서 `peaks.js` 제거**; `konva`가 마커 전용이었다면 사용처 확인 후 제거.

---

## 4. 삭제·정리 예상 목록 (완료 후)

- 런타임: `Peaks` import 및 **`VrewPeaksSubtitleEditor` 내 init 블록** (~`Peaks.init` … `destroy`).
- `createVrewSegmentMarker.ts`, `createCutPreviewSegmentMarker.ts`, `createCutToolPointMarker.ts` — **Cut 도구가 앱 메인에만 남고 데모에 안 쓰이면** 별도; Vrew 에디터 전용이면 함께 대체 또는 삭제.
- 타입: 전역 `import type … from 'peaks.js'` → `shared/waveformJson.ts` 및 로컬 세그먼트 모양 타입.

---

## 5. 리스크·결정 사항

- **드래그 UX**: Peaks는 overlap 모드·세그먼트 겹침 규칙을 내장 — Canvas 버전은 **`wordMerge` / `mergeAdjacentOverlappingWords`와 동일한 정책**을 명시적으로 호출할지 한 번 더 확인.
- **성능**: 단어 수가 많을 때 오버레이 DOM vs 단일 canvas 위 히트 테스트 — 첫 버전은 **활성 행 단어만** 오버레이해도 됨.
- **데모 앱**: `VrewPeaksEditorDemo`는 피크 JSON mock만 추가하면 전체 플로우 검증 가능.

이 문서는 구현 시 파일명을 바꿔도 되며, **단일 소스 of truth는 실제 PR의 컴포넌트 트리**로 맞추면 된다.
