// Sidecar record of the names you chose.
//
// A package update replaces the package directory, which takes the locale files
// with it. The display name has exactly one source — the package's own locale
// metadata — so there is no profile-level override to switch to. What this file
// buys you is memory: after an update, the plugin knows what the name used to be
// and can offer to write it back.

import fs from 'node:fs'
import path from 'node:path'

const FORMAT_VERSION = 1

export function registryFile(profileDir) {
  return path.join(profileDir, '.plugin-sticker', 'stickers.json')
}

/** Read the registry; a missing or unreadable file yields an empty one. */
export function loadRegistry(profileDir) {
  const file = registryFile(profileDir)
  let text = null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { version: FORMAT_VERSION, stickers: {}, file, problem: null }
  }
  try {
    const parsed = JSON.parse(text)
    const stickers = parsed && typeof parsed.stickers === 'object' && !Array.isArray(parsed.stickers)
      ? parsed.stickers
      : {}
    return { version: FORMAT_VERSION, stickers, file, problem: null }
  } catch {
    return { version: FORMAT_VERSION, stickers: {}, file, problem: 'stickers.json 不是合法 JSON，已当作空记录；下次写入前会把它备份到旁边。' }
  }
}

/**
 * Write the registry atomically. A corrupt file is preserved as `.broken-<time>`
 * before being replaced, so hand edits are never silently destroyed.
 */
export function saveRegistry(profileDir, registry) {
  const file = registryFile(profileDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        fs.renameSync(file, file + '.broken-' + stamp)
      } catch {
        // keep going: the write below still replaces it
      }
    }
  }
  const payload = JSON.stringify({ version: FORMAT_VERSION, stickers: registry.stickers ?? {} }, null, 2) + '\n'
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, payload, 'utf8')
  fs.renameSync(tmp, file)
}

/** Record one sticker after it was written successfully. */
export function recordSticker(profileDir, packageName, { title, description, titleEn, version }) {
  const registry = loadRegistry(profileDir)
  const previous = registry.stickers[packageName] ?? {}
  registry.stickers[packageName] = {
    title,
    ...(description !== undefined ? { description } : previous.description !== undefined ? { description: previous.description } : {}),
    ...(titleEn !== undefined ? { titleEn } : previous.titleEn !== undefined ? { titleEn: previous.titleEn } : {}),
    recordedVersion: version ?? previous.recordedVersion ?? null,
    recordedAt: new Date().toISOString(),
  }
  saveRegistry(profileDir, registry)
  return registry.stickers[packageName]
}

/** Drop one record (the user deleted it on purpose). */
export function forgetSticker(profileDir, packageName) {
  const registry = loadRegistry(profileDir)
  if (!(packageName in registry.stickers)) return false
  delete registry.stickers[packageName]
  saveRegistry(profileDir, registry)
  return true
}
