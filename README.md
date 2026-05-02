# AutoSubtitle

로컬 영상에 대해 **Faster-Whisper**로 자막을 뽑고, 편집·스타일 조정·구간 컷·다양한 형식으로 내보내는 **Electron** 데스크톱 앱입니다. UI는 **React**, 음성 인식·FFmpeg 합성은 **Python 사이드카**(stdio JSON 라인)가 담당합니다.

## 주요 기능 (개발 내역)

### 음성 인식 (Whisper)

- **faster-whisper** + CTranslate2, Hugging Face [`deepdml/faster-whisper-large-v3-turbo-ct2`](https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2) 모델
- `models/`에 모델이 없으면 **Hugging Face**에서 내려받기; 다운로드·로드 진행률을 UI에 표시
- **GPU(CUDA) 우선**, 런타임 오류 시 **CPU로 자동 폴백**
- 전사 시 **VAD**, **단어별 타임스탬프**, 무음 구간 보정(`_fill_unvoiced_gaps` 등)으로 자막 후보 정리
- Windows에서 CUDA DLL 부족 시 **GPU 런타임 설치** 안내·설치 IPC (`gpu:status` / `gpu:install`)

### 영상·프로젝트

- 영상 파일 선택 또는 **창으로 드래그 앤 드롭**, `.autosub` 프로젝트도 드롭으로 열기
- 상단 바에서 **불러오기** · **다른 이름으로 저장** · **저장** (`.autosub` JSON, 버전 1)
- 프로젝트에 포함: 영상 경로, **컷 구간**(분석·내보내기에 사용), 자막 목록, 미리보기와 동일한 **자막 스타일** 설정

### 자막 편집·미리보기

- 좌우 **분할 레이아웃**: 영상 미리보기 / 자막 목록(가변 폭, 드래그로 리사이즈)
- 자막 목록은 **가상 스크롤**(`react-window`)로 대량 구간에 대응
- 미리보기에서 **폰트·크기·색·굵기·외곽선·배경(색·불투명도·패딩)·화면 위치(X/Y)** 조정, 시스템 폰트 목록·최근 폰트

### 내보내기

- **영상**: 오프스크린 렌더러에서 줄별 자막을 PNG로 캡처 → Python이 FFmpeg로 **투명 레이어 오버레이** 합성(인코더·해상도에 따른 분기 포함)
- **자막 파일**: SRT, WebVTT(가운데 정렬), ASS(스타일·정렬), 순수 텍스트
- **오디오만**: MP3, WAV (컷 구간 반영)

### 데스크톱·의존성

- **Electron** 메인 프로세스: 대화상자, 파일 저장/열기, **FFmpeg** 준비(`ffbinaries` 등), 인코더 프로브, 내보내기 오케스트레이션
- **Python**은 별도 프로세스; 배포 시 `python_sidecar`는 **extraResources**로 포함. 사용자 PC에 **Python**이 있어야 사이드카가 동작합니다.

## 기술 스택

| 영역 | 사용 기술 |
|------|------------|
| UI | **React** 19, **Vite**, **electron-vite** |
| 데스크톱 | **Electron** (메인 / 프리로드 / IPC) |
| 백엔드 로직 | **Python** 사이드카 (`python_sidecar/`) |
| 음성 인식 | **faster-whisper**, Hugging Face **Large v3 Turbo** CT2 모델 |

빌드 도구는 **electron-vite**이며, Node **20.19+** 또는 **22.12+** 사용을 권장합니다.

## 사전 요구 사항

1. **Node.js** — 위 버전 범위.
2. **Python 3.10+** — 터미널에서 `python`(Windows) 또는 `python3`(macOS / Linux)으로 실행 가능해야 합니다.  
   - 다른 인터프리터를 쓰려면 환경 변수 **`PYTHON_PATH`**에 실행 파일 전체 경로를 지정합니다.
3. **GPU(선택)** — CUDA가 잡히면 Faster-Whisper가 GPU를 우선 사용하고, 실패 시 CPU로 넘어갑니다.

## 설치

프로젝트 루트에서:

```bash
npm install
pip install -r python_sidecar/requirements.txt
```

- `npm install` — Electron, React, electron-vite 등 프런트·데스크톱 의존성.
- `pip install …` — 사이드카용 **faster-whisper**, **huggingface_hub**, **tqdm** 등.

## 실행

개발 모드(렌더러 HMR + Electron):

```bash
npm run dev
```

앱에서 **Whisper 모델 준비**를 누르면 프로젝트 루트의 `models/` 아래에 모델이 없을 경우 Hugging Face에서 내려받은 뒤 로드합니다. 다운로드 진행률은 Electron을 통해 UI에 반영됩니다.

## 기타 명령

| 명령 | 설명 |
|------|------|
| `npm run build` | 프로덕션용 번들 생성 |
| `npm run preview` | 빌드 결과로 Electron 미리보기 |
| `npm run dist` | electron-builder로 설치 패키지 생성 |

`electron-builder`는 `python_sidecar`를 `extraResources`로 포함합니다. 배포 후에도 사용자 PC에 **Python**이 설치되어 있어야 사이드카가 동작합니다. Python을 묶은 단일 실행 파일이 필요하면 PyInstaller 등으로 별도 빌드한 뒤 spawn 경로를 바꾸면 됩니다.

## 프로젝트 구조 (요약)

| 경로 | 역할 |
|------|------|
| `src/main/` | 창, `dialog`, IPC, Python 프로세스·stdio, FFmpeg·GPU 준비, 내보내기 로직 |
| `src/preload/` | `contextBridge`로 `window.api` 노출 |
| `src/renderer/` | React UI (`App`, 자막 목록, `ExportSubtitle` 오프스크린 등) |
| `src/shared/` | IPC 타입, `.autosub` 스키마, 자막 유틸 |
| `python_sidecar/` | JSON-RPC 스타일 stdin/stdout, Whisper·HF 다운로드·영상 합성 |

## IPC 흐름 (요약)

렌더러 → `window.api.sidecarCall(method, params)` → 프리로드 → 메인 → Python stdin에 요청 한 줄 → Python이 stdout에 응답 한 줄 → Promise로 렌더러에 반환. 모델 다운로드·전사 진행률은 Python **stderr** JSON이 메인에서 감지되어 `model:download-progress`, `transcribe:progress` 등으로 전달됩니다.

## 라이선스

**누구나** 이 소스·빌드 산출물을 **가져다 써도 됩니다.** 상업적 이용·수정·재배포·포크 모두 제한 없이 가능합니다. 법률적 근거는 저장소 루트의 [`LICENSE`](LICENSE) 파일(The Unlicense, 퍼블릭 도메인에 준하는 허용)을 따릅니다.

