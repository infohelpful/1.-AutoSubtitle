import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from forced_align import MODEL_DOWNLOAD_PATTERNS, prune_redundant_model_files


def _write(path: Path, size: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    return path


def _symlink(link: Path, target: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(os.path.relpath(target, link.parent), link)


class DownloadPatternTests(unittest.TestCase):
    def test_only_safetensors_weights_are_requested(self):
        self.assertIn("model.safetensors", MODEL_DOWNLOAD_PATTERNS)
        self.assertIn("*.json", MODEL_DOWNLOAD_PATTERNS)
        self.assertFalse(any(p.endswith(".bin") for p in MODEL_DOWNLOAD_PATTERNS))


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.repo = Path(self.dir.name) / "models--kresnik--wav2vec2-large-xlsr-korean"
        self.snapshot = self.repo / "snapshots" / "rev1"

    def symlinks_supported(self) -> bool:
        probe = Path(self.dir.name) / "probe"
        try:
            os.symlink("missing", probe)
        except OSError:
            return False
        probe.unlink()
        return True

    def test_plain_files_are_removed_and_safetensors_kept(self):
        _write(self.snapshot / "model.safetensors", 10)
        _write(self.snapshot / "config.json", 2)
        _write(self.snapshot / "pytorch_model.bin", 10)
        _write(self.snapshot / "training_args.bin", 3)
        self.assertEqual(prune_redundant_model_files(self.snapshot), 13)
        self.assertEqual(sorted(p.name for p in self.snapshot.iterdir()), ["config.json", "model.safetensors"])

    def test_nothing_is_removed_without_safetensors(self):
        _write(self.snapshot / "pytorch_model.bin", 10)
        self.assertEqual(prune_redundant_model_files(self.snapshot), 0)
        self.assertTrue((self.snapshot / "pytorch_model.bin").is_file())

    def test_second_run_is_a_no_op(self):
        _write(self.snapshot / "model.safetensors", 10)
        _write(self.snapshot / "pytorch_model.bin", 10)
        prune_redundant_model_files(self.snapshot)
        self.assertEqual(prune_redundant_model_files(self.snapshot), 0)

    def test_symlinked_blob_is_removed_with_its_link(self):
        if not self.symlinks_supported():
            self.skipTest("symlinks need Developer Mode or admin on Windows")
        safetensors = _write(self.repo / "blobs" / "aaa", 10)
        weights = _write(self.repo / "blobs" / "bbb", 10)
        _symlink(self.snapshot / "model.safetensors", safetensors)
        _symlink(self.snapshot / "pytorch_model.bin", weights)
        self.assertEqual(prune_redundant_model_files(self.snapshot), 10)
        self.assertFalse(weights.exists())
        self.assertFalse((self.snapshot / "pytorch_model.bin").is_symlink())
        self.assertTrue((self.snapshot / "model.safetensors").is_file())

    def test_blob_shared_with_another_revision_is_kept(self):
        if not self.symlinks_supported():
            self.skipTest("symlinks need Developer Mode or admin on Windows")
        safetensors = _write(self.repo / "blobs" / "aaa", 10)
        weights = _write(self.repo / "blobs" / "bbb", 10)
        _symlink(self.snapshot / "model.safetensors", safetensors)
        _symlink(self.snapshot / "pytorch_model.bin", weights)
        _symlink(self.repo / "snapshots" / "rev0" / "pytorch_model.bin", weights)
        self.assertEqual(prune_redundant_model_files(self.snapshot), 0)
        self.assertTrue(weights.is_file())
        self.assertFalse((self.snapshot / "pytorch_model.bin").is_symlink())


if __name__ == "__main__":
    unittest.main()
