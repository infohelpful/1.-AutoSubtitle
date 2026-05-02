import { createContext, useContext, type ReactNode } from 'react'

import type { SubtitleLine } from '../../shared/subtitles'

type SubtitleDataContextValue = {
  subtitles: SubtitleLine[]
}

const SubtitleDataContext = createContext<SubtitleDataContextValue | null>(null)

export function SubtitleDataProvider({
  subtitles,
  children
}: {
  subtitles: SubtitleLine[]
  children: ReactNode
}): JSX.Element {
  return <SubtitleDataContext.Provider value={{ subtitles }}>{children}</SubtitleDataContext.Provider>
}

export function useSubtitleData(): SubtitleDataContextValue {
  const ctx = useContext(SubtitleDataContext)
  return ctx ?? { subtitles: [] }
}

