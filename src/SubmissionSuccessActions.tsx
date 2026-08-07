import { ArrowLeft, ExternalLink } from 'lucide-react'

type SubmissionSuccessActionsProps = {
  eventUrl?: string
  onBackToLanding: () => void
}

export function SubmissionSuccessActions({ eventUrl, onBackToLanding }: SubmissionSuccessActionsProps) {
  return <div className="completion-actions">
    <button type="button" className="secondary-button" onClick={onBackToLanding}>
      <ArrowLeft size={18} />回到首頁
    </button>
    {eventUrl && <a className="primary-button" href={eventUrl} target="_blank" rel="noreferrer">
      開啟 Eventernote 活動頁 <ExternalLink size={17} />
    </a>}
  </div>
}
