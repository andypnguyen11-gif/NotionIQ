import { notionStatusBanner } from './notion-status'

export function NotionStatusBanner({ status }: { status: string | undefined }) {
  const banner = notionStatusBanner(status)
  if (!banner) return null
  const tone =
    banner.tone === 'success'
      ? 'border-green-200 bg-green-50 text-green-800'
      : 'border-red-200 bg-red-50 text-red-800'
  return (
    <p role="status" className={`rounded border px-3 py-2 text-sm ${tone}`}>
      {banner.message}
    </p>
  )
}
