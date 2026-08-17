import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { EventernoteClient } from './eventernote.js'
import { safeFetchImage } from './safe-fetch.js'

const MAX_UPLOAD_BYTES = 5_000_000
const EVENTERNOTE_IMAGE_SIZE = 1_000

type EventImageSource =
  | { kind: 'remote'; url: string }
  | { kind: 'uploaded'; bytes: Uint8Array }

type EventImageUploader = Pick<EventernoteClient, 'addEventImage'>

async function convertToJpeg(sourcePath: string, jpegPath: string): Promise<void> {
  for (const quality of [90, 75, 60]) {
    await sharp(sourcePath, { limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: EVENTERNOTE_IMAGE_SIZE,
        height: EVENTERNOTE_IMAGE_SIZE,
        fit: 'contain',
        background: '#000000',
      })
      .jpeg({ quality, progressive: false })
      .toFile(jpegPath)
    if ((await stat(jpegPath)).size <= MAX_UPLOAD_BYTES) return
  }
  throw new Error('圖片轉換後仍超過 5 MB')
}

export async function uploadEventImageAsJpeg(
  uploader: EventImageUploader,
  eventId: string,
  source: EventImageSource,
): Promise<string> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'eventernote-autofill-'))
  const sourcePath = join(workDirectory, 'source-image')
  const jpegPath = join(workDirectory, 'event.jpg')

  try {
    const sourceBytes = source.kind === 'remote'
      ? (await safeFetchImage(source.url)).bytes
      : source.bytes
    await writeFile(sourcePath, sourceBytes, { flag: 'wx' })
    try {
      await convertToJpeg(sourcePath, jpegPath)
    } catch (error) {
      if (error instanceof Error && error.message === '圖片轉換後仍超過 5 MB') throw error
      throw new Error('圖片轉換成 JPEG 失敗')
    }
    const jpegBytes = await readFile(jpegPath)
    return await uploader.addEventImage(eventId, jpegBytes, 'image/jpeg', 'event.jpg')
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}
