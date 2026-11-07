// electron-builder --dir always outputs to dist/win-unpacked. This script:
// 1) renames it to a fixed distribution folder name (no version, so upgrades can overwrite the whole folder)
// 2) packs it into a versioned zip (the distributable you share with others)
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))

const dirName = 'CodeCockpit'
const src = path.join(root, 'dist', 'win-unpacked')
const dest = path.join(root, 'dist', dirName)

if (!fs.existsSync(src)) {
  console.error('[rename-dist] dist/win-unpacked not found; the build may have failed')
  process.exit(1)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.renameSync(src, dest)
// Remove folders left by legacy naming schemes (locked ones are skipped)
for (const legacy of ['codecockpit_win_unpacked', `codecockpit_win_unpacked_${version}`]) {
  try {
    fs.rmSync(path.join(root, 'dist', legacy), { recursive: true, force: true })
  } catch {
    console.warn(`[rename-dist] legacy folder ${legacy} is locked; skipped`)
  }
}
console.log(`[rename-dist] output folder: dist/${dirName}`)

// ── Pack the zip: CodeCockpit-<version>-win-x64.zip, with one top-level folder ──
const zipName = `CodeCockpit-${version}-win-x64.zip`
const zipPath = path.join(root, 'dist', zipName)
fs.rmSync(zipPath, { force: true })

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 600_000, ...opts }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  })

async function makeZip() {
  // Prefer the built-in bsdtar (fast); fall back to PowerShell Compress-Archive
  try {
    await run('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', zipPath, dirName], {
      cwd: path.join(root, 'dist')
    })
  } catch {
    await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path (Join-Path '${(path.join(root, 'dist')).replace(/'/g, "''")}' '${dirName}') -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    ])
  }
  // Remove zips left over from older versions (folder name is fixed; zip name follows the version)
  for (const f of fs.readdirSync(path.join(root, 'dist'))) {
    if (/^CodeCockpit-[\d.]+-win-x64\.zip$/.test(f) && f !== zipName) {
      fs.rmSync(path.join(root, 'dist', f), { force: true })
    }
  }
}

makeZip()
  .then(() => console.log(`[rename-dist] distributable: dist/${zipName}`))
  .catch((e) => {
    console.error('[rename-dist] failed to create the zip:', e.message)
    process.exit(1)
  })
