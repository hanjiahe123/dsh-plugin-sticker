import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function isProfileDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile()
  } catch {
    return false
  }
}

function manifestOf(dir) {
  return readJsonFile(path.join(dir, 'package.json'), {})
}

function selectsBundle(dir, packageName) {
  const manifest = manifestOf(dir)
  const bundles = manifest?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) return bundles.includes(packageName)
  const deps = manifest?.dependencies
  return Boolean(deps && Object.prototype.hasOwnProperty.call(deps, packageName))
}

/** Does this profile's node_modules hold exactly this running package copy? */
function ownsSelf(dir, selfPackage, selfDir) {
  if (!selfPackage) return false
  const entry = path.join(dir, 'node_modules', selfPackage)
  try {
    const real = fs.realpathSync(entry)
    if (selfDir) return path.resolve(real) === path.resolve(selfDir)
    return true
  } catch {
    return false
  }
}

function profileRoots() {
  const roots = []
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  try {
    roots.push(path.join(os.homedir(), '.dsh'))
  } catch {
    // no home directory
  }
  return roots
}

/** Every `<root>/profiles/<name>` directory that looks like a profile. */
function profileCandidates() {
  const out = []
  for (const root of profileRoots()) {
    const profilesDir = path.join(root, 'profiles')
    let entries = []
    try {
      entries = fs.readdirSync(profilesDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(profilesDir, entry.name)
      if (isProfileDir(dir)) out.push(dir)
    }
  }
  return out
}

/** `--profile <name>` from this process's own command line, when present. */
function argvProfile() {
  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' && argv[index + 1]) return argv[index + 1]
    if (typeof arg === 'string' && arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return null
}

function mtimeOf(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Locate the running profile directory.
 *
 * A plugin runs inside the Host, where `DSH_PROFILE_DIR` is usually absent (that
 * variable belongs to shell calls). So after the explicit sources we fall back to
 * the profile whose `node_modules` actually carries this package.
 *
 * @returns absolute profile directory, or null.
 */
export function resolveProfileDir({ configured, selfPackage, selfDir } = {}) {
  const direct = []
  if (typeof configured === 'string' && configured.trim()) direct.push(configured.trim())
  if (process.env.DSH_PROFILE_DIR) direct.push(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME) {
    direct.push(path.join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop'))
  }
  const named = argvProfile()
  if (named) {
    for (const root of profileRoots()) direct.push(path.join(root, 'profiles', named))
  }
  for (const candidate of direct) {
    const resolved = path.resolve(candidate)
    if (isProfileDir(resolved)) return resolved
  }

  const owned = profileCandidates().filter((dir) => ownsSelf(dir, selfPackage, selfDir))
  if (owned.length === 0) return null
  if (owned.length === 1) return owned[0]
  const selected = owned.filter((dir) => selectsBundle(dir, selfPackage))
  const pool = selected.length > 0 ? selected : owned
  pool.sort((a, b) => mtimeOf(b) - mtimeOf(a))
  return pool[0]
}

/** Read and parse a JSON file, or return the fallback. */
export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Read a text file, optionally truncated, or return null. */
export function readTextFile(file, limit) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return typeof limit === 'number' ? text.slice(0, limit) : text
  } catch {
    return null
  }
}

const README_NAMES = ['README.zh.md', 'README.zh-CN.md', 'README.md', 'readme.md']
const README_LIMIT = 900

/** First README excerpt found in a package directory. */
export function readmeExcerpt(dir, limit = README_LIMIT) {
  for (const name of README_NAMES) {
    const text = readTextFile(path.join(dir, name), limit)
    if (text && text.trim()) return { file: name, text }
  }
  return null
}

/** Enumerate `node_modules` package directories, including scoped ones. */
export function packageDirs(nodeModulesDir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = path.join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      let scoped = []
      try {
        scoped = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        out.push({ name: entry.name + '/' + child.name, dir: path.join(dir, child.name) })
      }
      continue
    }
    out.push({ name: entry.name, dir })
  }
  return out
}
