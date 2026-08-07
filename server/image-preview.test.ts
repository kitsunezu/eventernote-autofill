import { beforeEach, describe, expect, it, vi } from 'vitest'
import { safeFetchImage } from './safe-fetch.js'
import { loadImagePreview } from './image-preview.js'

vi.mock('./safe-fetch.js', () => ({ safeFetchImage: vi.fn() }))

describe('loadImagePreview', () => {
  beforeEach(() => vi.mocked(safeFetchImage).mockReset())

  it('loads a remote preview only through the safe-fetch boundary', async () => {
    vi.mocked(safeFetchImage).mockResolvedValue({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      mimeType: 'image/jpeg',
      finalUrl: 'https://cdn.example.com/poster.jpg',
    })

    await expect(loadImagePreview('https://example.com/poster.jpg')).resolves.toMatchObject({ mimeType: 'image/jpeg' })
    expect(safeFetchImage).toHaveBeenCalledWith('https://example.com/poster.jpg')
  })

  it('rejects image responses whose bytes do not match the declared format', async () => {
    vi.mocked(safeFetchImage).mockResolvedValue({
      bytes: new TextEncoder().encode('<html>not an image</html>'),
      mimeType: 'image/jpeg',
      finalUrl: 'https://example.com/poster.jpg',
    })

    await expect(loadImagePreview('https://example.com/poster.jpg')).rejects.toThrow('圖片內容與檔案格式不符')
  })
})
