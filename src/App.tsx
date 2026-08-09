import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, ExternalLink,
  Globe2, ImagePlus, LoaderCircle, Pencil, Plus, Search, Send, Trash2, Upload, X,
} from 'lucide-react'
import type {
  ActorData, AnalysisStage, AnalyzeResult, AppConfig, EntityCandidate, EventData, Evidence, ReviewEvent, SubmissionImage,
} from '../shared/types'
import { addHoursToTime } from '../shared/time'
import { api, getAccessKey, setAccessKey, waitForAnalysis } from './api'
import ProcessingCard from '@/components/ui/processing-card'
import { SubmissionSuccessActions } from './SubmissionSuccessActions'
import { detectLocale, getMessages, interpolate, localeOptions, type Locale, type Messages } from './i18n'

const localeStorageKey = 'eventernote-autofill-locale'

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-TW'
  const stored = window.localStorage.getItem(localeStorageKey)
  return localeOptions.some((option) => option.value === stored)
    ? stored as Locale
    : detectLocale(window.navigator.language)
}

function LanguageSwitcher({ locale, onChange, copy }: { locale: Locale; onChange: (locale: Locale) => void; copy: Messages }) {
  return <label className="language-switcher">
    <Globe2 size={16} aria-hidden="true" />
    <span className="visually-hidden">{copy.language}</span>
    <select value={locale} onChange={(event) => onChange(event.target.value as Locale)} aria-label={copy.language}>
      {localeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>
}

function displayTime(data: EventData, copy: Messages): string {
  return [
    data.openTime && `${copy.doorsOpen} ${data.openTime}`,
    data.startTime && `${copy.starts} ${data.startTime}`,
    data.endTime && `${copy.ends} ${data.endTime}`,
  ].filter(Boolean).join(' · ') || copy.timeUnavailable
}

async function imagePayload(file: Blob, fileName: string, readError: string): Promise<SubmissionImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error(readError))
    reader.readAsDataURL(file)
  })
  return {
    fileName,
    mimeType: file.type as SubmissionImage['mimeType'],
    base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
  }
}

function evidenceLabel(evidence: Evidence | undefined, copy: Messages): string | undefined {
  if (!evidence) return undefined
  return { high: copy.sourceData, medium: copy.parsedResult, low: copy.aiReview, missing: copy.needsConfirmation }[evidence.confidence]
}

function EvidenceTooltip({ evidence, copy }: { evidence?: Evidence; copy: Messages }) {
  const tag = evidenceLabel(evidence, copy)
  return tag && evidence
    ? <span className="hover-tooltip evidence-tooltip" role="tooltip">
        <strong>{tag}</strong>
        <span>{evidence.source}</span>
      </span>
    : null
}

function EvidenceBadge({ evidence, copy }: { evidence?: Evidence; copy: Messages }) {
  const tag = evidenceLabel(evidence, copy)
  return tag && evidence?.confidence === 'missing'
    ? <span className="evidence-marker evidence-missing" tabIndex={0}
        aria-label={`${tag}：${evidence.source}`}>
        <span className="evidence-dot" aria-hidden="true" />
        <EvidenceTooltip evidence={evidence} copy={copy} />
      </span>
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
  needsInput?: boolean
  disabled?: boolean
  wide?: boolean
  copy: Messages
}

function Field({ label, value, onChange, evidence, type = 'text', placeholder, multiline, required, needsInput, disabled, wide, copy }: FieldProps) {
  const showRequiredFrame = needsInput ?? (Boolean(required) && !value.trim())
  return <label className={`field ${wide || multiline ? 'field-wide' : ''} ${showRequiredFrame ? 'field-needs-input' : ''}`}>
    <span className="field-label">
      {label}{required && <b aria-label={copy.required}>*</b>}
      <EvidenceBadge evidence={evidence} copy={copy} />
    </span>
    <span className="field-value">
      {multiline
        ? <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={6} disabled={disabled} />
        : <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} />}
      <EvidenceTooltip evidence={evidence} copy={copy} />
    </span>
  </label>
}

interface EventernoteEntityFieldProps {
  kind: 'place' | 'actor'
  label: string
  name: string
  selectedId: string
  createNew: boolean
  candidates: EntityCandidate[]
  status: 'idle' | 'loading' | 'error'
  editing: boolean
  newConfirmed: boolean
  disabled: boolean
  evidence?: Evidence
  onBeginEdit: () => void
  onQueryChange: (value: string) => void
  onSelect: (candidate: EntityCandidate) => void
  onConfirmNew: () => void
  onCancel: () => void
  onRemove?: () => void
  copy: Messages
}

