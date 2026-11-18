// Drives the linkDebug.html phone simulator in headless Chrome over CDP to
// exercise the desktop link bridge end to end (signaling -> WebRTC -> DC -> remoteServer).
// Usage: node scripts/cdp-link-test.mjs <deviceId> <secret> [attachId] [inputId]
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [, , deviceId, secret, attachId = '', inputId = ''] = process.argv
if (!deviceId || !secret) {
  console.error('usage: node cdp-link-test.mjs <deviceId> <secret> [attachId] [inputId]')
  process.exit(2)
}

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PAGE = new URL('./linkDebug.html', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const PORT = 9224 + Math.floor(Math.random() * 300)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userData = mkdtempSync(path.join(tmpdir(), 'cc-linkdbg-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  '--no-first-run',
  '--disable-gpu',
  `file:///${PAGE}`
], { stdio: 'ignore' })

const results = []
const push = (name, ok, info = '') => {
  results.push([name, ok, info])
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (info ? '  [' + info + ']' : ''))
}

let ws = null
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const evalJs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.value
}

async function waitLogged(substr, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const logText = await evalJs(`document.getElementById('log').innerText`)
    if (logText.includes(substr)) return logText
    await sleep(500)
  }
  return null
}

try {
  // Wait for the CDP endpoint
  let targets = null
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`)
      targets = await res.json()
      break
    } catch {
      await sleep(500)
    }
  }
  const page = targets?.find((t) => t.type === 'page' && t.url.includes('linkDebug')) ?? targets?.find((t) => t.type === 'page' && t.url.startsWith('file:'))
  if (!page) throw new Error('no page target')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m.result ?? m)
      pending.delete(m.id)
    }
  })

  for (let i = 0; i < 20 && !(await evalJs(`!!document.getElementById('log')`)); i++) await sleep(250)

  await evalJs(`(async () => {
    document.getElementById('server').value = 'http://127.0.0.1:8787'
    document.getElementById('devid').value = ${JSON.stringify(deviceId)}
    document.getElementById('secret').value = ${JSON.stringify(secret)}
    document.getElementById('btnConn').click()
  })()`)
  push('connect clicked', true)

  const dcState = await waitLogged('datachannel OPEN')
  if (!dcState) {
    const st = await evalJs(`document.getElementById('state').textContent`).catch(() => '?')
    const lg = await evalJs(`document.getElementById('log').innerText`).catch(() => '?')
    push('diagnostics', false, 'state=' + st + ' log=' + String(lg).slice(0, 600))
  }
  push('datachannel open via signaling + WebRTC', !!dcState, dcState ? '' : 'timeout')

  const authOk = dcState && await waitLogged('authenticated, listing sessions')
  push('auth_ok round trip over DataChannel', !!authOk)

  const listed = authOk && await waitLogged('sessions:')
  push('list round trip', !!listed, listed ? listed.split('sessions:').pop().split('\n')[0].trim() : '')

  if (attachId) {
    await evalJs(`dcSend(JSON.stringify({ type: 'attach', id: ${JSON.stringify(attachId)} }))`)
    const snap = await waitLogged('attached ' + attachId)
    push('attach + conv_snapshot', !!snap)
  }
  if (inputId) {
    await evalJs(`dcSend(JSON.stringify({ type: 'input', id: ${JSON.stringify(inputId)}, data: 'hello from link' }))`)
    // writeInput silently drops unknown sessions; assert the frame was accepted
    // (no error frame) and the channel survived
    await sleep(1500)
    const lg = await evalJs(`document.getElementById('log').innerText`)
    const st = await evalJs(`document.getElementById('state').textContent`)
    push('input frame over DC, channel stays open', st === 'dc open' && !lg.includes('AUTH FAILED'), st)
  }

  // Multi-chunk reassembly on the desktop side: 50KB auth frame split into 16KB chunks.
  // Runs last: the expected auth_fail closes the connection.
  await evalJs(`(async () => {
    const msg = JSON.stringify({ type: 'auth', secret: 'x'.repeat(50000), name: 'ChunkTest' })
    for (const c of frame(msg)) dc.send(c)
  })()`)
  const fail = await waitLogged('AUTH FAILED')
  push('50KB multi-chunk frame reassembled (auth_fail expected)', !!fail, fail ? fail.split('\n').pop().trim() : '')
} catch (e) {
  push('driver error', false, String(e.message ?? e))
} finally {
  try { chrome.kill() } catch {}
  const failed = results.filter(([, ok]) => !ok).length
  console.log(results.length - failed + '/' + results.length + ' passed')
  process.exit(failed ? 1 : 0)
}
