import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const envFile = new URL('../.env.local', import.meta.url)
if (existsSync(envFile)) {
  Object.assign(process.env, parseEnv(readFileSync(envFile, 'utf8')))
}

await import('./index.js')
