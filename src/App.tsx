import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, CheckCircle2, ExternalLink, FileImage, FileSearch,
  ImagePlus, LoaderCircle, MapPin, Plus, Send, Trash2, Upload,
  UserRound, X,
} from 'lucide-react'
import type {
  ActorDraft, AnalysisStage, AppConfig, Draft, EventData, Evidence, SourceKind,
} from '../shared/types'
import { addHoursToTime } from '../shared/time'
import { api, ApiError, getAccessKey, setAccessKey } from './api'
import ProcessingCard from '@/components/ui/processing-card'

const emptyActor = (): ActorDraft => ({ name: '', reading: '', selectedId: '', createNew: false, candidates: [] })

const sourceLabels: Record<SourceKind, string> = {
  official: '官方網頁', ticketing: '售票網', x: 'X', facebook: 'Facebook',
  instagram: 'Instagram', eventernote: 'Eventernote', other: '其他來源',
}

function statusLabel(status: Draft['status']): string {
  return { review: '待核對', ready: '可以送出', submitting: '送出中', completed: '已完成', failed: '需要處理' }[status]
}

function evidenceLabel(evidence?: Evidence): string | undefined {
  if (!evidence) return undefined
  return { high: '來源資料', medium: '解析結果', low: 'AI 核對', missing: '需確認' }[evidence.confidence]
}

function EvidenceBadge({ evidence }: { evidence?: Evidence }) {
  const tag = evidenceLabel(evidence)
  return tag && evidence
    ? <span className={`evidence evidence-${evidence.confidence}`} title={evidence.source}>{tag}</span>
    : null
}

interface FieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  evidence?: Evidence
  type?: string
  placeholder?: string
  multiline?: boolean
  required?: boolean
  disabled?: boolean
  wide?: boolean
}

function Field({ label, value, onChange, evidence, type = 'text', placeholder, multiline, required, disabled, wide }: FieldProps) {
  return <label className={`field ${wide || multiline ? 'field-wide' : ''}`}>
    <span className="field-label">
      {label}{required && <b aria-label="必填">*</b>}
      <EvidenceBadge evidence={evidence} />
    </span>
    {multiline
      ? <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={6} disabled={disabled} />
      : <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} />}
  </label>
}

function ErrorText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return <>{parts.map((part, index) => part.startsWith('http')
    ? <a key={`${part}-${index}`} href={part.replace(/[。；，]+$/, '')} target="_blank" rel="noreferrer">查看相關頁面 <ExternalLink size={14} /></a>
    : part)}</>
}

