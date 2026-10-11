"""Offline real-media regression; reuse locally supplied ASR words, never transcribe."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python_sidecar'))
from alignment_runner import run_accurate_alignment
from alignment_windows import plan_alignment_windows

artifacts = ROOT / 'tools' / 'sync-validation-output'
fixture = json.loads((artifacts / 'real-video-fixture.autosub').read_text(encoding='utf-8-sig'))
previous = json.loads((artifacts / 'real-video-normalized.json').read_text(encoding='utf-8-sig'))
raw = previous['raw_subtitles']
words = [word for cue in raw for word in cue['words']]
for index, word in enumerate(words):
    word.setdefault('id', f'long-test:{index}')
cue = {'start': min(c['start'] for c in raw), 'end': max(c['end'] for c in raw),
       'text': ' '.join(w['word'] for w in words), 'words': words}
windows = plan_alignment_windows(cue, 64.267)
print('windows:', [vars(w) for w in windows], flush=True)
reply = run_accurate_alignment([cue], fixture['videoPath'], str(ROOT / 'tools/sync-validation-bin/ffmpeg.exe'),
    cache_dir=str(Path.home() / 'AppData/Roaming/AutoSubtitle/models/hf-align-cache'), python=sys.executable)
aligned = reply['subtitles'][0]['words']
assert len(aligned) == len(words)
assert [w['id'] for w in aligned] == [w['id'] for w in words]
assert [w['word'] for w in aligned] == [w['word'] for w in words]
assert all(w['end'] > w['start'] >= 0 for w in aligned)
(artifacts / 'real-video-long-alignment.json').write_text(json.dumps(reply, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(reply['alignmentSummary'], ensure_ascii=False), flush=True)
print('review:', [(w['word'], w['reviewReasons']) for w in aligned if w.get('reviewReasons')], flush=True)
