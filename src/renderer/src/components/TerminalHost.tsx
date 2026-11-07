import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Entry {
  term: Terminal
  fit: FitAddon
  offs: Array<() => void>
}

export interface TerminalHandle {
  /** Current container size (creates a temporary pending slot to measure when no terminal is mounted) */
  getDims: () => { cols: number; rows: number }
  /** Create a terminal instance for a session and mount it immediately (usually via the '__pending' placeholder) */
  createSlot: (id: string) => void
  /** After the placeholder gets its real id, rename it and register the data subscription; creates a slot if no placeholder exists */
  renameSlot: (oldId: string, newId: string) => void
  /** Switch the displayed session (the other session's terminal keeps its buffer) */
  attach: (id: string) => void
  /** Write text to a session terminal (exit notices etc.) */
  write: (id: string, text: string) => void
  /** Fully remove a session's terminal instance (when removed from this window) */
  dispose: (id: string) => void
}

function createTerm(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei Mono", "Noto Sans Mono CJK SC", monospace',
    fontSize: 14,
    scrollback: 10000,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: '#15161b',
      foreground: '#dfe1e8',
      cursor: '#4cc2ff',
      selectionBackground: '#2c3e60',
      scrollbarSliderBackground: 'rgba(139,143,163,0.30)',
      scrollbarSliderHoverBackground: 'rgba(139,143,163,0.55)',
      scrollbarSliderActiveBackground: 'rgba(139,143,163,0.70)'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  return { term, fit }
}

/** Whether the clipboard contains an image (sync query via the Electron main process; false on browser debug pages without the api bridge) */
function clipboardHasImage(): boolean {
  try {
    return !!window.api?.clipboardHasImage()
  } catch {
    return false
  }
}