function EventernoteEntityField({
  kind, label, name, selectedId, createNew, candidates, status, editing, newConfirmed, disabled, evidence,
  onBeginEdit, onQueryChange, onSelect, onConfirmNew, onCancel, onRemove, copy,
}: EventernoteEntityFieldProps) {
  const resolved = Boolean(selectedId || (createNew && newConfirmed))
  const noun = kind === 'place' ? copy.place : copy.actor

  if (resolved && !editing) return <div className="entity-result-row">
    <button type="button" className="entity-result" disabled={disabled} onClick={onBeginEdit}>
      <span><small>{label}</small><strong>{name}</strong></span>
      <span className={`entity-result-state ${selectedId ? 'existing' : 'new'}`}>
        {selectedId ? copy.existingItem : copy.confirmedNew}
      </span>
      {!disabled && <Pencil size={16} aria-hidden="true" />}
    </button>
    {onRemove && !disabled && <button type="button" className="entity-remove" onClick={onRemove}
      aria-label={`${copy.removeActor} ${name}`} title={copy.removeActor}><Trash2 size={17} /></button>}
  </div>

  return <div className="entity-search-card">
    <div className="entity-search-heading">
      <span><strong>{label}</strong><small>{copy.preferExisting}</small></span>
      <span className="entity-heading-actions">
        <EvidenceBadge evidence={evidence} copy={copy} />
        {onRemove && !disabled && <button type="button" className="entity-remove" onClick={onRemove}
          aria-label={`${copy.removeActor} ${name}`} title={copy.removeActor}><Trash2 size={17} /></button>}
      </span>
    </div>
    <label className="entity-search-input">
      <Search size={18} aria-hidden="true" />
      <input value={name} disabled={disabled} placeholder={`${copy.searchEventernote} ${noun}`}
        onChange={(event) => onQueryChange(event.target.value)} />
      {status === 'loading' && <LoaderCircle className="spin" size={17} aria-label={copy.searching} />}
    </label>
    {status === 'loading' && <div className="entity-loading" role="status"><LoaderCircle className="spin" size={19} /><span>{copy.searchingEventernote}</span></div>}
    {status === 'error' && <p className="entity-search-message error">{copy.searchFailed}</p>}
    {name.trim() && status !== 'loading' && candidates.length > 0 && <div className="entity-options" role="listbox" aria-label={`${label} ${copy.searchResults}`}>
      <div className="entity-options-label">{copy.searchResults}</div>
      {candidates.slice(0, 5).map((candidate) => <button type="button" key={candidate.id} role="option"
        aria-selected={candidate.id === selectedId} onClick={() => onSelect(candidate)}>
        <span className={`entity-option-mark ${candidate.id === selectedId ? 'selected' : ''}`}>{candidate.id === selectedId && <Check size={14} />}</span>
        <span>{candidate.name}</span><small>{copy.useThisItem}</small>
      </button>)}
    </div>}
    {name.trim() && status === 'idle' && candidates.length === 0 && <p className="entity-search-message">{copy.noExactMatch}</p>}
    {name.trim() && <div className="entity-create-confirm">
      <span><strong>{copy.stillCannotFind}</strong><small>{copy.createWarning}</small></span>
      <button type="button" className="secondary-button" disabled={disabled || status === 'loading'} onClick={onConfirmNew}>{copy.confirmCreate} “{name}”</button>
    </div>}
    {(selectedId || newConfirmed) && <button type="button" className="entity-cancel" onClick={onCancel}>{copy.cancelEdit}</button>}
  </div>
}

