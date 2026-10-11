"""Run with the isolated alignment interpreter. Transcript JSON contains raw ASR subtitles."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python_sidecar"))
from forced_align import align_korean
from alignment_quality import evaluate_boundaries

parser = argparse.ArgumentParser()
parser.add_argument("--media", required=True)
parser.add_argument("--transcript", required=True)
parser.add_argument("--ffmpeg", required=True)
parser.add_argument("--cache-dir", required=True)
parser.add_argument("--model-revision", required=True)
parser.add_argument("--source-origin", type=float, default=0)
parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
parser.add_argument("--labels", help="JSON list of human-labeled {id,start,end} words")
parser.add_argument("--output", required=True)
args = parser.parse_args()
data = json.loads(Path(args.transcript).read_text(encoding="utf-8-sig"))
cues = data if isinstance(data, list) else data.get("raw_subtitles", data.get("subtitles"))
result = align_korean(cues, args.media, args.ffmpeg, args.cache_dir, args.model_revision, args.device, args.source_origin)
if args.labels:
    labels = json.loads(Path(args.labels).read_text(encoding="utf-8-sig"))
    result["evaluation"] = evaluate_boundaries(labels, [w for cue in result["subtitles"] for w in cue["words"]])
else:
    result["evaluation"] = {"status": "not_measured", "reason": "Human boundary labels were not supplied"}
Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
