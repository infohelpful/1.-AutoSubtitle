"""Alignment worker: runs in the isolated alignment interpreter (torch/whisperx), never in the ASR runtime.

stdin : one JSON object {cues, media, ffmpeg, cacheDir, revision, device, sourceOrigin}
stdout: one JSON object (ASCII only) - the ``align_korean`` result, or {"error": "..."} with exit code 1
stderr: model/library logs
"""
from __future__ import annotations

import json
import sys
import traceback


def main() -> int:
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # nothing a library prints may corrupt the JSON reply
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        from forced_align import align_korean
        result = align_korean(
            request["cues"], request["media"], request["ffmpeg"], request["cacheDir"],
            request["revision"], request.get("device", "cpu"), float(request.get("sourceOrigin", 0)),
            strict=False,
        )
        reply, code = result, 0
    except Exception as error:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        reply, code = {"error": f"{type(error).__name__}: {error}"}, 1
    real_stdout.write(json.dumps(reply, ensure_ascii=True, allow_nan=False))
    real_stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
