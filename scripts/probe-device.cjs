const crypto = require('node:crypto')
const WebSocket = require('ws')

const id = process.argv[2]
const secret = process.argv[3]
const server = process.argv[4] || 'https://signal.ieeh.com'
const regKey = crypto.createHash('sha256').update(secret + 'cc-link-reg-v1').digest('hex')
const url = `${server.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws?role=client&id=${id}&k=${regKey}`

console.log('probing', id, 'on', server)
const sock = new WebSocket(url, { handshakeTimeout: 10_000 })
const done = (msg) => { console.log('RESULT:', msg); sock.close(); process.exit(0) }
setTimeout(() => done('TIMEOUT-no-upgrade-15s'), 15_000)
sock.on('unexpected-response', (_req, res) => {
  let body = ''
  res.on('data', (c) => { body += c })
  res.on('end', () => done(`HTTP ${res.statusCode} ${body}`))
})
sock.on('open', () => console.log('upgrade ok, waiting for joined...'))
sock.on('message', (d) => {
  const f = JSON.parse(String(d))
  if (f.t === 'joined') done('REGISTERED (device online, cid=' + f.cid + ')')
  else if (f.t === 'offer') done('REGISTERED (got offer forwarded)')
  else done('frame ' + JSON.stringify(f))
})
sock.on('error', (e) => done('ERROR ' + e.message))
sock.on('close', (c) => { if (c !== 1000 && c !== 1005) done('CLOSE ' + c) })
