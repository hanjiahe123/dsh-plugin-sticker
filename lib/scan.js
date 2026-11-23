import fs from 'node:fs'
import path from 'node:path'
import {
  packageDirs,
  readJsonFile,
  readTextFile,
  readmeExcerpt,
} from './profile.js'

const LOCALES = ['zh', 'en']

/** This plugin's own package name; scanning skips it. */
export const SELF_PACKAGE = 'dsh-plugin-sticker'

/**
 * Current sticker metadata of one package, preferring the Chinese file.
 * @returns { null | { lang: string, title: string, description?: string } }
 */
export function stickerOf(dir) {
  for (const lang of LOCALES) {
    const meta = readJsonFile(path.join(dir, 'locale', lang + '.json'))
    const title = meta?.meta?.title
    if (typeof title === 'string' && title.trim()) {
      return { lang, title: title.trim(), description: meta?.meta?.description }
    }
  }
  return null
}

/** How this package reached the profile. */
function installKind(spec) {
  if (!spec) return 'bundled'
  if (spec.startsWith('link:')) return 'link'
  if (spec.startsWith('file:')) return 'local-path'
  if (/^(https?:|git\+|git@|github:|gitlab:|bitbucket:)/i.test(spec)) return 'git'
  return 'registry'
}

/**
 * Can a `./locale/*.json` export be added without changing existing semantics?
 * A string or array `exports` would have to be rewritten; we refuse that.
 */
export function exportsState(pkg) {
  const map = pkg.exports
  if (map === undefined || map === null) return { patchable: true, present: true, needsPatch: false }
  if (typeof map !== 'object' || Array.isArray(map)) {
    return { patchable: false, present: false, needsPatch: false }
  }
  const present = Object.prototype.hasOwnProperty.call(map, './locale/*.json')
  return { patchable: true, present, needsPatch: !present }
}

function isInside(child, parent) {
  if (!parent) return false
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Every bundle declared by an installed package, with what a sticker needs.
 * @param profileDir - profile root.
 * @param options.selfName - this plugin's own package name, skipped.
 * @param options.installDir - DSH installation, whose packages are read-only.
 */
export function scanBundles(profileDir, { selfName, installDir } = {}) {
  const profileManifest = readJsonFile(path.join(profileDir, 'package.json'), {})
  const dependencies = profileManifest?.dependencies ?? {}
  const selected = new Set(Array.isArray(profileManifest?.dsh?.profile?.bundles) ? profileManifest.dsh.profile.bundles : [])
  const nodeModules = path.join(profileDir, 'node_modules')
  const rows = []

  for (const entry of packageDirs(nodeModules)) {
    const manifest = readJsonFile(path.join(entry.dir, 'package.json'))
    if (!manifest?.name) continue
    if (!manifest.dsh?.bundle) continue
    if (selfName && manifest.name === selfName) continue

    let realDir = entry.dir
    let link = false
    try {
      link = fs.lstatSync(entry.dir).isSymbolicLink()
      realDir = fs.realpathSync(entry.dir)
    } catch {
      continue
    }

    const spec = dependencies[manifest.name]
    const kind = isInside(realDir, installDir) ? 'installation' : installKind(spec)
    const sticker = stickerOf(realDir)
    const state = exportsState(manifest)

    let writable = true
    try {
      fs.accessSync(realDir, fs.constants.W_OK)
      fs.accessSync(path.join(realDir, 'package.json'), fs.constants.R_OK)
    } catch {
      writable = false
    }

    const readme = readmeExcerpt(realDir)
    const readonlyReason = kind === 'installation' || kind === 'bundled'
      ? 'installation'
      : !state.patchable
        ? 'exports-not-map'
        : !writable
          ? 'not-writable'
          : null

    rows.push({
      package: manifest.name,
      version: manifest.version ?? null,
      dir: realDir,
      linked: link,
      installKind: kind,
      selected: selected.has(manifest.name),
      description: typeof manifest.description === 'string' ? manifest.description : null,
      hasSticker: Boolean(sticker),
      title: sticker?.title ?? null,
      exportsNeedsPatch: state.needsPatch,
      readmeFile: readme?.file ?? null,
      readmeExcerpt: readme?.text ?? null,
      canApply: readonlyReason === null,
      skipReason: readonlyReason,
    })
  }

  rows.sort((a, b) => {
    if (a.canApply !== b.canApply) return a.canApply ? -1 : 1
    if (a.hasSticker !== b.hasSticker) return a.hasSticker ? 1 : -1
    return a.package.localeCompare(b.package)
  })
  return rows
}

/** Short human report of the current sticker state. */
export function describeRow(row) {
  const parts = [row.package]
  if (row.version) parts.push('v' + row.version)
  parts.push(row.hasSticker ? '已贴：' + row.title : '未贴')
  parts.push(row.installKind)
  if (row.selected) parts.push('已启用')
  if (row.skipReason) parts.push('跳过：' + row.skipReason)
  return parts.join(' · ')
}

export { readTextFile }
