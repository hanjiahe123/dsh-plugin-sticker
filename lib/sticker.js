import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const LOCALES = ['zh', 'en']
const EXPORT_KEY = './locale/*.json'
const EXPORT_TARGET = './locale/*.json'

/** Where backups live: a dot-directory beside the profile manifest. */
export function backupRoot(profileDir) {
  return path.join(profileDir, '.plugin-sticker', 'backups')
}

/**
 * Replace a file through a fresh inode.
 *
 * pnpm hard-links package files from one shared store, so writing in place would
 * change every other project using that store. Renaming a new file over the old
 * one unlinks this copy instead.
 */
function replaceFile(file, content) {
  const tmp = file + '.sticker-tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex')
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

function writeNewFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Validation message, or null when the title is acceptable. */
export function validateTitle(title) {
  if (typeof title !== 'string') return 'title 必须是字符串'
  const trimmed = title.trim()
  if (!trimmed) return 'title 不能为空'
  if (trimmed.length > 40) return 'title 最长 40 字'
  if (/[\r\n\t]/.test(trimmed)) return 'title 不能包含换行或制表符'
  return null
}

/** Validation message, or null when the description is acceptable. */
export function validateDescription(description) {
  if (description === undefined) return null
  if (typeof description !== 'string') return 'description 必须是字符串'
  if (description.length > 160) return 'description 最长 160 字'
  if (/[\r\n]/.test(description)) return 'description 不能包含换行'
  return null
}

function buildLocaleFile(existingText, title, description) {
  let base = {}
  if (existingText) {
    try {
      const parsed = JSON.parse(existingText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed
    } catch {
      base = {}
    }
  }
  const meta = base.meta && typeof base.meta === 'object' ? { ...base.meta } : {}
  meta.title = title
  if (description !== undefined) meta.description = description
  base.meta = meta
  return JSON.stringify(base, null, 2) + '\n'
}

/**
 * Plan one sticker without touching disk.
 * @param target - { package, dir, title, description } from a scan row.
 * @returns plan with the exact before/after content of every file.
 */
export function planSticker(target) {
  const manifestPath = path.join(target.dir, 'package.json')
  const manifestText = readOrNull(manifestPath)
  if (manifestText === null) throw new Error('读不到 ' + manifestPath)

  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw new Error('package.json 不是合法 JSON，拒绝修改：' + manifestPath)
  }

  const files = []
  for (const lang of LOCALES) {
    const file = path.join(target.dir, 'locale', lang + '.json')
    const before = readOrNull(file)
    const description = lang === 'zh' ? target.description : target.descriptionEn
    files.push({ path: file, before, after: buildLocaleFile(before, target.title, description) })
  }

  const map = manifest.exports
  let manifestEntry = null
  if (map !== undefined && map !== null) {
    if (typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('这个包的 exports 不是对象映射，无法在不破坏语义的前提下放行 locale：' + target.package)
    }
    if (!Object.prototype.hasOwnProperty.call(map, EXPORT_KEY)) {
      const next = JSON.parse(manifestText)
      next.exports[EXPORT_KEY] = EXPORT_TARGET
      const after = JSON.stringify(next, null, 2) + '\n'
      const reparsed = JSON.parse(after)
      for (const key of Object.keys(map)) {
        if (reparsed.exports[key] === undefined) {
          throw new Error('放行 locale 会让原有导出丢失，已中止：' + target.package)
        }
      }
      manifestEntry = { path: manifestPath, before: manifestText, after }
    }
  }

  return { package: target.package, dir: target.dir, files, manifestEntry }
}

/** Write prepared plans and record one backup manifest. */
export function commitPlans(profileDir, plans) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    profileDir,
    items: plans.map((plan) => ({
      package: plan.package,
      dir: plan.dir,
      files: [
        ...plan.files.map((file) => ({ path: file.path, before: file.before })),
        ...(plan.manifestEntry ? [{ path: plan.manifestEntry.path, before: plan.manifestEntry.before }] : []),
      ],
    })),
  }

  const applied = []
  const written = []
  try {
    for (const plan of plans) {
      for (const file of plan.files) {
        writeNewFile(file.path, file.after)
        written.push(file.path)
      }
      if (plan.manifestEntry) {
        replaceFile(plan.manifestEntry.path, plan.manifestEntry.after)
        written.push(plan.manifestEntry.path)
      }
      applied.push({
        package: plan.package,
        dir: plan.dir,
        localeFiles: plan.files.map((file) => file.path),
        exportsPatched: Boolean(plan.manifestEntry),
      })
    }
  } catch (error) {
    for (const file of manifest.items.flatMap((item) => item.files)) {
      try {
        if (file.before === null) fs.rmSync(file.path, { force: true })
        else replaceFile(file.path, file.before)
      } catch {
        // best effort rollback
      }
    }
    throw error
  }

  const dir = path.join(backupRoot(profileDir), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { backupId: id, applied }
}

/** Backup summaries, newest first. */
export function listBackups(profileDir) {
  let entries = []
  try {
    entries = fs.readdirSync(backupRoot(profileDir), { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot(profileDir), entry.name, 'manifest.json'), 'utf8'))
      out.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        revertedAt: manifest.revertedAt ?? null,
        packages: manifest.items.map((item) => item.package),
      })
    } catch {
      // ignore broken manifests
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/** Restore one backup. */
export function revertBackup(profileDir, id) {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) throw new Error('备份 id 不合法：' + id)
  const dir = path.join(backupRoot(profileDir), id)
  const file = path.join(dir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('找不到这个备份：' + id)
  }

  const restored = []
  for (const item of manifest.items) {
    for (const entry of item.files) {
      if (entry.before === null) fs.rmSync(entry.path, { force: true })
      else replaceFile(entry.path, entry.before)
    }
    restored.push(item.package)
  }
  manifest.revertedAt = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { backupId: id, restored }
}
