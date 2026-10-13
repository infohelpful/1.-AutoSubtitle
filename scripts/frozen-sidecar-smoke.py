"""Offline JSON-RPC/ASR/RMS/optional alignment check of the packaged helper.

Use a short canonical WAV and existing local models. This does not validate a
fresh machine, GPU, or an installed alignment runtime.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--exe', required=True)
parser.add_argument('--audio', required=True)
parser.add_argument('--ffmpeg', required=True)
parser.add_argument('--audiowaveform', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--alignment-python')
args = parser.parse_args()
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise ValueError('Choose a new output report')
requests = [{'id': 'status', 'method': 'get_model_status', 'params': {}},
            {'id': 'runtime', 'method': 'runtime_check', 'params': {}},
            {'id': 'prepare', 'method': 'prepare_model', 'params': {}}]
for mode in ['fast'] + (['accurate'] if args.alignment_python else []):
    peaks = str(output.with_suffix(f'.{mode}.peaks.json'))
    if Path(peaks).exists():
        raise ValueError('Choose a new waveform output')
    requests.append({'id': mode, 'method': 'transcribe', 'params': {
        'path': str(Path(args.audio).resolve()), 'prepared_audio_path': str(Path(args.audio).resolve()),
        'alignment_mode': mode, 'alignment_python': args.alignment_python,
        'waveform_out_json_path': peaks}})
env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'HF_HUB_OFFLINE': '1',
       'AUTOSUBTITLE_MODELS_DIR': str(Path(os.environ['APPDATA']) / 'AutoSubtitle' / 'models'),
       'AUTOSUBTITLE_FFMPEG_PATH': str(Path(args.ffmpeg).resolve()),
       'AUTOSUBTITLE_AUDIOWAVEFORM_PATH': str(Path(args.audiowaveform).resolve())}
child = subprocess.Popen([str(Path(args.exe).resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, env=env,
                         creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
try:
    stdout, stderr = child.communicate(('\n'.join(json.dumps(r) for r in requests) + '\n').encode(), timeout=240)
except subprocess.TimeoutExpired:
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        child.kill()
    child.communicate(timeout=10)
    raise
output.with_suffix('.stderr.log').write_bytes(stderr)
assert child.returncode == 0, stderr.decode('utf-8', 'replace')[-4000:]
replies = [json.loads(line) for line in stdout.decode('utf-8').splitlines() if line.strip()]
output.write_text(json.dumps(replies, ensure_ascii=False, indent=2), encoding='utf-8')
assert len(replies) == len(requests), 'Missing or noisy RPC replies'
for request, reply in zip(requests, replies):
    assert reply['id'] == request['id'] and 'error' not in reply, reply
    if request['id'] in ('fast', 'accurate'):
        result = reply['result']
        assert result['subtitles'], 'No words returned'
        summary = result['alignmentSummary']
        expected = 'rms' if request['id'] == 'fast' else 'whisperx'
        assert summary['appliedEngine'] == expected, summary
        assert not summary['reviewReasons'], summary
        assert result['waveform_peaks']['ok'], result['waveform_peaks']
        print(request['id'], json.dumps(summary, ensure_ascii=True))
print('PASS frozen helper: JSON-RPC, local model, transcription, waveform and requested alignment')
