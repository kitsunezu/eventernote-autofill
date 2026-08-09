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
