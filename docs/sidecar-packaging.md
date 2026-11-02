# Python 사이드카 빌드·검증

2026-10-13 검증 환경: Windows, Python 3.12, PyInstaller 6.22.3/hooks 2026.8, faster-whisper 1.2.1, PyAV 18.0.0. ASR은 CTranslate2, 정밀 정렬은 별도 Python/torch/WhisperX 런타임을 사용한다.

## 수정한 배포 오류

- JSON-RPC가 stdin/stdout을 사용하는데 `main.spec`가 `console=False`였다. Windows windowed 빌드에서는 표준 스트림이 `None`이므로 `console=True`로 수정했다. Electron의 `windowsHide: true`는 유지한다. [PyInstaller 공식 문서](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#sys-stdin-sys-stdout-and-sys-stderr-in-noconsole-windowed-applications-windows-only)
- 별도 인터프리터가 파일 경로로 실행하는 `align_worker.py`와 관련 소스 5개(`alignment_audio.py` 포함)를 PyInstaller data로 포함했다. torch/WhisperX/transformers는 ASR 번들에서 제외한다.
- 실제 frozen 전사에서 `metadata_errors` 인자 오류를 재현했다. faster-whisper 1.2.1과 PyAV 19의 호환성 문제이며 PyAV 18.0.0으로 고정했다. 사이드카 requirements와 정렬 requirements/lock에 동일하게 반영했다. [faster-whisper upstream issue](https://github.com/SYSTRAN/faster-whisper/issues/1589)
- 빌드 실패/종료 신호/산출물 누락 시 오래된 `dist/main.exe`를 재사용하지 않는다. 고유 임시 디렉터리에서 빌드하고, `get_model_status`와 `runtime_check`의 정상 JSON 응답을 검사한 뒤 staging 파일을 최종 경로로 rename한다. 실패하면 기존 최종 파일을 보존한다.
- `runtime_check`는 모델을 다운로드하거나 로드하지 않고 짧은 WAV 디코딩, VAD ONNX, 정렬 worker 소스 존재를 확인한다. 전체 음성 인식 검증은 별도 smoke를 실행해야 한다.

## 빌드

프로젝트 루트에서 Python 3.12 가상환경에 `python_sidecar/requirements-build.txt`를 설치하고 `npm run bundle:sidecar`를 실행한다. 인터프리터 선택 순서는 `AUTOSUBTITLE_BUILD_PYTHON`, `PYTHON_PATH`, `.venv-sidecar-build`, `.venv-alignment`, 시스템 Python이다. 공백이 포함된 경로도 shell 없이 전달한다.

```powershell
$env:AUTOSUBTITLE_BUILD_PYTHON = 'E:\Develop Program\1. AutoSubtitle\.venv-alignment\Scripts\python.exe'
& $env:AUTOSUBTITLE_BUILD_PYTHON -m pip install -r python_sidecar/requirements-build.txt
npm run bundle:sidecar
```

결과는 `resources/bin/main.exe`다. 현재 이 파일은 git 추적 대상이므로 바이너리 변경도 작업 트리에 남는다. `npm run dist`는 앱 build와 사이드카 build를 거쳐 설치 파일을 생성하지만, 이번 검증에서 설치 파일을 생성·배포하지는 않았다.

## 실제 실행 파일 검사

`scripts/frozen-sidecar-smoke.py`에 `--exe`, 짧은 canonical WAV의 `--audio`, `--ffmpeg`, `--audiowaveform`, 새 JSON 결과 `--output`을 전달한다. `--alignment-python`으로 별도 정렬 인터프리터를 지정하면 정밀 정렬도 검사한다. 기존 결과/파형 파일은 덮어쓰지 않는다.

이 검사는 `%APPDATA%/AutoSubtitle/models`의 기존 모델을 오프라인으로 사용한다. 8초 한국어 fixture에서 다음 결과를 확인했다.

- frozen JSON-RPC/오디오 디코드/VAD/worker 소스 검사 통과
- 실제 모델 로드·전사·파형 생성 통과
- 빠른 모드 `appliedEngine=rms`, 진단 오류 없음
- 정밀 모드 `appliedEngine=whisperx`, CPU 19/20 aligned, 진단 오류 없음

최신 결과는 `tools/sync-validation-output/frozen-sidecar-mapped-smoke.json`과 `.stderr.log`에 있다. 19/20은 coverage이며 사람 기준 경계 정확도가 아니다. 새 정렬 모듈을 포함한 실행 파일은 152,076,482 bytes이고 빌드 로그는 `alignment-mapped-bundle.log`다.

## 정렬 입력 메모리

`alignment_audio.py`는 FFmpeg 출력 전체를 stdout bytes/ndarray로 복사하지 않고 자동 삭제되는 임시 파일을 매핑한다. 기존 16kHz mono float32 샘플과 절대 시각은 유지한다. 임시 디스크는 약 64kB/초가 추가로 필요하고, OS 페이지 캐시와 모델 RAM은 별개다. `scripts/alignment-audio-bench.py`로 모델 없는 전체 디코드 메모리와 짧은 실영상의 기존/새 정렬 결과 동일성을 재현할 수 있다. context 외부로 오디오 참조를 보관해 사용하면 안 된다.

## 정렬 runtime·모델 용량 (2026-11-03)

- 정렬 모델은 `model.safetensors`와 JSON 설정만 받는다(`forced_align.MODEL_DOWNLOAD_PATTERNS`). 저장소의 `pytorch_model.bin`(같은 가중치)과 `training_args.bin`은 받지 않는다. 신규 다운로드는 2.53GB에서 1.27GB로 줄었다. 예전에 둘 다 받아 둔 캐시는 다음 정렬 시 `prune_redundant_model_files`가 중복 파일을 지운다. 다른 revision이 같은 blob을 가리키면 blob은 남긴다.
- torch Windows wheel의 `torch/lib/*.lib`(약 2.58GiB, `dnnl.lib`만 2.3GB)는 C++ 확장 빌드용이며 실행 시 읽지 않는다. torch 설치·업그레이드 후 `python scripts/strip-alignment-runtime.py --venv .venv-alignment --apply`를 실행한다(기본은 dry run). `.venv-alignment`가 4.0GB에서 1.4GB로 줄었다.
- 검증: 35초 한국어 실영상(`false-silence-source-35s.mp4`, raw 74단어)의 실제 CPU 정렬 결과 JSON이 변경 전 기준값과 완전히 같았다(기준값을 두 번 실행해 결정적임도 확인). Python 80 tests(FFmpeg 통합 포함) 통과.

## 미완료

정렬 Python/torch runtime와 정렬/ASR 모델의 설치본 배포, 새 PC/GPU/오프라인 첫 설치 검증은 남았다. 현재 정밀 정렬 검사는 개발 가상환경을 명시적으로 지정했으므로, 배포된 앱만으로 정밀 모드가 준비됐다는 뜻이 아니다. 전체 ASR/모델 메모리, 정렬 TEMP 드라이브의 사전 여유 공간 검사·작업 중 디스크 상한도 남았다.
