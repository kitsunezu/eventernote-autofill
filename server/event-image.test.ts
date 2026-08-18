import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadEventImageAsJpeg } from './event-image.js'
import { safeFetchImage } from './safe-fetch.js'

vi.mock('./safe-fetch.js', () => ({ safeFetchImage: vi.fn() }))

async function temporaryImageDirectories(): Promise<Set<string>> {
  const entries = await readdir(tmpdir())
  return new Set(entries.filter((entry) => entry.startsWith('eventernote-autofill-')))
}

async function pngBytes(width = 24, height = 16, alpha = 1): Promise<Uint8Array> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 220, g: 80, b: 40, alpha },
    },
  }).png().toBuffer()
}

async function avifBytes(width: number, height: number): Promise<Uint8Array> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 220, g: 80, b: 40 },
    },
  }).avif().toBuffer()
}

describe('Eventernote image preparation', () => {
  beforeEach(() => vi.mocked(safeFetchImage).mockReset())

  it('downloads a remote image, preserves its dimensions, converts it to JPEG, and removes temporary files', async () => {
    const before = await temporaryImageDirectories()
    vi.mocked(safeFetchImage).mockResolvedValue({
      bytes: await pngBytes(2_400, 1_350, 0),
      mimeType: 'image/png',
      finalUrl: 'https://images.example/poster.png',
    })
    const addEventImage = vi.fn(async (_eventId: string, bytes: Uint8Array, mimeType: string, fileName: string) => {
      expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
      expect(mimeType).toBe('image/jpeg')
      expect(fileName).toBe('event.jpg')
      const metadata = await sharp(bytes).metadata()
      expect(metadata).toMatchObject({
        width: 2_400,
        height: 1_350,
        format: 'jpeg',
        hasAlpha: false,
        isProgressive: false,
      })
      const stats = await sharp(bytes).stats()
      expect(stats.channels.every((channel) => channel.min >= 250)).toBe(true)
      return 'https://www.eventernote.com/events/123/'
    })

    await expect(uploadEventImageAsJpeg(
      { addEventImage },
      '123',
      { kind: 'remote', url: 'https://images.example/poster.png' },
    )).resolves.toBe('https://www.eventernote.com/events/123/')

    expect(safeFetchImage).toHaveBeenCalledWith('https://images.example/poster.png')
    expect(addEventImage).toHaveBeenCalledOnce()
    expect(await temporaryImageDirectories()).toEqual(before)
  })

  it('removes temporary files when Eventernote rejects the upload', async () => {
    const before = await temporaryImageDirectories()
    const addEventImage = vi.fn(async () => { throw new Error('upload rejected') })

    await expect(uploadEventImageAsJpeg(
      { addEventImage },
      '123',
      { kind: 'uploaded', bytes: await pngBytes() },
    )).rejects.toThrow('upload rejected')

    expect(await temporaryImageDirectories()).toEqual(before)
  })

  it('preserves portrait AVIF dimensions without adding black padding', async () => {
    const addEventImage = vi.fn(async (_eventId: string, bytes: Uint8Array) => {
      const metadata = await sharp(bytes).metadata()
      expect(metadata).toMatchObject({
        width: 308,
        height: 500,
        format: 'jpeg',
        isProgressive: false,
      })
      const stats = await sharp(bytes).stats()
      expect(stats.channels[0].min).toBeGreaterThan(150)
      return 'https://www.eventernote.com/events/123/'
    })

    await uploadEventImageAsJpeg(
      { addEventImage },
      '123',
      { kind: 'uploaded', bytes: await avifBytes(308, 500) },
    )
  })
})
