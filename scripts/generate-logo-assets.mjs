import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import sharp from 'sharp'

const assetPath = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url))
const source = assetPath('logo-mark.svg')

await Promise.all([
  [32, assetPath('favicon-32x32.png')],
  [180, assetPath('apple-touch-icon.png')],
  [512, assetPath('logo-mark-512.png')],
].map(([size, output]) => sharp(source).resize(size, size).png().toFile(output)))

const socialPreview = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#191a1e"/>
        <stop offset="1" stop-color="#2d3040"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="url(#background)"/>
    <circle cx="1050" cy="80" r="260" fill="#5865f2" opacity="0.12"/>
    <circle cx="110" cy="600" r="220" fill="#e0ae67" opacity="0.08"/>
    <rect x="96" y="96" width="438" height="438" rx="72" fill="#232428" stroke="#3e4050" stroke-width="2"/>
    <image href="data:image/svg+xml;base64,${Buffer.from(await fs.readFile(source)).toString('base64')}" x="157" y="157" width="316" height="316"/>
    <text x="606" y="255" fill="#f8f9ff" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="700">Eventernote</text>
    <text x="606" y="335" fill="#f8f9ff" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="700">Autofill</text>
    <rect x="606" y="379" width="96" height="6" rx="3" fill="#e0ae67"/>
    <text x="606" y="442" fill="#c9cad5" font-family="Arial, Helvetica, sans-serif" font-size="30">Extract. Review. Confirm.</text>
  </svg>
`)
await sharp(socialPreview).png().toFile(assetPath('social-preview.png'))

const png = await fs.readFile(assetPath('favicon-32x32.png'))
const header = Buffer.alloc(22)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
header[6] = 32
header[7] = 32
header.writeUInt16LE(1, 10)
header.writeUInt16LE(32, 12)
header.writeUInt32LE(png.length, 14)
header.writeUInt32LE(header.length, 18)

await fs.writeFile(assetPath('favicon.ico'), Buffer.concat([header, png]))
