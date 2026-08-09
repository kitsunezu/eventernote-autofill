import { ArrowLeft, ExternalLink } from 'lucide-react'
import { getMessages, type Locale } from './i18n'

type SubmissionSuccessActionsProps = {
  eventUrl?: string
  onBackToLanding: () => void
  locale?: Locale
}

export function SubmissionSuccessActions({ eventUrl, onBackToLanding, locale = 'zh-TW' }: SubmissionSuccessActionsProps) {
  const copy = getMessages(locale)
  return <div className="completion-actions">
    <button type="button" className="secondary-button" onClick={onBackToLanding}>
      <ArrowLeft size={18} />{copy.backHome}
    </button>
    {eventUrl && <a className="primary-button" href={eventUrl} target="_blank" rel="noreferrer">
      {copy.openEventPage} <ExternalLink size={17} />
    </a>}
  </div>
}
