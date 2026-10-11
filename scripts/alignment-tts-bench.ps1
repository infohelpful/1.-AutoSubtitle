# Generates Korean test speech with Windows SAPI (Microsoft Heami) plus the engine's word-start events.
# Usage: pwsh scripts/alignment-tts-bench.ps1 -OutDir <dir>
# Output per sentence: sN.wav (16 kHz mono), sN.events.tsv (audioPosition<TAB>charPos<TAB>charCount<TAB>word), sN.txt
#
# CAVEAT: this is synthetic speech. SAPI word events run ~15-80 ms ahead of the audible onset, so they are
# a biased reference; alignment-tts-bench.py therefore also reports the first word against an acoustic onset.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Voice = 'Microsoft Heami Desktop')

New-Item -ItemType Directory -Force $OutDir | Out-Null
Add-Type -ReferencedAssemblies System.Speech, System.Collections, System.Runtime, System.Text.Encoding.Extensions -TypeDefinition @"
using System; using System.Collections.Generic; using System.Speech.Synthesis; using System.Speech.AudioFormat;
public static class AutoSubTtsBench {
  public static string Run(string voice, string text, string wav, int rate) {
    var list = new List<string>();
    using (var s = new SpeechSynthesizer()) {
      s.SelectVoice(voice); s.Rate = rate;
      s.SetOutputToWaveFile(wav, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
      s.SpeakProgress += (o, e) => list.Add(e.AudioPosition.TotalSeconds.ToString("F4") + "\t" + e.CharacterPosition + "\t" + e.CharacterCount + "\t" + e.Text);
      s.Speak(text);
    }
    return string.Join("\n", list);
  }
}
"@

$sentences = @(
  @{ t = '오늘은 날씨가 정말 좋아서 공원에서 친구들과 함께 산책을 했습니다.'; r = 0 },
  @{ t = '이번 영상에서는 자막을 자동으로 만드는 방법에 대해서 설명드리겠습니다.'; r = 0 },
  @{ t = '먼저 영상을 불러오고, 잠시 기다리면 목소리가 글자로 바뀝니다.'; r = 1 },
  @{ t = '빠르게 말하면 단어 사이의 경계가 흐려지기 때문에 정렬이 더 어려워집니다.'; r = 3 },
  @{ t = '저는 어제 저녁에 집에 가서 맛있는 김치찌개를 끓여 먹었어요.'; r = 0 },
  @{ t = '정확한 타이밍은 사용자 경험에 매우 중요한 요소입니다.'; r = -1 },
  @{ t = '그러면 지금부터 하나씩 차근차근 살펴보도록 하겠습니다.'; r = 2 },
  @{ t = '내일 아침 일찍 일어나서 운동을 하고 회사에 출근할 예정입니다.'; r = 0 }
)
for ($i = 0; $i -lt $sentences.Count; $i++) {
  $wav = Join-Path $OutDir ("s{0}.wav" -f $i)
  $events = [AutoSubTtsBench]::Run($Voice, $sentences[$i].t, $wav, $sentences[$i].r)
  Set-Content -Path (Join-Path $OutDir ("s{0}.events.tsv" -f $i)) -Value $events -Encoding UTF8
  Set-Content -Path (Join-Path $OutDir ("s{0}.txt" -f $i)) -Value $sentences[$i].t -Encoding UTF8
}
"Generated $($sentences.Count) clips in $OutDir"
