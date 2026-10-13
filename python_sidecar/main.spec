# -*- mode: python ; coding: utf-8 -*-
#
# faster-whisper VAD: silero_vad_v6.onnx 등이 faster_whisper/assets 에 있음.
# datas 비우면 frozen exe에서 NO_SUCHFILE (main.log 의 ONNXRuntimeError).

from PyInstaller.utils.hooks import collect_data_files
from pathlib import Path

datas = collect_data_files("faster_whisper")
# Executed by the separate interpreter; these must be physical source files.
for name in ("align_worker.py", "forced_align.py", "alignment_contract.py", "alignment_text.py", "alignment_windows.py"):
    datas.append((str(Path(SPECPATH) / name), "."))

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # CTranslate2 ASR and the external torch/WhisperX runtime stay isolated.
    excludes=["torch", "whisperx", "transformers"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="main",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    # stdin/stdout are JSON-RPC pipes; Electron already uses windowsHide=True.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
