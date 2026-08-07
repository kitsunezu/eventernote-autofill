import { safeFetchImage } from './safe-fetch.js'

export function validImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (mimeType === 'image/webp') return Buffer.from(bytes.slice(0, 4)).toString() === 'RIFF'
    && Buffer.from(bytes.slice(8, 12)).toString() === 'WEBP'
  return false
}

export async function loadImagePreview(url: string): Promise<Awaited<ReturnType<typeof safeFetchImage>>> {
  const image = await safeFetchImage(url)
  if (!validImageSignature(image.bytes, image.mimeType)) throw new Error('圖片內容與檔案格式不符')
  return image
}
