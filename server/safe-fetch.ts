import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const MAX_BYTES = 2_000_000
const USER_AGENT = 'EventernoteAutofill/0.1 (+private event metadata importer)'

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address)
  const normalized = address.toLowerCase()
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || normalized.startsWith('fe8')
    || normalized.startsWith('fe9') || normalized.startsWith('fea')
    || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.')
    || normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.')
}

async function assertPublicUrl(value: string): Promise<URL> {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只支援 HTTP 或 HTTPS 網址')
  if (url.username || url.password) throw new Error('網址不可包含登入資料')
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('只允許標準 HTTP/HTTPS 連接埠')
  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('基於安全理由，不可讀取本機或內部網路位址')
  }
  return url
}

export async function safeFetchHtml(input: string): Promise<{ html: string; finalUrl: string }> {
  let current = await assertPublicUrl(input)
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let response: Response
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en;q=0.8,zh-Hant;q=0.7',
        },
      })
    } finally {
      clearTimeout(timeout)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`來源網站回傳無目標的轉址 (${response.status})`)
      current = await assertPublicUrl(new URL(location, current).toString())
      continue
    }
    if (!response.ok) throw new Error(`來源網站回傳 HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('html')) throw new Error('目標不是 HTML 網頁')
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_BYTES) throw new Error('來源頁面超過 2 MB 限制')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('來源網站沒有回傳內容')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('來源頁面超過 2 MB 限制')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { html: new TextDecoder().decode(bytes), finalUrl: current.toString() }
  }
  throw new Error('來源網站轉址次數過多')
}

export async function safeFetchImage(input: string): Promise<{ bytes: Uint8Array; mimeType: string; finalUrl: string }> {
  const maxBytes = 5_000_000
  let current = await assertPublicUrl(input)
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'image/jpeg,image/png,image/webp' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`圖片來源回傳無目標的轉址 (${response.status})`)
      current = await assertPublicUrl(new URL(location, current).toString())
      continue
    }
    if (!response.ok) throw new Error(`圖片來源回傳 HTTP ${response.status}`)
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('圖片只支援 JPEG、PNG 或 WebP')
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > maxBytes) throw new Error('圖片超過 5 MB 限制')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('圖片來源沒有回傳內容')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('圖片超過 5 MB 限制')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, mimeType, finalUrl: current.toString() }
  }
  throw new Error('圖片來源轉址次數過多')
}