function importantEventData(data?: EventData, warnings: string[] = []) {
  if (!data) return { message: '沒有可顯示的抓取結果' }
  return {
    title: data.title,
    date: data.date,
    openTime: data.openTime,
    startTime: data.startTime,
    endTime: data.endTime,
    place: data.place.name,
    address: data.place.address,
    actors: data.actors.map((actor) => actor.name),
    officialUrl: data.officialUrl,
    imageUrl: data.imageUrl,
    warnings,
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function aiField(event: Record<string, unknown>, key: string): unknown {
  return objectValue(event[key])?.value
}

function importantAiData(response: unknown, aiConfigured: boolean): unknown {
  const events = objectValue(response)?.events
  if (!Array.isArray(events)) return aiConfigured ? 'AI 已啟用但未回傳結果；請查看 AI 錯誤' : 'AI 未啟用'
  return events.map((value) => {
    const event = objectValue(value) ?? {}
    return {
      title: aiField(event, 'title'),
      date: aiField(event, 'date'),
      openTime: aiField(event, 'openTime'),
      startTime: aiField(event, 'startTime'),
      endTime: aiField(event, 'endTime'),
      place: aiField(event, 'placeName'),
      address: aiField(event, 'placeAddress'),
      countryCode: aiField(event, 'countryCode'),
      actors: aiField(event, 'actors'),
      officialUrl: aiField(event, 'officialUrl'),
      imageUrl: aiField(event, 'imageUrl'),
    }
  })
}

function writeAnalysisToConsole(result: Awaited<ReturnType<typeof api.analyze>>, aiConfigured: boolean): void {
  const crawler = result.diagnostics?.crawlerResult
  const fallbackDraft = result.drafts[0]
  const crawlerSummary = importantEventData(
    crawler?.data ?? fallbackDraft?.data,
    crawler?.warnings ?? fallbackDraft?.warnings ?? [],
  )
  console.log(`[Eventernote Autofill] 抓取重點\n${JSON.stringify({
    ...crawlerSummary,
    linkedSources: crawler?.linkedSources ?? [],
    aiImageCount: crawler?.aiImageCount ?? 0,
  }, null, 2)}`)
  console.log(`[Eventernote Autofill] AI 重點\n${JSON.stringify(importantAiData(result.diagnostics?.aiResponse, aiConfigured), null, 2)}`)
  if (result.diagnostics?.aiError) console.warn(`[Eventernote Autofill] AI 錯誤\n${result.diagnostics.aiError}`)
}

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editing, setEditing] = useState<EventData | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [accessKeyInput, setAccessKeyInput] = useState(getAccessKey())
  const [authenticated, setAuthenticated] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [imageError, setImageError] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [analysisStage, setAnalysisStage] = useState<AnalysisStage>('fetching_source')
  const fileInput = useRef<HTMLInputElement>(null)

  const showError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 404) {
      setDrafts([])
      setDraft(null)
      setEditing(null)
      setPreviewUrl('')
      setDirty(false)
      setNotice({ type: 'error', text: '這份草稿已失效，請重新解析活動網址。' })
      return
    }
    setNotice({ type: 'error', text: error instanceof Error ? error.message : '發生錯誤' })
  }

  const replaceDraft = useCallback((next: Draft) => {
    setDrafts((current) => current.map((item) => item.id === next.id ? next : item))
    setDraft(next)
    setEditing(structuredClone(next.data))
    setDirty(false)
  }, [])

  useEffect(() => {
    void api.config().then(async (loaded) => {
      setConfig(loaded)
      if (!loaded.authRequired) {
        setAuthenticated(true)
      } else if (getAccessKey()) {
        try { await api.verify(); setAuthenticated(true) } catch { setAuthenticated(false) }
      }
    }).catch(showError)
  }, [])

  useEffect(() => {
    let localUrl = ''
    let cancelled = false
    setImageError(false)
    if (draft?.data.uploadedImage) {
      void api.imageBlob(draft.id).then((blob) => {
        if (cancelled) return
        localUrl = URL.createObjectURL(blob)
        setPreviewUrl(localUrl)
      }).catch(() => setImageError(true))
    } else {
      setPreviewUrl(editing?.imageUrl.trim() ?? '')
    }
    return () => {
      cancelled = true
      if (localUrl) URL.revokeObjectURL(localUrl)
    }
  }, [draft?.id, draft?.data.uploadedImage, editing?.imageUrl])

  const authenticate = async () => {
    setAccessKey(accessKeyInput)
    try {
      await api.verify()
      setAuthenticated(true)
      setNotice(null)
    } catch (error) {
      setAccessKey('')
      showError(error)
    }
  }

  const analyze = async () => {
    if (!sourceUrl.trim()) return
    const analysisId = crypto.randomUUID()
    setBusy('analyze')
    setAnalysisStage('fetching_source')
    setNotice(null)
    const pollProgress = window.setInterval(() => {
      void api.analysisProgress(analysisId)
        .then((progress) => setAnalysisStage(progress.stage))
        .catch(() => undefined)
    }, 500)
    try {
      const result = await api.analyze(sourceUrl.trim(), analysisId)
      writeAnalysisToConsole(result, Boolean(config?.aiConfigured))
      setAnalysisStage('completed')
      await new Promise((resolve) => window.setTimeout(resolve, 320))
      setDrafts(result.drafts)
      replaceDraft(result.drafts[0])
      setSourceUrl('')
      setNotice(null)
    } catch (error) { showError(error) } finally {
      window.clearInterval(pollProgress)
      setBusy('')
      setAnalysisStage('fetching_source')
    }
  }

  const update = <K extends keyof EventData>(key: K, value: EventData[K]) => {
    setEditing((current) => current ? { ...current, [key]: value } : current)
    setDirty(true)
  }

  const updateStartTime = (value: string) => {
    setEditing((current) => {
      if (!current) return current
      const previousAutomaticOpenTime = addHoursToTime(current.startTime, -1)
      const previousAutomaticEndTime = addHoursToTime(current.startTime, 2)
      const shouldUpdateOpenTime = !current.openTime || current.openTime === previousAutomaticOpenTime
      const shouldUpdateEndTime = !current.endTime || current.endTime === previousAutomaticEndTime
      return {
        ...current,
        startTime: value,
        openTime: shouldUpdateOpenTime ? addHoursToTime(value, -1) : current.openTime,
        endTime: shouldUpdateEndTime ? addHoursToTime(value, 2) : current.endTime,
      }
    })
    setDirty(true)
  }

  const updatePlace = (changes: Partial<EventData['place']>) => {
    setEditing((current) => current ? { ...current, place: { ...current.place, ...changes } } : current)
    setDirty(true)
  }

  const updateActor = (index: number, changes: Partial<ActorDraft>) => {
    setEditing((current) => {
      if (!current) return current
      const actors = current.actors.map((actor, actorIndex) => actorIndex === index ? { ...actor, ...changes } : actor)
      return { ...current, actors }
    })
    setDirty(true)
  }

  const saveData = async (): Promise<Draft | undefined> => {
    if (!draft || !editing) return undefined
    const saved = await api.save(draft.id, editing)
    replaceDraft(saved)
    return saved
  }

  const prepareForConfirmation = async () => {
    if (!draft || !editing) return
    if (!config?.eventernoteConfigured || !config.eventernoteWriteEnabled || !config.dashboardConfigured) {
      setNotice({ type: 'error', text: '尚未連接 Eventernote 或活動清單服務，請由伺服器管理員完成設定。' })
      return
    }
    if (draft.status === 'ready' && !dirty) {
      setConfirmChecked(false)
      setConfirmOpen(true)
      return
    }
    setBusy('prepare')
    setNotice(null)
    try {
      const saved = await saveData()
      if (!saved) return
      const prepared = await api.prepare(saved.id)
      replaceDraft(prepared)
      if (prepared.status === 'ready') {
        setConfirmChecked(false)
        setConfirmOpen(true)
      } else {
        setNotice({ type: 'error', text: '仍有資料需要補充或選擇，請查看提示。' })
      }
    } catch (error) { showError(error) } finally { setBusy('') }
  }

  const startOver = () => {
    const ids = drafts.map((item) => item.id)
    setDrafts([])
    setDraft(null)
    setEditing(null)
    setPreviewUrl('')
    setNotice(null)
    setSourceUrl('')
    void Promise.all(ids.map((id) => api.remove(id).catch(() => undefined)))
  }

  const selectDraft = async (next: Draft) => {
    if (next.id === draft?.id || busy) return
    setBusy('switch')
    try {
      if (dirty) await saveData()
      replaceDraft(drafts.find((item) => item.id === next.id) ?? next)
      setNotice(null)
    } catch (error) { showError(error) } finally { setBusy('') }
  }

  const removeDraft = async (target: Draft) => {
    if (busy) return
    setBusy('remove-draft')
    try {
      await api.remove(target.id)
      const remaining = drafts.filter((item) => item.id !== target.id)
      setDrafts(remaining)
      if (target.id === draft?.id) {
        const next = remaining[0]
        setDraft(next ?? null)
        setEditing(next ? structuredClone(next.data) : null)
        setPreviewUrl('')
        setDirty(false)
      }
      setNotice(remaining.length ? { type: 'ok', text: `已移除場次「${target.data.title}」。` } : null)
    } catch (error) { showError(error) } finally { setBusy('') }
  }

  const uploadImage = async (file?: File) => {
    if (!file || !draft || !editing) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setNotice({ type: 'error', text: '圖片只支援 JPEG、PNG 或 WebP。' })
      return
    }
    if (file.size > 5_000_000) {
      setNotice({ type: 'error', text: '圖片不可超過 5 MB。' })
      return
    }
    const immediatePreview = URL.createObjectURL(file)
    setPreviewUrl(immediatePreview)
    setImageError(false)
    setBusy('upload')
    try {
      await saveData()
      const uploaded = await api.uploadImage(draft.id, file)
      replaceDraft(uploaded)
      setNotice({ type: 'ok', text: '圖片已上傳並準備加入活動。' })
    } catch (error) { showError(error) } finally {
      URL.revokeObjectURL(immediatePreview)
      setBusy('')
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const removeImage = async () => {
    if (!draft || !editing) return
    setBusy('remove-image')
    try {
      await saveData()
      const next = await api.removeImage(draft.id)
      replaceDraft(next)
      setNotice({ type: 'ok', text: '已移除上傳圖片，可改用圖片網址。' })
    } catch (error) { showError(error) } finally { setBusy('') }
  }

  const execute = async () => {
    if (!draft || !confirmChecked) return
    setBusy('execute')
    setNotice(null)
    try {
      const { confirmationToken } = await api.confirm(draft.id)
      const result = await api.execute(draft.id, confirmationToken)
      replaceDraft(result.draft)
      setConfirmOpen(false)
      setNotice({ type: 'ok', text: '活動已建立並同步完成。' })
    } catch (error) { showError(error); setConfirmOpen(false) } finally { setBusy('') }
  }

  if (!config) return <div className="center-state"><LoaderCircle className="spin" /><p>正在載入</p></div>

  if (!authenticated) return <main className="auth-screen">
    <section className="auth-panel">
      <span className="brand-mark"><FileSearch size={23} /></span>
      <h1>Eventernote Autofill</h1>
      <p>輸入伺服器存取密鑰。</p>
      <label className="field field-wide"><span className="field-label">存取密鑰</span>
        <input type="password" value={accessKeyInput} onChange={(event) => setAccessKeyInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void authenticate()} autoFocus />
      </label>
      <button className="primary-button" onClick={() => void authenticate()}>登入</button>
      {notice?.type === 'error' && <p className="inline-error">{notice.text}</p>}
    </section>
  </main>

  if (!draft || !editing) return <main className="landing-screen">
    <div className="landing-shell">
      {busy !== 'analyze' && <div className="landing-title">
        <h1>Eventernote Autofill</h1>
        <p>從活動網址，整理成可確認的 Eventernote 資料。</p>
      </div>}

      {busy === 'analyze' ? <div className="analysis-card-wrap">
        <ProcessingCard status="running" stage={analysisStage} />
      </div> : <>
        <div className="landing-input">
          <input type="url" aria-label="活動來源網址" placeholder="貼上活動網址" value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void analyze()} autoFocus />
          <button disabled={!sourceUrl.trim()} onClick={() => void analyze()} aria-label="開始解析" title="開始解析"><ArrowRight size={22} /></button>
        </div>
        {notice?.type === 'error' && <div className="landing-error" role="alert"><AlertTriangle size={18} /><span>{notice.text}</span></div>}
      </>}
    </div>
  </main>

  const coreLocked = Boolean(draft?.submittedEventId) || draft?.status === 'submitting' || draft?.status === 'completed'
  return <div className="app-shell">
    <main className="page results-page">
      <nav className="results-nav" aria-label="活動操作">
        <button onClick={startOver} disabled={Boolean(busy)}><ArrowLeft size={18} />解析另一個網址</button>
      </nav>

      {drafts.length > 1 && <div className="session-tabs" role="tablist" aria-label="活動場次">
        {drafts.map((item, index) => <div key={item.id} className={`session-tab ${item.id === draft.id ? 'active' : ''}`}>
          <button className="session-select" role="tab" aria-selected={item.id === draft.id}
            disabled={Boolean(busy)} onClick={() => void selectDraft(item)}>
            <span>{item.data.startTime || `場次 ${index + 1}`}</span>
            <small>{item.data.title.match(/日場|夜場|昼公演|夜公演|After[- ]?Talk|アフタートーク|ライブアフタースペシャルトーク/i)?.[0] ?? `場次 ${index + 1}`}</small>
          </button>
          <button className="session-delete" disabled={Boolean(busy)} onClick={() => void removeDraft(item)}
            aria-label={`刪除場次 ${item.data.title}`} title="刪除這個場次"><Trash2 size={16} /></button>
        </div>)}
      </div>}

      {notice && <div className={`notice notice-${notice.type}`} role="status">
        {notice.type === 'ok' ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}
        <span>{notice.text}</span>
        <button className="close-button" onClick={() => setNotice(null)} aria-label="關閉提示"><X size={18} /></button>
      </div>}

      <article className="event-editor">
        <header className="event-heading">
          <div>
            <div className="meta-line">
              <span>{sourceLabels[draft.sourceKind]}</span>
              <span className={`status status-${draft.status}`}>{statusLabel(draft.status)}</span>
            </div>
            <h2>{editing.title || '未命名活動'}</h2>
            <a href={draft.sourceUrl} target="_blank" rel="noreferrer">查看來源 <ExternalLink size={15} /></a>
          </div>
        </header>

        {(draft.error || draft.warnings.length > 0) && <section className="issues" aria-label="需要處理的資料">
          {draft.error && <p className="submission-error"><AlertTriangle size={18} /><span><ErrorText text={draft.error} /></span></p>}
          {draft.warnings.length > 0 && <ul>{draft.warnings.map((warning) => <li key={warning}><AlertTriangle size={16} />{warning}</li>)}</ul>}
        </section>}

        <section className="form-section">
          <div className="section-title"><CalendarDays size={21} /><h3>活動資料</h3></div>
          <div className="field-grid">
            <Field label="活動名稱" required value={editing.title} onChange={(value) => update('title', value)} evidence={draft.evidence.title} disabled={coreLocked} wide />
            <Field label="活動日期" required type="date" value={editing.date} onChange={(value) => update('date', value)} evidence={draft.evidence.date} disabled={coreLocked} />
            <Field label="官方網址" value={editing.officialUrl} onChange={(value) => update('officialUrl', value)} evidence={draft.evidence.officialUrl} disabled={coreLocked} />
            <Field label="開場時間" type="time" value={editing.openTime} onChange={(value) => update('openTime', value)} evidence={draft.evidence.openTime} disabled={coreLocked} />
            <Field label="開始時間" required type="time" value={editing.startTime} onChange={updateStartTime} evidence={draft.evidence.startTime} disabled={coreLocked} />
            <Field label="結束時間" type="time" value={editing.endTime} onChange={(value) => update('endTime', value)} evidence={draft.evidence.endTime} disabled={coreLocked} />
            <Field label="活動說明" multiline value={editing.description} onChange={(value) => update('description', value)} evidence={draft.evidence.description} disabled={coreLocked} />
          </div>
        </section>

        <section className="form-section">
          <div className="section-title"><MapPin size={21} /><h3>場所與出演者</h3></div>
          <div className="field-grid place-grid">
            <Field label="開催場所" required value={editing.place.name} disabled={coreLocked}
              onChange={(value) => updatePlace({ name: value, selectedId: '', createNew: false, candidates: [] })} evidence={draft.evidence['place.name']} />
            <Field label="地址" value={editing.place.address} disabled={coreLocked} onChange={(value) => updatePlace({ address: value })} evidence={draft.evidence['place.address']} />
            {(editing.place.name || editing.place.selectedId) && <label className="field field-wide">
              <span className="field-label">Eventernote 場所 <EvidenceBadge evidence={draft.evidence['place.selection']} /></span>
              <select disabled={coreLocked} value={editing.place.selectedId ? `id:${editing.place.selectedId}` : editing.place.createNew ? 'new' : ''}
                onChange={(event) => event.target.value === 'new'
                  ? updatePlace({ selectedId: '', createNew: true })
                  : updatePlace({ selectedId: event.target.value.replace('id:', ''), createNew: false })}>
                <option value="">請選擇</option>
                {editing.place.selectedId && !editing.place.candidates.some((candidate) => candidate.id === editing.place.selectedId)
                  && <option value={`id:${editing.place.selectedId}`}>使用現有：{editing.place.name}</option>}
                {editing.place.candidates.map((candidate) => <option key={candidate.id} value={`id:${candidate.id}`}>使用現有：{candidate.name}</option>)}
                <option value="new">建立新場所：{editing.place.name}</option>
              </select>
            </label>}
          </div>

          <div className="actor-list">
            {editing.actors.map((actor, index) => <div className="actor-row" key={`${index}-${actor.name}`}>
              <UserRound size={19} />
              <label><span>出演者名稱</span><input value={actor.name} disabled={coreLocked}
                onChange={(event) => updateActor(index, { name: event.target.value, selectedId: '', createNew: false, candidates: [] })} /></label>
              <label><span>讀音</span><input value={actor.reading} disabled={coreLocked} onChange={(event) => updateActor(index, { reading: event.target.value })} /></label>
              {(actor.name || actor.selectedId) && <label><span>Eventernote 出演者 <EvidenceBadge evidence={draft.evidence[`actors.${index}.selection`]} /></span>
                <select disabled={coreLocked} value={actor.selectedId ? `id:${actor.selectedId}` : actor.createNew ? 'new' : ''}
                  onChange={(event) => event.target.value === 'new'
                    ? updateActor(index, { selectedId: '', createNew: true })
                    : updateActor(index, { selectedId: event.target.value.replace('id:', ''), createNew: false })}>
                  <option value="">請選擇</option>
                  {actor.selectedId && !actor.candidates.some((candidate) => candidate.id === actor.selectedId)
                    && <option value={`id:${actor.selectedId}`}>使用現有：{actor.name}</option>}
                  {actor.candidates.map((candidate) => <option key={candidate.id} value={`id:${candidate.id}`}>使用現有：{candidate.name}</option>)}
                  <option value="new">建立新出演者：{actor.name}</option>
                </select>
              </label>}
              <button className="icon-button" disabled={coreLocked} onClick={() => {
                update('actors', editing.actors.filter((_, actorIndex) => actorIndex !== index))
              }} aria-label={`移除出演者 ${actor.name}`} title="移除出演者"><X size={18} /></button>
            </div>)}
            {!coreLocked && <button className="add-button" onClick={() => update('actors', [...editing.actors, emptyActor()])}><Plus size={18} />新增出演者</button>}
          </div>
        </section>

        <section className="form-section image-section">
          <div className="section-title"><FileImage size={21} /><h3>活動圖片</h3></div>
          <div className="media-layout">
            <div className={`image-preview ${imageError || !previewUrl ? 'image-empty' : ''}`}>
              {previewUrl && !imageError
                ? <img src={previewUrl} alt="活動圖片預覽" onError={() => setImageError(true)} />
                : <><ImagePlus size={34} /><span>{imageError ? '無法載入圖片' : '圖片預覽'}</span></>}
            </div>
            <div className="media-fields">
              <Field label="圖片網址" value={editing.imageUrl} onChange={(value) => update('imageUrl', value)} placeholder="https://..." disabled={draft.status === 'submitting' || draft.status === 'completed'} />
              <div className="upload-row">
                <input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadImage(event.target.files?.[0])} />
                <button className="secondary-button" disabled={Boolean(busy) || draft.status === 'completed'} onClick={() => fileInput.current?.click()}>
                  {busy === 'upload' ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}上傳圖片
                </button>
                {editing.uploadedImage && <><span className="file-name">{editing.uploadedImage.fileName}</span>
                  <button className="icon-button" disabled={Boolean(busy)} onClick={() => void removeImage()} title="移除上傳圖片" aria-label="移除上傳圖片"><Trash2 size={17} /></button></>}
              </div>
            </div>
          </div>
        </section>

        <footer className="editor-actions">
          {draft.submittedEventUrl && <a className="event-link" href={draft.submittedEventUrl} target="_blank" rel="noreferrer">已建立的活動 <ExternalLink size={15} /></a>}
          {draft.status !== 'completed' && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void prepareForConfirmation()}>
            {busy === 'prepare' ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
            {busy === 'prepare' ? '正在檢查...' : '確認送出'}
          </button>}
        </footer>
      </article>
    </main>

    {confirmOpen && draft && editing && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirmOpen(false)}>
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">確認活動資料</h2>
        <dl className="confirm-summary">
          <div><dt>活動</dt><dd>{editing.title}</dd></div>
          <div><dt>日期時間</dt><dd>{editing.date} {editing.startTime}</dd></div>
          <div><dt>場所</dt><dd>{editing.place.name}（{editing.place.selectedId ? '使用現有項目' : '建立新項目'}）</dd></div>
          <div><dt>出演者</dt><dd>{editing.actors.map((actor) => `${actor.name}（${actor.selectedId ? '使用現有' : '建立新項目'}）`).join('、') || '未提供'}</dd></div>
          <div><dt>圖片</dt><dd>{editing.uploadedImage?.fileName || editing.imageUrl || '未提供'}</dd></div>
        </dl>
        <label className="confirm-check"><input type="checkbox" checked={confirmChecked} onChange={(event) => setConfirmChecked(event.target.checked)} />
          <span>我已核對以上資料，確認寫入 Eventernote 與活動清單。</span>
        </label>
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => setConfirmOpen(false)}>返回修改</button>
          <button className="primary-button" disabled={!confirmChecked || Boolean(busy)} onClick={() => void execute()}>
            {busy === 'execute' ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}送出
          </button>
        </div>
      </section>
    </div>}
  </div>
}

export default App
