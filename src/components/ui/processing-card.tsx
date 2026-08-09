import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CheckCircle2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMessages, type Locale } from '@/i18n'
import type { AnalysisStage } from '../../../shared/types'

type ProcessingStatus = 'queued' | 'running' | 'succeeded' | 'failed'

interface ProcessingCardProps {
  name?: string
  className?: string
  status?: ProcessingStatus
  stage?: AnalysisStage
  locale?: Locale
}

const progressRanges: Record<AnalysisStage, { start: number; ceiling: number }> = {
  fetching_source: { start: 4, ceiling: 20 },
  following_links: { start: 24, ceiling: 40 },
  preparing_images: { start: 44, ceiling: 56 },
  ai_extraction: { start: 60, ceiling: 84 },
  preparing_review: { start: 88, ceiling: 97 },
  completed: { start: 100, ceiling: 100 },
}

const LetterGlitch: React.FC<{ className?: string }> = ({ className }) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    const context = canvas?.getContext('2d')
    if (!canvas || !parent || !context) return

    const colors = ['#78b4ff', '#a0c4ff', '#c7d2fe', '#e0e7ff', '#f0f4ff']
    const symbols = ['.', ' ', ':', ';', '-', '*', '#']
    const charWidth = 10
    const charHeight = 20
    let columns = 0
    let rows = 0
    let animationFrame = 0
    let lastUpdate = 0
    let letters: Array<{ char: string; color: string }> = []

    const randomItem = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)]
    const initialize = () => {
      const rect = parent.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      columns = Math.ceil(rect.width / charWidth)
      rows = Math.ceil(rect.height / charHeight)
      letters = Array.from({ length: columns * rows }, () => ({
        char: randomItem(symbols),
        color: randomItem(colors),
      }))
    }

    const draw = () => {
      const rect = parent.getBoundingClientRect()
      context.clearRect(0, 0, rect.width, rect.height)
      context.font = '16px monospace'
      context.textBaseline = 'top'
      letters.forEach((letter, index) => {
        context.fillStyle = letter.color
        context.fillText(
          letter.char,
          (index % columns) * charWidth,
          Math.floor(index / columns) * charHeight,
        )
      })
    }

    const animate = (timestamp: number) => {
      if (timestamp - lastUpdate >= 50 && letters.length) {
        const updateCount = Math.max(1, Math.floor(letters.length * 0.05))
        for (let index = 0; index < updateCount; index += 1) {
          const letter = letters[Math.floor(Math.random() * letters.length)]
          letter.char = randomItem(symbols)
          letter.color = randomItem(colors)
        }
        draw()
        lastUpdate = timestamp
      }
      animationFrame = requestAnimationFrame(animate)
    }

    initialize()
    draw()
    animationFrame = requestAnimationFrame(animate)
    const resizeObserver = new ResizeObserver(() => {
      initialize()
      draw()
    })
    resizeObserver.observe(parent)

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className={cn('block h-full w-full', className)} />
}

const CustomLoader = () => <div className="custom-loader-5" aria-hidden="true"><span /></div>

function useEstimatedProgress(stage: AnalysisStage, status: ProcessingStatus): number {
  const range = progressRanges[stage]
  const [progress, setProgress] = React.useState(
    status === 'succeeded' || stage === 'completed' ? 100 : range.start,
  )

  React.useEffect(() => {
    if (status === 'succeeded' || stage === 'completed') {
      setProgress(100)
      return
    }
    if (status === 'failed') return

    setProgress((current) => Math.max(current, range.start))
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= range.ceiling) return range.ceiling
        const remaining = range.ceiling - current
        return Math.min(range.ceiling, current + Math.max(0.12, remaining * 0.025))
      })
    }, 120)

    return () => window.clearInterval(timer)
  }, [range.ceiling, range.start, stage, status])

  return progress
}

