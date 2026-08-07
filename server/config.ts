export interface ServerConfig {
  port: number
  uploadsDir: string
  appToken?: string
  openAiApiKey?: string
  openAiBaseUrl: string
  openAiModel: string
  eventernoteOrigin: string
  eventernoteUsername?: string
  eventernotePassword?: string
  eventernoteWriteEnabled: boolean
  dashboardUrl?: string
  dashboardToken?: string
  dashboardUserId?: string
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function httpsUrl(name: string, fallback: string): string {
  const value = process.env[name] || fallback
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials`)
  }
  return url.toString()
}

function secretValue(name: string, aliasName: string): string | undefined {
  if (process.env[name]) return process.env[name]
  const alias = process.env[aliasName]
  if (!alias) return undefined
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`${aliasName} must name an environment variable`)
  return process.env[alias]
}

export function loadConfig(): ServerConfig {
  return {
    port: positiveInteger('PORT', 8790),
    uploadsDir: process.env.UPLOADS_DIR ?? './data/uploads',
    appToken: process.env.APP_TOKEN,
    openAiApiKey: secretValue('OPENAI_API_KEY', 'OPENAI_API_KEY_ENV'),
    openAiBaseUrl: httpsUrl('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openAiModel: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna',
    eventernoteOrigin: process.env.EVENTERNOTE_ORIGIN ?? 'https://www.eventernote.com',
    eventernoteUsername: process.env.EVENTERNOTE_USERNAME,
    eventernotePassword: process.env.EVENTERNOTE_PASSWORD,
    eventernoteWriteEnabled: process.env.EVENTERNOTE_WRITE_ENABLED === 'true',
    dashboardUrl: process.env.DASHBOARD_API_URL,
    dashboardToken: process.env.DASHBOARD_IMPORT_TOKEN,
    dashboardUserId: process.env.DASHBOARD_USER_ID,
  }
}
