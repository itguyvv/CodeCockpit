// Build resources/icon.icns from the existing PNG icons (pure node, no external tooling).
// ICNS layout: 8-byte header ("icns" magic + uint32 BE total size), then one entry per
// icon: 4-byte type + uint32 BE entry length + raw PNG bytes. Modern macOS renders PNG
// payloads directly, so no bitmap conversion is needed.
// Types: ic08 = 256x256, ic09 = 512x512 (nominal; macOS reads the real PNG dimensions).
const fs = require('node:fs')
const path = require('node:path')

const resources = path.join(__dirname, '..', 'resources')
const png256 = fs.readFileSync(path.join(resources, 'icon256.png'))
const png500 = fs.readFileSync(path.join(resources, 'icon.png'))

const entries = [
  [Buffer.from('ic08', 'ascii'), png256],
  [Buffer.from('ic09', 'ascii'), png500]
]
let total = 8
const bufs = entries.map(([type, png]) => {
  const entry = Buffer.alloc(8 + png.length)
  type.copy(entry, 0)
  entry.writeUInt32BE(entry.length, 4)
  total += entry.length
  return entry
})
const header = Buffer.alloc(8)
header.write('icns', 0, 'ascii')
header.writeUInt32BE(total, 4)
fs.writeFileSync(path.join(resources, 'icon.icns'), Buffer.concat([header, ...bufs]))
console.log(`[icns] wrote resources/icon.icns (${total} bytes)`)
