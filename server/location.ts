import type { DescriptionLanguage, EventData, SourceKind } from '../shared/types.js'

const TICKETING_HOSTS = [
  'kktix.com', 'eplus.jp', 'pia.jp', 'l-tike.com', 'ticketmaster.', 'eventbrite.',
  'zaiko.io', 'livepocket.jp', 'passmarket.yahoo.co.jp', 'ticketflap.com', 'cityline.com',
  'urbtix.hk', 'art-mate.net', 'ibon.com.tw', 'tixcraft.com',
]

export function classifySource(urlValue: string): SourceKind {
  const hostname = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, '')
  if (hostname === 'eventernote.com') return 'eventernote'
  if (hostname === 'x.com' || hostname === 'twitter.com' || hostname.endsWith('.x.com')) return 'x'
  if (hostname === 'facebook.com' || hostname.endsWith('.facebook.com') || hostname === 'fb.watch') return 'facebook'
  if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) return 'instagram'
  if (TICKETING_HOSTS.some((host) => hostname.includes(host))) return 'ticketing'
  return 'official'
}

export function languageForCountry(countryCode: string): DescriptionLanguage {
  if (countryCode === 'JP') return 'ja'
  if (countryCode === 'HK' || countryCode === 'TW' || countryCode === 'MO') return 'zh-Hant'
  if (countryCode === 'CN') return 'zh-Hans'
  if (countryCode === 'KR') return 'ko'
  return 'en'
}

export function inferCountry(text: string, htmlLanguage = ''): string {
  const value = `${text} ${htmlLanguage}`.normalize('NFKC')
  const rules: Array<[string, RegExp]> = [
    ['HK', /香港|Hong\s*Kong|Kowloon|AsiaWorld|九龍|新界/i],
    ['TW', /台灣|台湾|Taiwan|Taipei|台北|高雄|Kaohsiung|台中|Taichung/i],
    ['MO', /澳門|澳门|Macau|Macao/i],
    ['JP', /日本|Japan|東京都|東京|大阪|神奈川|横浜|名古屋|愛知|福岡|札幌|仙台|沖縄|京都|埼玉|千葉/i],
    ['KR', /韓国|한국|Korea|Seoul|서울|Busan|부산/i],
    ['CN', /中國|中国|Mainland\s*China|Shanghai|Beijing|上海|北京|深圳|广州|廣州/i],
    ['SG', /Singapore|新加坡/i],
    ['MY', /Malaysia|Kuala\s*Lumpur|馬來西亞|马来西亚/i],
    ['TH', /Thailand|Bangkok|泰國|泰国|กรุงเทพ/i],
    ['US', /United\s*States|\bUSA\b|New\s*York|Los\s*Angeles|San\s*Francisco/i],
    ['GB', /United\s*Kingdom|\bUK\b|London/i],
  ]
  return rules.find(([, pattern]) => pattern.test(value))?.[0] ?? ''
}

export function isOnlineOnlyEvent(data: EventData): boolean {
  const place = data.place.name.normalize('NFKC').trim().toLowerCase()
  const onlinePlaces = new Set([
    'online', 'online streaming', 'live stream', 'livestream', 'virtual', 'webcast',
    'オンライン', 'オンライン配信', 'ライブ配信', '配信', '線上', '线上', '直播',
  ])
  if (onlinePlaces.has(place)) return true
  if (data.place.address.trim() || data.place.countryCode.trim()) return false
  return /(?:オンライン(?:配信)?|online(?:\s+streaming)?|線上|线上|直播)/i.test(`${data.title} ${place}`)
}
