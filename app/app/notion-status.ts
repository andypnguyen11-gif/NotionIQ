export type BannerTone = 'success' | 'error'
export interface Banner {
  tone: BannerTone
  message: string
}

const BANNERS: Record<string, Banner> = {
  connected: { tone: 'success', message: 'Notion connected.' },
  denied: { tone: 'error', message: 'Notion connection was denied.' },
  invalid: {
    tone: 'error',
    message: 'That connection link was invalid or expired. Please try again.',
  },
  error: { tone: 'error', message: 'Something went wrong connecting Notion. Please try again.' },
}

export function notionStatusBanner(status: string | undefined): Banner | null {
  if (!status) return null
  return BANNERS[status] ?? null
}
