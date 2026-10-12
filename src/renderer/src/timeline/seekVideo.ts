/** currentTime updates before decoding completes; only seeked means the frame is ready. */
export function seekVideoElementTo(video: HTMLVideoElement, targetSec: number): Promise<void> {
  const target = Math.max(0, targetSec)
  if (!video.seeking && Math.abs(video.currentTime - target) < .002) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('seeked', ready)
    }
    const ready = () => {
      if (video.seeking || Math.abs(video.currentTime - target) >= .05) return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('영상 탐색 시간이 초과됐습니다.')) }, 5000)
    video.addEventListener('seeked', ready)
    if (Math.abs(video.currentTime - target) >= .002) video.currentTime = target
  })
}