function ErrorText({ text, copy }: { text: string; copy: Messages }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return <>{parts.map((part, index) => part.startsWith('http')
    ? <a key={`${part}-${index}`} href={part.replace(/[。；，]+$/, '')} target="_blank" rel="noreferrer">{copy.relatedPage} <ExternalLink size={14} /></a>
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
    description: data.description,
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

function writeAnalysisToConsole(result: AnalyzeResult, aiConfigured: boolean): void {
  const crawler = result.diagnostics?.crawlerResult
  const fallbackEvent = result.events[0]
  const crawlerSummary = importantEventData(
    crawler?.data ?? fallbackEvent?.data,
    crawler?.warnings ?? fallbackEvent?.warnings ?? [],
  )
  console.log(`[Eventernote Autofill] 抓取重點\n${JSON.stringify({
    ...crawlerSummary,
    descriptionEvidence: crawler?.evidence.description ?? fallbackEvent?.evidence.description,
    linkedSources: crawler?.linkedSources ?? [],
    aiImageCount: crawler?.aiImageCount ?? 0,
  }, null, 2)}`)
  console.log(`[Eventernote Autofill] AI 重點\n${JSON.stringify(importantAiData(result.diagnostics?.aiResponse, aiConfigured), null, 2)}`)
  if (result.diagnostics?.aiError) console.warn(`[Eventernote Autofill] AI 錯誤\n${result.diagnostics.aiError}`)
}

function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const copy = getMessages(locale)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [configError, setConfigError] = useState('')
  const [configAttempt, setConfigAttempt] = useState(0)
  const [events, setEvents] = useState<ReviewEvent[]>([])
  const [activeId, setActiveId] = useState('')
  const [images, setImages] = useState<Record<string, File>>({})
  const previewImages = useRef<Record<string, Blob>>({})
  const [sourceUrl, setSourceUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [accessKeyInput, setAccessKeyInput] = useState(getAccessKey())
  const [authenticated, setAuthenticated] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [editingFact, setEditingFact] = useState<'title' | 'schedule' | ''>('')
  const [imageEditorOpen, setImageEditorOpen] = useState(false)
  const [editingEntity, setEditingEntity] = useState('')
  const [confirmedNewEntities, setConfirmedNewEntities] = useState<string[]>([])
  const [previewUrl, setPreviewUrl] = useState('')
  const [imageError, setImageError] = useState(false)
  const [analysisStage, setAnalysisStage] = useState<AnalysisStage>('fetching_source')
  const [placeSearchStatus, setPlaceSearchStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [actorSearchStatuses, setActorSearchStatuses] = useState<Record<number, 'loading' | 'error'>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  const activeEvent = events.find((event) => event.id === activeId) ?? null
  const editing = activeEvent?.data ?? null
  const activeImage = activeEvent ? images[activeEvent.id] : undefined
  const coreLocked = Boolean(activeEvent?.submission?.eventId) || activeEvent?.submission?.completed || busy === 'execute'
  const placeEntityKey = `${activeId}:place`
  const actorEntityKey = (index: number) => `${activeId}:actor:${index}`
  const isNewConfirmed = (key: string) => confirmedNewEntities.includes(key)
  const placeSearchVisible = Boolean(editingEntity === placeEntityKey
    || (editing?.place.createNew && !isNewConfirmed(placeEntityKey))
    || (editing?.place.name && !editing.place.selectedId && !editing.place.createNew))
  const placeSearchName = editing?.place.name.trim() ?? ''
  const actorSearchNames = editing?.actors.map((actor) => actor.name.trim()) ?? []
  const actorSearchKey = JSON.stringify(actorSearchNames)
  const shouldSearchPlace = Boolean(placeSearchName && placeSearchVisible && editing?.place.candidates.length === 0)
  const actorSearchPayload = JSON.stringify(editing?.actors.flatMap((actor, index) => {
    const name = actorSearchNames[index]
    const key = actorEntityKey(index)
    const visible = editingEntity === key || (actor.createNew && !isNewConfirmed(key))
      || (actor.name && !actor.selectedId && !actor.createNew)
    return name && visible && actor.candidates.length === 0
      ? [{ index, name }]
      : []
  }) ?? [])
  const needsEntityConfirmation = Boolean(editing && (
    (editing.place.createNew && !isNewConfirmed(placeEntityKey))
    || editing.actors.some((actor, index) => actor.createNew && !isNewConfirmed(actorEntityKey(index)))
  ))

  useEffect(() => {
    window.localStorage.setItem(localeStorageKey, locale)
    document.documentElement.lang = locale
  }, [locale])

  const showError = (error: unknown) => {
    setNotice({ type: 'error', text: error instanceof Error ? error.message : copy.genericError })
  }

  const updateActiveEvent = useCallback((updateEvent: (event: ReviewEvent) => ReviewEvent) => {
    setEvents((current) => current.map((event) => event.id === activeId ? updateEvent(event) : event))
  }, [activeId])

  useEffect(() => {
    let cancelled = false
    setConfigError('')
    const load = async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        try {
          const loaded = await api.config()
          if (cancelled) return
          setConfig(loaded)
          if (!loaded.authRequired) {
            setAuthenticated(true)
          } else if (getAccessKey()) {
            try { await api.verify(); setAuthenticated(true) } catch { setAuthenticated(false) }
          }
          return
        } catch (error) {
          lastError = error
          if (attempt < 4) await new Promise((resolve) => window.setTimeout(resolve, 500))
        }
      }
      if (!cancelled) setConfigError(lastError instanceof Error ? lastError.message : '__server_config_failed__')
    }
    void load()
    return () => { cancelled = true }
  }, [configAttempt])

  useEffect(() => {
    let localUrl = ''
    const controller = new AbortController()
    let timer = 0
    const previewEventId = activeEvent?.id
    setImageError(false)
    if (activeImage) {
      if (previewEventId) delete previewImages.current[previewEventId]
      localUrl = URL.createObjectURL(activeImage)
      setPreviewUrl(localUrl)
    } else {
      const remoteUrl = editing?.imageUrl.trim() ?? ''
      if (previewEventId) delete previewImages.current[previewEventId]
      setPreviewUrl('')
      if (remoteUrl && previewEventId) {
        timer = window.setTimeout(() => {
          void api.imagePreview(remoteUrl, controller.signal).then((blob) => {
            if (controller.signal.aborted) return
            previewImages.current[previewEventId] = blob
            localUrl = URL.createObjectURL(blob)
            setPreviewUrl(localUrl)
          }).catch(() => {
            if (!controller.signal.aborted) setImageError(true)
          })
        }, 350)
      }
    }
    return () => {
      window.clearTimeout(timer)
      controller.abort()
      if (localUrl) URL.revokeObjectURL(localUrl)
    }
  }, [activeEvent?.id, activeImage, editing?.imageUrl])

  useEffect(() => {
    if (!activeId || coreLocked || !shouldSearchPlace) {
      setPlaceSearchStatus('idle')
      return
    }
    const controller = new AbortController()
    setPlaceSearchStatus('loading')
    const timer = window.setTimeout(() => {
      void api.searchEntities('place', placeSearchName, controller.signal).then((candidates) => {
        updateActiveEvent((event) => event.data.place.name.trim() === placeSearchName
          ? { ...event, data: { ...event.data, place: { ...event.data.place, candidates } } }
          : event)
        setPlaceSearchStatus('idle')
      }).catch(() => {
        if (!controller.signal.aborted) setPlaceSearchStatus('error')
      })
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeId, placeSearchName, shouldSearchPlace, coreLocked, updateActiveEvent])

  useEffect(() => {
    if (!activeId || coreLocked) {
      setActorSearchStatuses({})
      return
    }
    const searches = JSON.parse(actorSearchPayload) as Array<{ index: number; name: string }>
    if (searches.length === 0) {
      setActorSearchStatuses({})
      return
    }
    const controller = new AbortController()
    setActorSearchStatuses(Object.fromEntries(searches.map(({ index }) => [index, 'loading' as const])))
    const timer = window.setTimeout(() => {
      void Promise.allSettled(searches.map(({ name }) => api.searchEntities('actor', name, controller.signal))).then((results) => {
        if (controller.signal.aborted) return
        updateActiveEvent((event) => {
          if (JSON.stringify(event.data.actors.map((actor) => actor.name.trim())) !== actorSearchKey) return event
          const actors = event.data.actors.map((actor) => ({ ...actor }))
          results.forEach((result, resultIndex) => {
            if (result.status === 'fulfilled') actors[searches[resultIndex].index].candidates = result.value
          })
          return { ...event, data: { ...event.data, actors } }
        })
        setActorSearchStatuses(Object.fromEntries(results.flatMap((result, resultIndex) => result.status === 'rejected'
          ? [[searches[resultIndex].index, 'error' as const]]
          : [])))
      })
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeId, actorSearchKey, actorSearchPayload, coreLocked, updateActiveEvent])

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
    try {
      await api.startAnalysis(sourceUrl.trim(), analysisId)
      const result = await waitForAnalysis(
        () => api.analysisProgress(analysisId),
        (progress) => setAnalysisStage(progress.stage),
      )
      writeAnalysisToConsole(result, Boolean(config?.aiConfigured))
      setAnalysisStage('completed')
      await new Promise((resolve) => window.setTimeout(resolve, 320))
      setEvents(result.events)
      setActiveId(result.events[0]?.id ?? '')
      setEditingFact('')
      setImageEditorOpen(false)
      setEditingEntity('')
      setConfirmedNewEntities([])
      setImages({})
      setSourceUrl('')
      setNotice(null)
    } catch (error) { showError(error) } finally {
      setBusy('')
      setAnalysisStage('fetching_source')
    }
  }

  const update = <K extends keyof EventData>(key: K, value: EventData[K]) => {
    updateActiveEvent((event) => ({ ...event, data: { ...event.data, [key]: value }, error: undefined }))
  }

  const updateImageUrl = (value: string) => {
    updateActiveEvent((event) => ({
      ...event,
      data: { ...event.data, imageUrl: value },
      error: undefined,
      submission: event.submission ? { ...event.submission, imageAdded: false, completed: false } : undefined,
    }))
  }

  const updateStartTime = (value: string) => {
    updateActiveEvent((event) => {
      const previousAutomaticOpenTime = addHoursToTime(event.data.startTime, -1)
      const previousAutomaticEndTime = addHoursToTime(event.data.startTime, 2)
      const shouldUpdateOpenTime = !event.data.openTime || event.data.openTime === previousAutomaticOpenTime
      const shouldUpdateEndTime = !event.data.endTime || event.data.endTime === previousAutomaticEndTime
      return { ...event, error: undefined, data: {
        ...event.data,
        startTime: value,
        openTime: shouldUpdateOpenTime ? addHoursToTime(value, -1) : event.data.openTime,
        endTime: shouldUpdateEndTime ? addHoursToTime(value, 2) : event.data.endTime,
      } }
    })
  }

  const updatePlace = (changes: Partial<EventData['place']>) => {
    updateActiveEvent((event) => {
      const evidence = { ...event.evidence }
      if ('name' in changes || 'selectedId' in changes || 'createNew' in changes) delete evidence['place.selection']
      return {
        ...event,
        evidence,
        error: undefined,
        data: { ...event.data, place: { ...event.data.place, ...changes } },
      }
    })
  }

  const updateActor = (index: number, changes: Partial<ActorData>) => {
    updateActiveEvent((event) => {
      const evidence = { ...event.evidence }
      if ('name' in changes || 'selectedId' in changes || 'createNew' in changes) delete evidence[`actors.${index}.selection`]
      return {
        ...event,
        evidence,
        error: undefined,
        data: {
          ...event.data,
          actors: event.data.actors.map((actor, actorIndex) => actorIndex === index ? { ...actor, ...changes } : actor),
        },
      }
    })
  }

  const clearNewConfirmation = (key: string) => {
    setConfirmedNewEntities((current) => current.filter((item) => item !== key))
  }

  const selectPlaceCandidate = (candidate: EntityCandidate) => {
    updatePlace({ name: candidate.name, selectedId: candidate.id, createNew: false })
    clearNewConfirmation(placeEntityKey)
    setEditingEntity('')
  }

  const confirmNewPlace = () => {
    updatePlace({ selectedId: '', createNew: true })
    setConfirmedNewEntities((current) => current.includes(placeEntityKey) ? current : [...current, placeEntityKey])
    setEditingEntity('')
  }

  const selectActorCandidate = (index: number, candidate: EntityCandidate) => {
    const key = actorEntityKey(index)
    updateActor(index, {
      name: candidate.name, reading: '', searchKeywords: '', sex: '', selectedId: candidate.id, createNew: false,
    })
    clearNewConfirmation(key)
    setEditingEntity('')
  }

  const confirmNewActor = (index: number) => {
    const key = actorEntityKey(index)
    updateActor(index, { selectedId: '', createNew: true })
    setConfirmedNewEntities((current) => current.includes(key) ? current : [...current, key])
    setEditingEntity('')
  }

  const removeActor = (index: number) => {
    updateActiveEvent((event) => {
      const evidence = Object.fromEntries(Object.entries(event.evidence)
        .filter(([key]) => !/^actors\.\d+\.selection$/.test(key)))
      return {
        ...event,
        evidence,
        error: undefined,
        data: { ...event.data, actors: event.data.actors.filter((_, actorIndex) => actorIndex !== index) },
      }
    })
    setConfirmedNewEntities((current) => current.filter((item) => !item.startsWith(`${activeId}:actor:`)))
    setEditingEntity('')
  }

  const addActor = () => {
    if (!editing || coreLocked) return
    const index = editing.actors.length
    const actor: ActorData = {
      name: '', reading: '', searchKeywords: '', sex: '', selectedId: '', createNew: false, candidates: [],
    }
    update('actors', [...editing.actors, actor])
    setEditingEntity(actorEntityKey(index))
  }

  const prepareForConfirmation = async () => {
    if (!activeEvent || !editing) return
    if (needsEntityConfirmation) {
      setNotice({ type: 'error', text: copy.confirmEntitiesFirst })
      return
    }
    if (!config?.eventernoteConfigured || !config.eventernoteWriteEnabled) {
      setNotice({ type: 'error', text: copy.eventernoteUnavailable })
      return
    }
    if (activeEvent.submission?.eventId) {
      setConfirmOpen(true)
      return
    }
    setBusy('prepare')
    setNotice(null)
    try {
      const checked = await api.checkSubmission(activeEvent.sourceUrl, editing, activeEvent.evidence)
      updateActiveEvent((event) => ({
        ...event,
        data: checked.data,
        evidence: checked.evidence,
        warnings: checked.warnings,
        error: undefined,
      }))
      if (checked.ready) {
        setConfirmOpen(true)
      } else {
        setEditingFact(!checked.data.title.trim() ? 'title' : (!checked.data.date || !checked.data.startTime) ? 'schedule' : '')
        setNotice({ type: 'error', text: copy.missingSubmissionData })
      }
    } catch (error) { showError(error) } finally { setBusy('') }
  }

  const startOver = () => {
    setEvents([])
    setActiveId('')
    setImages({})
    setPreviewUrl('')
    setNotice(null)
    setSourceUrl('')
    setConfirmOpen(false)
    setEditingFact('')
    setImageEditorOpen(false)
    setEditingEntity('')
    setConfirmedNewEntities([])
  }

  const selectEvent = (next: ReviewEvent) => {
    if (next.id === activeId || busy) return
    setActiveId(next.id)
    setEditingFact('')
    setImageEditorOpen(false)
    setEditingEntity('')
    setNotice(null)
  }

  const removeEvent = (target: ReviewEvent) => {
    if (busy) return
    const remaining = events.filter((event) => event.id !== target.id)
    setEvents(remaining)
    setImages((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== target.id)))
    if (target.id === activeId) setActiveId(remaining[0]?.id ?? '')
    setNotice(remaining.length ? { type: 'ok', text: interpolate(copy.sessionRemoved, { title: target.data.title }) } : null)
  }

  const chooseImage = (file?: File) => {
    if (!file || !activeEvent || !editing) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setNotice({ type: 'error', text: copy.imageTypeError })
      return
    }
    if (file.size > 5_000_000) {
      setNotice({ type: 'error', text: copy.imageSizeError })
      return
    }
    setImages((current) => ({ ...current, [activeEvent.id]: file }))
    updateActiveEvent((event) => ({
      ...event,
      error: undefined,
      data: {
        ...event.data,
        imageUrl: '',
        uploadedImage: { fileName: file.name, mimeType: file.type, size: file.size },
      },
      submission: event.submission ? { ...event.submission, imageAdded: false, completed: false } : undefined,
    }))
    setImageError(false)
    setNotice({ type: 'ok', text: copy.imageStored })
    if (fileInput.current) fileInput.current.value = ''
  }

  const removeImage = () => {
    if (!activeEvent || !editing) return
    setImages((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== activeEvent.id)))
    updateActiveEvent((event) => {
      const data = { ...event.data }
      delete data.uploadedImage
      return {
        ...event,
        data,
        error: undefined,
        submission: event.submission ? { ...event.submission, imageAdded: false, completed: false } : undefined,
      }
    })
    setNotice({ type: 'ok', text: copy.imageRemoved })
  }

  const execute = async () => {
    if (!activeEvent || !editing) return
    setBusy('execute')
    setNotice(null)
    try {
      let submissionImage: Blob | undefined = activeImage ?? previewImages.current[activeEvent.id]
      if (!submissionImage && editing.imageUrl) submissionImage = await api.imagePreview(editing.imageUrl)
      const image = submissionImage
        ? await imagePayload(submissionImage, activeImage?.name ?? 'preview-image', copy.readImageFailed)
        : undefined
      const result = await api.submit(editing, activeEvent.submission ?? {}, image)
      updateActiveEvent((event) => ({
        ...event,
        data: result.data,
        submission: result.progress,
        warnings: result.completed ? [] : event.warnings,
        error: result.error,
      }))
      setConfirmOpen(false)
      if (result.completed) {
        setEditingFact('')
        setImageEditorOpen(false)
      }
      setNotice(result.completed
        ? { type: 'ok', text: copy.eventCreated }
        : { type: 'error', text: result.error ?? copy.submissionIncomplete })
    } catch (error) { showError(error); setConfirmOpen(false) } finally { setBusy('') }
  }

  const languageSwitcher = <LanguageSwitcher locale={locale} onChange={setLocale} copy={copy} />

  if (!config && configError) return <>
    {languageSwitcher}
    <div className="center-state">
      <AlertTriangle size={28} />
      <p>{interpolate(copy.apiUnavailable, { error: configError === '__server_config_failed__' ? copy.serverConfigFailed : configError })}</p>
      <button className="primary-button" onClick={() => setConfigAttempt((attempt) => attempt + 1)}>{copy.reconnect}</button>
    </div>
  </>

  if (!config) return <>{languageSwitcher}<div className="center-state"><LoaderCircle className="spin" /><p>{copy.loading}</p></div></>

  if (!authenticated) return <>{languageSwitcher}<main className="auth-screen">
    <section className="auth-panel">
      <img className="auth-logo" src="/logo-mark.svg" alt="" aria-hidden="true" />
      <h1>Eventernote Autofill</h1>
      <p>{copy.landingSubtitle} {copy.authInstruction}</p>
      <label className="field field-wide"><span className="field-label">{copy.accessKey}</span>
        <input type="password" value={accessKeyInput} onChange={(event) => setAccessKeyInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void authenticate()} autoFocus />
      </label>
      <button className="primary-button" onClick={() => void authenticate()}>{copy.signIn}</button>
      {notice?.type === 'error' && <p className="inline-error">{notice.text}</p>}
    </section>
  </main></>

  if (!activeEvent || !editing) return <>{languageSwitcher}<main className="landing-screen">
    <div className="landing-shell">
      {busy !== 'analyze' && <div className="landing-title">
        <img className="landing-logo" src="/logo-mark.svg" alt="" aria-hidden="true" />
        <h1>Eventernote Autofill</h1>
        <p>{copy.landingSubtitle}</p>
      </div>}

      {busy === 'analyze' ? <div className="analysis-card-wrap">
        <ProcessingCard status="running" stage={analysisStage} locale={locale} />
      </div> : <>
        <div className="landing-input">
          <input type="url" aria-label={copy.sourceUrl} placeholder={copy.pasteUrl} value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void analyze()} autoFocus />
          <button disabled={!sourceUrl.trim()} onClick={() => void analyze()} aria-label={copy.startAnalysis} title={copy.startAnalysis}><ArrowRight size={22} /></button>
        </div>
        {notice?.type === 'error' && <div className="landing-error" role="alert"><AlertTriangle size={18} /><span>{notice.text}</span></div>}
      </>}
    </div>
  </main></>

  return <>{languageSwitcher}<div className="app-shell">
    <main className="page results-page">
      <nav className="results-nav" aria-label={copy.eventActions}>
        <button onClick={startOver} disabled={Boolean(busy)}><ArrowLeft size={18} />{copy.analyzeAnother}</button>
      </nav>

      {events.length > 1 && <div className="session-tabs" role="tablist" aria-label={copy.eventSessions}>
        {events.map((item, index) => <div key={item.id} className={`session-tab ${item.id === activeId ? 'active' : ''}`}>
          <button className="session-select" role="tab" aria-selected={item.id === activeId}
            disabled={Boolean(busy)} onClick={() => selectEvent(item)}>
            <span>{item.data.startTime || `${copy.session} ${index + 1}`}</span>
            <small>{item.data.title.match(/日場|夜場|昼公演|夜公演|After[- ]?Talk|アフタートーク|ライブアフタースペシャルトーク/i)?.[0] ?? `${copy.session} ${index + 1}`}</small>
          </button>
          <button className="session-delete" disabled={Boolean(busy)} onClick={() => removeEvent(item)}
            aria-label={`${copy.deleteSession} ${item.data.title}`} title={copy.deleteThisSession}><Trash2 size={16} /></button>
        </div>)}
      </div>}

      {notice && <div className={`notice notice-${notice.type}`} role="status">
        {notice.type === 'ok' ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}
        <span>{notice.text}</span>
        <button className="close-button" onClick={() => setNotice(null)} aria-label={copy.closeNotice}><X size={18} /></button>
      </div>}

      <article className="event-editor">
        <header className="event-heading">
          <div className="event-heading-copy">
            <h2>{editing.title || copy.untitledEvent}</h2>
            <a href={activeEvent.sourceUrl} target="_blank" rel="noreferrer">{copy.viewSource} <ExternalLink size={15} /></a>
          </div>
          {!activeEvent.submission?.completed && <button className="primary-button event-submit-button"
            disabled={Boolean(busy) || needsEntityConfirmation} onClick={() => void prepareForConfirmation()}>
            {busy === 'prepare' ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
            {needsEntityConfirmation ? copy.confirmNewItemsFirst : busy === 'prepare' ? copy.checking : copy.submit}
          </button>}
        </header>

        {activeEvent.error && <section className="issues" aria-label={copy.submissionError}>
          <p className="submission-error"><AlertTriangle size={18} /><span><ErrorText text={activeEvent.error} copy={copy} /></span></p>
        </section>}

        <section className="ai-review" aria-label={copy.aiResult}>
          <div className="review-facts">
            {editingFact === 'title' && !coreLocked
              ? <div className="review-fact review-fact-wide review-fact-editing">
                  <label htmlFor="review-title">{copy.event}</label>
                  <div className="review-fact-input-row">
                    <input id="review-title" value={editing.title} autoFocus onChange={(event) => update('title', event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && setEditingFact('')} />
                    <button type="button" className="secondary-button" onClick={() => setEditingFact('')}>{copy.done}</button>
                  </div>
                </div>
              : <button type="button" className="review-fact review-fact-wide" disabled={coreLocked}
                  onClick={() => setEditingFact('title')}>
                  <span>{copy.event}</span><strong>{editing.title || copy.missingEventName}</strong>
                  {!coreLocked && <small><Pencil size={13} />{copy.clickToEdit}</small>}
                </button>}
            {editingFact === 'schedule' && !coreLocked
              ? <div className="review-fact review-fact-editing review-schedule-editor">
                  <label>{copy.date}<input type="date" value={editing.date} autoFocus onChange={(event) => update('date', event.target.value)} /></label>
                  <label>{copy.doorsOpen}<input type="time" value={editing.openTime} onChange={(event) => update('openTime', event.target.value)} /></label>
                  <label>{copy.starts}<input type="time" value={editing.startTime} onChange={(event) => updateStartTime(event.target.value)} /></label>
                  <label>{copy.ends}<input type="time" value={editing.endTime} onChange={(event) => update('endTime', event.target.value)} /></label>
                  <button type="button" className="secondary-button" onClick={() => setEditingFact('')}>{copy.done}</button>
                </div>
              : <button type="button" className="review-fact" disabled={coreLocked} onClick={() => setEditingFact('schedule')}>
                  <span>{copy.date}</span><strong>{editing.date || copy.unavailable}</strong><small>{displayTime(editing, copy)}</small>
                  {!coreLocked && <small className="review-fact-edit-hint"><Pencil size={13} />{copy.clickToEdit}</small>}
                </button>}
            <button type="button" className="review-fact" disabled={coreLocked} onClick={() => setImageEditorOpen(true)}>
              <span>{copy.eventImage}</span><strong>{editing.uploadedImage?.fileName || (editing.imageUrl ? copy.obtainedFromSource : copy.notProvidedBySource)}</strong>
              <small>{coreLocked ? copy.imageOptional : <><ImagePlus size={14} />{copy.clickToEdit}</>}</small>
            </button>
          </div>

          {previewUrl && !imageError && <button type="button" className="review-image-preview" disabled={coreLocked}
            onClick={() => setImageEditorOpen(true)} aria-label={copy.previewEditImage}>
            <img src={previewUrl} alt={copy.imagePreview} onError={() => setImageError(true)} />
          </button>}

          <section className="summary-entities" aria-labelledby="summary-entities-title">
            <div className="summary-section-heading">
              <div><h4 id="summary-entities-title">{copy.eventernoteItems}</h4><p>{copy.eventernoteItemsHelp}</p></div>
            </div>
            <EventernoteEntityField kind="place" label={copy.place} name={editing.place.name} selectedId={editing.place.selectedId}
              createNew={editing.place.createNew} candidates={editing.place.candidates} status={placeSearchStatus}
              editing={placeSearchVisible} newConfirmed={isNewConfirmed(placeEntityKey)} disabled={coreLocked}
              evidence={activeEvent.evidence['place.selection']} copy={copy} onBeginEdit={() => setEditingEntity(placeEntityKey)}
              onQueryChange={(value) => {
                clearNewConfirmation(placeEntityKey)
                setEditingEntity(placeEntityKey)
                updatePlace({ name: value, selectedId: '', createNew: false, candidates: [] })
              }} onSelect={selectPlaceCandidate} onConfirmNew={confirmNewPlace} onCancel={() => setEditingEntity('')} />
            {editing.actors.map((actor, index) => {
              const key = actorEntityKey(index)
              const searchVisible = editingEntity === key || (actor.createNew && !isNewConfirmed(key))
                || Boolean(actor.name && !actor.selectedId && !actor.createNew)
              return <EventernoteEntityField key={key} kind="actor" label={`${copy.actor} ${index + 1}`} name={actor.name}
                selectedId={actor.selectedId} createNew={actor.createNew} candidates={actor.candidates}
                status={actorSearchStatuses[index] ?? 'idle'} editing={searchVisible} newConfirmed={isNewConfirmed(key)} disabled={coreLocked}
                evidence={activeEvent.evidence[`actors.${index}.selection`]} copy={copy} onBeginEdit={() => setEditingEntity(key)}
                onQueryChange={(value) => {
                  clearNewConfirmation(key)
                  setEditingEntity(key)
                  updateActor(index, {
                    name: value, reading: '', searchKeywords: '', sex: '', selectedId: '', createNew: false, candidates: [],
                  })
                }} onSelect={(candidate) => selectActorCandidate(index, candidate)} onConfirmNew={() => confirmNewActor(index)}
                onCancel={() => setEditingEntity('')} onRemove={() => removeActor(index)} />
            })}
            {editing.actors.length === 0 && <p className="summary-empty">{copy.noActors}</p>}
            {!coreLocked && <button type="button" className="add-button summary-add-actor" onClick={addActor}>
              <Plus size={17} />{copy.addActor}
            </button>}
          </section>

          <label className="review-description-editor">
            <span>{copy.description}</span>
            <textarea rows={6} value={editing.description} disabled={coreLocked} onChange={(event) => update('description', event.target.value)}
              placeholder={copy.descriptionPlaceholder} />
          </label>
          {activeEvent.warnings.length > 0 && <details className="review-notes">
            <summary>{interpolate(copy.aiNotes, { count: activeEvent.warnings.length })}</summary>
            <ul>{activeEvent.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </details>}
        </section>

        {activeEvent.submission?.completed && <footer className="editor-actions">
          <SubmissionSuccessActions eventUrl={activeEvent.submission.eventUrl} onBackToLanding={startOver} locale={locale} />
        </footer>}
      </article>
    </main>

    {imageEditorOpen && activeEvent && editing && <div className="modal-backdrop" role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && setImageEditorOpen(false)}>
      <section className="confirm-modal image-editor-modal" role="dialog" aria-modal="true" aria-labelledby="image-editor-title">
        <div className="confirm-heading">
          <span><ImagePlus size={22} /></span>
          <div><h2 id="image-editor-title">{copy.editImage}</h2><p>{copy.imageEditorHelp}</p></div>
        </div>
        <div className={`image-preview ${imageError || !previewUrl ? 'image-empty' : ''}`}>
          {previewUrl && !imageError
            ? <img src={previewUrl} alt={copy.imagePreview} onError={() => setImageError(true)} />
            : <><ImagePlus size={34} /><span>{imageError ? copy.imageLoadFailed : copy.imagePreviewPlaceholder}</span></>}
        </div>
        <Field label={copy.imageUrl} value={editing.imageUrl} onChange={updateImageUrl}
          placeholder={editing.uploadedImage ? copy.uploadedImageInUse : 'https://...'}
          disabled={Boolean(busy) || Boolean(editing.uploadedImage)} wide copy={copy} />
        <div className="upload-row">
          <input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp"
            onChange={(event) => chooseImage(event.target.files?.[0])} />
          <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
            <Upload size={18} />{editing.uploadedImage ? copy.replaceImage : copy.uploadImage}
          </button>
          {editing.uploadedImage && <div className="uploaded-file"><span className="file-name" title={editing.uploadedImage.fileName}>{editing.uploadedImage.fileName}</span>
            <button type="button" className="icon-button" disabled={Boolean(busy)} onClick={removeImage}
              title={copy.removeUploadedImage} aria-label={copy.removeUploadedImage}><Trash2 size={17} /></button></div>}
        </div>
        {editing.uploadedImage && <p className="image-editor-note">{copy.uploadedImageNote}</p>}
        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={() => setImageEditorOpen(false)}>{copy.done}</button>
        </div>
      </section>
    </div>}

    {confirmOpen && activeEvent && editing && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirmOpen(false)}>
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="confirm-heading">
          <span><CheckCircle2 size={22} /></span>
          <div><h2 id="confirm-title">{copy.finalConfirmation}</h2><p>{copy.willWriteToEventernote}</p></div>
        </div>
        <dl className="confirm-summary">
          <div><dt>{copy.event}</dt><dd>{editing.title}</dd></div>
          <div><dt>{copy.dateTime}</dt><dd>{editing.date} {editing.startTime}</dd></div>
          <div><dt>{copy.place}</dt><dd>{editing.place.name} ({editing.place.selectedId ? copy.existingItem : copy.createNewItem})</dd></div>
          <div><dt>{copy.actor}</dt><dd>{editing.actors.map((actor) => `${actor.name} (${actor.selectedId ? copy.useExistingShort : copy.createNewItem})`).join(locale === 'en' ? ', ' : '、') || copy.notProvided}</dd></div>
          <div><dt>{copy.image}</dt><dd>{editing.uploadedImage?.fileName || editing.imageUrl || copy.notProvided}</dd></div>
        </dl>
        {previewUrl && !imageError && <div className="confirm-image-preview">
          <img src={previewUrl} alt={copy.outgoingImagePreview} onError={() => setImageError(true)} />
        </div>}
        <p className="confirm-note">{copy.confirmationNote}</p>
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => setConfirmOpen(false)}>{copy.backToEdit}</button>
          <button className="primary-button" disabled={Boolean(busy)} onClick={() => void execute()}>
            {busy === 'execute' ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}{busy === 'execute' ? copy.writing : copy.confirmWrite}
          </button>
        </div>
      </section>
    </div>}
  </div></>
}

export default App
