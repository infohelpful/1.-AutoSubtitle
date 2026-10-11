import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_runner import AlignmentUnavailable, resolve_alignment_python, run_accurate_alignment

CUES = [{"start": 0.0, "end": 1.0, "text": "a b", "words": [
    {"start": 0.0, "end": 0.5, "word": "a"}, {"start": 0.5, "end": 1.0, "word": "b"}]}]

ECHO_WORKER = """
import json, sys
req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
cues = req["cues"]
for cue in cues:
    for i, w in enumerate(cue["words"]):
        w.update(id="c:%d" % i, alignmentStatus="aligned", sourceStart=w["start"] + 0.01, sourceEnd=w["end"],
                 start=w["start"] + 0.01)
print("library noise that must not matter", file=sys.stderr)
sys.stdout.write(json.dumps({"schemaVersion": 1, "subtitles": cues, "modelRevision": req["revision"],
                             "alignmentSummary": {"totalWords": 2}}))
"""


class AlignmentRunnerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def worker(self, source: str) -> Path:
        path = Path(self.dir.name) / "worker.py"
        path.write_text(source, encoding="utf-8")
        return path

    def run_with(self, source: str, **kwargs):
        return run_accurate_alignment(json.loads(json.dumps(CUES)), "media.mp4", "ffmpeg", cache_dir="cache",
                                      python=sys.executable, worker=self.worker(source), **kwargs)

    def test_missing_runtime_is_a_reported_fallback_reason(self):
        with self.assertRaisesRegex(AlignmentUnavailable, "alignment_runtime_missing"):
            resolve_alignment_python(str(Path(self.dir.name) / "nope.exe"))

    def test_returns_validated_worker_reply(self):
        result = self.run_with(ECHO_WORKER)
        self.assertEqual(result["subtitles"][0]["words"][0]["alignmentStatus"], "aligned")
        self.assertEqual(result["modelRevision"], "629c9a3501c10ba128bf3fa1eebb12af3be03f61")

    def test_worker_error_exit_is_unavailable(self):
        with self.assertRaisesRegex(AlignmentUnavailable, "alignment_failed: boom"):
            self.run_with("import sys\nprint('{\"error\": \"boom\"}')\nsys.exit(1)\n")

    def test_garbage_stdout_is_unavailable(self):
        with self.assertRaisesRegex(AlignmentUnavailable, "alignment_bad_reply"):
            self.run_with("print('not json')\n")

    def test_dropped_words_are_rejected_instead_of_silently_accepted(self):
        source = ECHO_WORKER.replace('cues = req["cues"]', 'cues = req["cues"]\ncues[0]["words"] = cues[0]["words"][:1]')
        with self.assertRaisesRegex(AlignmentUnavailable, "alignment_word_count_mismatch"):
            self.run_with(source)

    def test_timeout_is_unavailable(self):
        with self.assertRaisesRegex(AlignmentUnavailable, "alignment_timeout"):
            self.run_with("import time\ntime.sleep(30)\n", timeout_sec=0.5)


if __name__ == "__main__":
    unittest.main()