const TerminalHost = forwardRef<TerminalHandle>((_props, ref) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const entries = useRef<Map<string, Entry>>(new Map())
  const attachedId = useRef<string | null>(null)

  useImperativeHandle(ref, () => {
    const PENDING = '__pending'

    const register = (id: string, entry: Entry): void => {
      entry.offs.push(
        window.api.onData((mid, data) => {
          if (mid === id) entry.term.write(data)
        })
      )
      // Keyboard input → PTY
      const dataDisp = entry.term.onData((data) => {
        if (window.api) window.api.input(id, data)
      })
      entry.offs.push(() => dataDisp.dispose())
      const copyClip = (text: string): void => {
        if (window.api) void window.api.copyText(text)
        else void navigator.clipboard?.writeText(text)
      }
      const pasteText = (): void => {
        const read = window.api
          ? window.api.readText()
          : (navigator.clipboard?.readText() ?? Promise.resolve(''))
        void read.then((text) => {
          if (text) entry.term.paste(text)
        })
      }
      // Image paste: send the Alt+V key sequence (ESC v) — the claude CLI on Windows reads clipboard images via Alt+V
      const pasteImageKey = (): void => {
        entry.term.input('\x1bv')
      }
      entry.term.attachCustomKeyEventHandler((evt) => {
        if (evt.type !== 'keydown') return true
        const key = evt.key.toLowerCase()
        if (evt.ctrlKey && evt.shiftKey && key === 'c') {
          if (entry.term.hasSelection()) {
            copyClip(entry.term.getSelection())
            entry.term.clearSelection()
          }
          return false
        }
        if (evt.ctrlKey && evt.shiftKey && key === 'v') {
          pasteText()
          return false
        }
        if (evt.ctrlKey && !evt.shiftKey && key === 'c' && entry.term.hasSelection()) {
          copyClip(entry.term.getSelection())
          entry.term.clearSelection()
          return false
        }
        if (evt.ctrlKey && !evt.shiftKey && key === 'v') {
          if (clipboardHasImage()) {
            pasteImageKey() // Forward as Alt+V; the CLI reads the clipboard image itself
            return false
          }
          // Fallback when no image format is detected: with no text, still try Alt+V (the CLI reads the clipboard itself)
          const read =
            window.api
              ? window.api.readText()
              : (navigator.clipboard?.readText() ?? Promise.resolve(''))
          void read.then((text) => {
            if (text) entry.term.paste(text)
            else pasteImageKey()
          })
          return false
        }
        if (evt.ctrlKey && evt.shiftKey && key === 'a') {
          entry.term.selectAll()
          return false
        }
        return true
      })
    }

    const getDims = (): { cols: number; rows: number } => {
      if (!attachedId.current) {
        const { term, fit } = createTerm()
        const entry: Entry = { term, fit, offs: [] }
        entries.current.set(PENDING, entry)
        if (hostRef.current && !term.element) {
          term.open(hostRef.current)
          try {
            fit.fit()
          } catch {
            // Ignore
          }
        }
        attachedId.current = PENDING
      }
      const entry = entries.current.get(attachedId.current)
      return { cols: entry?.term.cols ?? 110, rows: entry?.term.rows ?? 30 }
    }

    const createSlot = (id: string): void => {
      // Reuse the pending measuring slot (dimensions already measured), otherwise create a fresh terminal
      const pending = entries.current.get(PENDING)
      if (pending && attachedId.current === PENDING) {
        entries.current.delete(PENDING)
        entries.current.set(id, pending)
        attachedId.current = id
        register(id, pending)
        return
      }
      const prev = entries.current.get(attachedId.current ?? '')
      prev?.term.element?.remove()
      const { term, fit } = createTerm()
      const entry: Entry = { term, fit, offs: [] }
      entries.current.set(id, entry)
      if (hostRef.current) {
        term.open(hostRef.current)
        try {
          fit.fit()
        } catch {
          // Ignore
        }
      }
      attachedId.current = id
      register(id, entry)
      void window.api.resize(id, term.cols, term.rows)
      term.focus()
    }

    const renameSlot = (oldId: string, newId: string): void => {
      const entry = entries.current.get(oldId)
      if (!entry) {
        createSlot(newId)
        return
      }
      entries.current.delete(oldId)
      entries.current.set(newId, entry)
      if (attachedId.current === oldId) attachedId.current = newId
      entry.offs.forEach((off) => off())
      entry.offs = []
      register(newId, entry)
    }

    const attach = (id: string): void => {
      if (attachedId.current === id) return
      if (attachedId.current) {
        const cur = entries.current.get(attachedId.current)
        cur?.term.element?.remove()
      }
      const entry = entries.current.get(id)
      if (!entry || !hostRef.current) return
      hostRef.current.appendChild(entry.term.element as HTMLElement)
      attachedId.current = id
      try {
        entry.fit.fit()
      } catch {
        // Ignore
      }
      void window.api.resize(id, entry.term.cols, entry.term.rows)
      entry.term.focus()
    }

    const write = (id: string, text: string): void => {
      entries.current.get(id)?.term.write(text)
    }

    const dispose = (id: string): void => {
      const entry = entries.current.get(id)
      if (!entry) return
      entry.offs.forEach((off) => off())
      if (attachedId.current === id) {
        entry.term.element?.remove()
        attachedId.current = null
      }
      entry.term.dispose()
      entries.current.delete(id)
    }

    return { getDims, createSlot, renameSlot, attach, write, dispose }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      const id = attachedId.current
      const entry = id ? entries.current.get(id) : null
      if (!entry) return
      const sel = entry.term.getSelection()
      const copy = (text: string): void => {
        if (window.api) void window.api.copyText(text)
        else void navigator.clipboard?.writeText(text)
      }
      const read = (): Promise<string> =>
        window.api ? window.api.readText() : (navigator.clipboard?.readText() ?? Promise.resolve(''))
      if (sel) {
        copy(sel)
        entry.term.clearSelection()
      } else if (clipboardHasImage()) {
        entry.term.input('\x1bv') // Forward as Alt+V; the CLI reads the clipboard image itself
      } else {
        void read().then((text) => {
          if (text) entry.term.paste(text)
          else entry.term.input('\x1bv') // Fallback: with no text, still let the CLI try reading the clipboard image
        })
      }
    }
    host.addEventListener('contextmenu', onContextMenu)
    host.addEventListener('mousedown', () => {
      const id = attachedId.current
      if (id) entries.current.get(id)?.term.focus()
    })
    // Drag & drop: files → insert quoted paths (same as cmd); text → paste; also stop Electron from navigating to dropped files
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const id = attachedId.current
      const entry = id ? entries.current.get(id) : null
      if (!entry || !e.dataTransfer) return
      if (e.dataTransfer.files.length > 0) {
        const paths = Array.from(e.dataTransfer.files).map(
          (f) => `"${(f as File & { path?: string }).path || f.name}"`
        )
        entry.term.paste(paths.join(' '))
      } else {
        const text = e.dataTransfer.getData('text/plain')
        if (text) entry.term.paste(text)
      }
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)
    const preventNav = (e: DragEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('dragover', preventNav)
    window.addEventListener('drop', preventNav)
    const ro = new ResizeObserver(() => {
      if (!attachedId.current) return
      const entry = entries.current.get(attachedId.current)
      if (!entry) return
      try {
        entry.fit.fit()
      } catch {
        // Ignore
      }
      if (window.api) void window.api.resize(attachedId.current, entry.term.cols, entry.term.rows)
    })
    ro.observe(host)
    return () => {
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      window.removeEventListener('dragover', preventNav)
      window.removeEventListener('drop', preventNav)
      ro.disconnect()
    }
  }, [])

  return <div className="term-host" ref={hostRef} />
})

TerminalHost.displayName = 'TerminalHost'
export default TerminalHost
