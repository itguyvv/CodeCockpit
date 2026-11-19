const dgram = require('node:dgram')

// RFC 5389 binding request: MAGIC_COOKIE + 96 random transaction id
function buildRequest() {
  const msg = Buffer.alloc(20)
  msg.writeUInt16BE(0x0001, 0)
  msg.writeUInt16BE(0, 2)
  msg.writeUInt32BE(0x2112a442, 4)
  for (let i = 8; i < 20; i++) msg[i] = Math.floor(Math.random() * 256)
  return msg
}

function probe(host, port, label) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let done = false
    const finish = (r) => { if (!done) { done = true; try { sock.close() } catch {} resolve(r) } }
    const t = setTimeout(() => finish(`${label}: TIMEOUT`), 4000)
    sock.on('message', (m) => {
      clearTimeout(t)
      const type = m.readUInt16BE(0)
      finish(`${label}: RESPONDED type=0x${type.toString(16).padStart(4, '0')} bytes=${m.length}`)
    })
    sock.on('error', (e) => { clearTimeout(t); finish(`${label}: ERROR ${e.message}`) })
    sock.send(buildRequest(), port, host, (e) => { if (e) { clearTimeout(t); finish(`${label}: SEND-ERR ${e.message}`) } })
  })
}

const targets = process.argv.slice(2)
;(async () => {
  for (const t of targets) {
    const [host, port] = t.split(':')
    console.log(await probe(host, Number(port || 3478), t))
  }
})()
