"""Remove build-only files from the isolated alignment runtime (torch/WhisperX venv).

torch's Windows wheel ships static/import libraries (``torch/lib/*.lib``, ~2.7GB, dnnl.lib alone
~2.3GB). They are only used to compile C++ extensions against torch; running Python never loads
them. Removing them shrinks the runtime from ~4.0GB to ~1.3GB.

Dry run by default. Run this again after every pip install/upgrade of torch:
  python scripts/strip-alignment-runtime.py --venv .venv-alignment            # report only
  python scripts/strip-alignment-runtime.py --venv .venv-alignment --apply    # delete
  python scripts/strip-alignment-runtime.py --venv .venv-alignment --apply --backup-dir <dir>  # move
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def site_packages(venv: Path) -> Path:
    candidates = [venv / "Lib" / "site-packages", *sorted(venv.glob("lib/python*/site-packages"))]
    for path in candidates:
        if path.is_dir():
            return path
    raise SystemExit(f"site-packages not found under {venv}")


def build_only_files(packages: Path) -> list[Path]:
    torch_lib = packages / "torch" / "lib"
    if not torch_lib.is_dir():
        return []
    return sorted(p for p in torch_lib.glob("*.lib") if p.is_file())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--venv", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="actually remove the files")
    parser.add_argument("--backup-dir", type=Path, help="with --apply, move files here instead of deleting")
    args = parser.parse_args(argv)

    packages = site_packages(args.venv.resolve())
    files = build_only_files(packages)
    total = sum(p.stat().st_size for p in files)
    for path in files:
        print(f"{path.stat().st_size:>14,}  {path.relative_to(packages)}")
    print(f"{len(files)} files, {total:,} bytes ({total / 1024**3:.2f} GiB)")
    if not args.apply:
        print("dry run; pass --apply to remove")
        return 0
    for path in files:
        if args.backup_dir:
            dest = args.backup_dir / path.relative_to(packages)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(dest))
        else:
            path.unlink()
    print(("moved to " + str(args.backup_dir)) if args.backup_dir else "removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
