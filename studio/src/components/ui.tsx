import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Delete-style button: the first click arms it, the second (within 3 s) does it. */
export function ConfirmButton({ onConfirm, children, confirm = 'Click again to confirm', tip, className = '', disabled }:
  { onConfirm: () => void; children: ReactNode; confirm?: string; tip?: string; className?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button className={`${className} ${armed ? 'armed' : ''}`} data-tip={armed ? undefined : tip} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (armed) { setArmed(false); onConfirm() } else setArmed(true) }}>
      {armed ? confirm : children}
    </button>
  )
}

/**
 * Text that turns into an input on click (or the ✎ button); Enter saves, Esc cancels.
 * `penOnly`: only the ✎ edits, so a click on the text reaches the parent (e.g. a row that opens the item).
 */
export function InlineEdit({ value, onSave, placeholder, tip, penOnly }: { value: string; onSave: (v: string) => void; placeholder?: string; tip?: string; penOnly?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) { setV(value); ref.current?.select() } }, [editing, value])
  const edit = (e: React.MouseEvent) => { e.stopPropagation(); setEditing(true) }
  if (!editing) {
    return penOnly
      ? <span className="inline-edit">{value || <i className="muted">{placeholder}</i>} <span className="pen" data-tip={tip ?? 'Rename'} onClick={edit}>✎</span></span>
      : <span className="inline-edit" data-tip={tip ?? 'Click to rename'} onClick={edit}>
        {value || <i className="muted">{placeholder}</i>} <span className="pen">✎</span></span>
  }
  const done = (save: boolean) => { setEditing(false); if (save && v.trim() && v.trim() !== value) onSave(v.trim()) }
  return <input ref={ref} autoFocus value={v} placeholder={placeholder} onClick={(e) => e.stopPropagation()}
    onChange={(e) => setV(e.target.value)} onBlur={() => done(true)}
    onKeyDown={(e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false) }} />
}

/** Click-outside-to-close popover anchored under its trigger. */
export function Popover({ trigger, children, open, setOpen }: { trigger: ReactNode; children: ReactNode; open: boolean; setOpen: (o: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('mousedown', close)
    addEventListener('keydown', esc)
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc) }
  }, [open, setOpen])
  return <div className="popwrap" ref={ref}>{trigger}{open && <div className="popover">{children}</div>}</div>
}

/**
 * One tooltip for the whole app. Any element with data-tip="…" gets it on
 * hover. It lives in a fixed layer on top of everything, so it never stretches
 * a scrolling panel (no surprise scrollbars) and is kept inside the window.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: 'below' | 'above' | 'right' } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let timer = 0
    let current: Element | null = null
    const show = (el: Element) => {
      const text = el.getAttribute('data-tip')
      if (!text) return
      const r = el.getBoundingClientRect()
      if (el.getAttribute('data-tip-pos') === 'right') setTip({ text, x: r.right + 8, y: r.top + r.height / 2, side: 'right' })
      else if (r.bottom + 60 > innerHeight) setTip({ text, x: r.left + r.width / 2, y: r.top - 6, side: 'above' })
      else setTip({ text, x: r.left + r.width / 2, y: r.bottom + 6, side: 'below' })
    }
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest?.('[data-tip]') ?? null
      if (el === current) return
      current = el
      clearTimeout(timer)
      setTip(null)
      if (el) timer = window.setTimeout(() => show(el), 350)
    }
    const hide = () => { clearTimeout(timer); current = null; setTip(null) }
    addEventListener('mouseover', over)
    addEventListener('mousedown', hide)
    addEventListener('scroll', hide, true)
    addEventListener('keydown', hide)
    return () => { removeEventListener('mouseover', over); removeEventListener('mousedown', hide); removeEventListener('scroll', hide, true); removeEventListener('keydown', hide) }
  }, [])
  // Keep it on screen once its size is known
  useEffect(() => {
    const el = ref.current
    if (!el || !tip) return
    const r = el.getBoundingClientRect()
    const dx = r.left < 8 ? 8 - r.left : r.right > innerWidth - 8 ? innerWidth - 8 - r.right : 0
    if (dx) el.style.marginLeft = `${dx}px`
  }, [tip])
  if (!tip) return null
  const transform = tip.side === 'right' ? 'translateY(-50%)' : tip.side === 'above' ? 'translate(-50%, -100%)' : 'translateX(-50%)'
  return <div ref={ref} className="tooltip" style={{ left: tip.x, top: tip.y, transform }}>{tip.text}</div>
}

/** True when the keyboard event is aimed at a text field (so shortcuts stay out of the way). */
export const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
}
