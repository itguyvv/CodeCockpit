// Regenerate icon.ico from icon256.png (the PNG is embedded directly into the ICO container)
const fs = require('fs')
const path = require('path')

const resDir = path.join(__dirname, '..', 'resources')
const png = fs.readFileSync(path.join(resDir, 'icon256.png'))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // count

const entry = Buffer.alloc(16)
entry.writeUInt8(0, 0) // width: 0 = 256
entry.writeUInt8(0, 1) // height: 0 = 256
entry.writeUInt8(0, 2) // palette
entry.writeUInt8(0, 3) // reserved
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bit count
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12) // offset

fs.writeFileSync(path.join(resDir, 'icon.ico'), Buffer.concat([header, entry, png]))
console.log('icon.ico written,', png.length, 'bytes png')
