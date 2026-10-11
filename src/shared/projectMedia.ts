/** Whole-file digest; paths and modification times are not media identity. */
export type MediaFingerprint = { algorithm: 'sha256'; size: number; digest: string }
export type MediaFingerprintResult =
  | { ok: true; fingerprint: MediaFingerprint }
  | { ok: false; reason: string }

export function parseMediaFingerprint(raw: unknown): MediaFingerprint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  return v.algorithm === 'sha256' && Number.isSafeInteger(v.size) && Number(v.size) >= 0 &&
    typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest)
    ? { algorithm: 'sha256', size: Number(v.size), digest: v.digest } : null
}

export function sameMedia(a: MediaFingerprint, b: MediaFingerprint): boolean {
  return a.algorithm === b.algorithm && a.size === b.size && a.digest === b.digest
}