const PercentageProgressBar: React.FC<{ progress: number; label: string }> = ({ progress, label }) => {
  const reducedMotion = useReducedMotion()
  const percentage = Math.min(100, Math.max(0, Math.round(progress)))

  return (
    <div
      className="w-[min(28rem,78vw)] max-w-full"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
      aria-valuetext={`${percentage}%`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-4 text-white/60">
        <span className="text-xs font-medium">{label}</span>
        <span className="min-w-12 text-right font-mono text-sm font-semibold tabular-nums text-white">
          {percentage}%
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-sm bg-white/10" aria-hidden="true">
        <motion.div
          className="h-full rounded-sm bg-[#8fa6f2] shadow-[0_0_10px_rgba(143,166,242,0.35)]"
          initial={false}
          animate={{ width: `${progress}%` }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.32, ease: 'easeOut' }}
        />
      </div>
    </div>
  )
}

export default function ProcessingCard({
  name,
  className,
  status = 'queued',
  stage = 'fetching_source',
  locale = 'zh-TW',
}: ProcessingCardProps) {
  const copy = getMessages(locale)
  const processingStages = [
    { key: 'fetching_source', label: copy.fetchingSource },
    { key: 'following_links', label: copy.followingLinks },
    { key: 'preparing_images', label: copy.preparingImages },
    { key: 'ai_extraction', label: copy.aiExtraction },
    { key: 'preparing_review', label: copy.preparingReview },
  ] satisfies Array<{ key: Exclude<AnalysisStage, 'completed'>; label: string }>
  const progress = useEstimatedProgress(stage, status)
  const stageIndex = stage === 'completed'
    ? processingStages.length
    : Math.max(0, processingStages.findIndex((item) => item.key === stage))
  const currentStage = processingStages[Math.min(stageIndex, processingStages.length - 1)]
  const statusText = status === 'queued'
    ? copy.preparingAnalysis
    : status === 'running'
      ? currentStage.label
      : status === 'succeeded'
        ? copy.analysisComplete
        : copy.analysisFailed

  return (
    <section
      className={cn(
        'w-full overflow-hidden rounded-2xl border border-white/8 bg-[#2b2d31]/80 text-white shadow-[0_18px_48px_rgba(0,0,0,0.24)] backdrop-blur-xl',
        className,
      )}
      aria-live="polite"
    >
      <header className="border-b border-white/7 bg-white/[0.015] px-4 py-3">
        <h2 className="truncate text-sm font-medium text-white/90">{name ?? copy.analysisTitle}</h2>
      </header>

      <div className="relative h-[min(400px,52vh)] min-h-72 w-full overflow-hidden bg-[#25262a] text-white">
        <div className="absolute inset-0 z-10 opacity-[0.18]" aria-hidden="true">
          <LetterGlitch />
          <div className="absolute inset-0 bg-[radial-gradient(circle,_rgba(35,36,40,0)_45%,_rgba(35,36,40,0.68)_100%)]" />
        </div>
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(114,137,218,0.13), transparent 70%), #25262a' }}
        />

        <div className="relative z-20 flex h-full flex-col items-center justify-center px-4">
          <div className="mb-5 grid h-8 w-8 place-items-center drop-shadow-[0_0_8px_rgba(120,180,255,0.4)]">
            {status === 'running' || status === 'queued'
              ? <CustomLoader />
              : status === 'succeeded'
                ? <CheckCircle2 className="h-8 w-8 text-[#78b4ff]" />
                : <TriangleAlert className="h-8 w-8 text-red-300" />}
          </div>

          <AnimatePresence mode="wait">
            <motion.p
              key={`${currentStage.key}-${status}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="mb-4 text-center text-sm font-bold text-white/90"
            >
              {statusText}
            </motion.p>
          </AnimatePresence>

          {status !== 'failed' && <PercentageProgressBar progress={progress} label={copy.progress} />}
        </div>
      </div>
    </section>
  )
}
