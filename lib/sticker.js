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
 * Write a file to a durable state: create parents, write, fsync, close.
 * Used for the backup manifest, which must survive a crash before any edit.
 */
function durableWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'w')
  try {
    fs.writeSync(fd, content, null, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Replace a file through a fresh inode.
 *
 * pnpm hard-links package files from one shared store, so writing in place would
 * change every copy in that store — including other projects. Writing a temp file
 * and renaming it over the target unlinks this copy instead, and works whether or
 * not the target already existed.
 */
function replaceFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.sticker-tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex')
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
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

/**
 * Merge `meta.title`/`meta.description` into a locale file's text.
 *
 * A missing file is created. An existing file that does not parse is refused:
 * overwriting it would silently discard translations nobody can recover.
 */
function buildLocaleFile({ file, existingText, title, description }) {
  let base = {}
  if (existingText !== null) {
    let parsed
    try {
      parsed = JSON.parse(existingText)
    } catch {
      throw new Error('现有 locale 文件不是合法 JSON，为避免丢数据已拒绝修改：' + file)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('现有 locale 文件的顶层不是 JSON 对象，拒绝修改：' + file)
    }
    base = parsed
  }
  const meta = base.meta !== null && typeof base.meta === 'object' && !Array.isArray(base.meta)
    ? { ...base.meta }
    : {}
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
    files.push({
      path: file,
      before,
      after: buildLocaleFile({ file, existingText: before, title: target.title, description }),
    })
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

function rollbackFrom(manifest) {
  const failed = []
  for (const item of manifest.items) {
    for (const entry of item.files) {
      try {
        if (entry.before === null) fs.rmSync(entry.path, { force: true })
        else replaceFile(entry.path, entry.before)
      } catch {
        failed.push(entry.path)
      }
    }
  }
  return failed
}

/**
 * Apply prepared plans: back up durably, verify the backup, write every file
 * through a fresh inode, read each one back, and roll back on any mismatch.
 */
export function commitPlans(profileDir, plans) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')
  const dir = path.join(backupRoot(profileDir), id)
  const manifestPath = path.join(dir, 'manifest.json')
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

  // 1) Backup first, durably, before touching anything.
  durableWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  // 2) Verify the backup: it must read back and match what is on disk right now.
  let verified
  try {
    verified = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('备份写入后读不回来，已中止，未修改任何文件：' + manifestPath)
  }
  if (!Array.isArray(verified.items) || verified.items.length !== manifest.items.length) {
    throw new Error('备份内容不完整，已中止，未修改任何文件：' + manifestPath)
  }
  for (const item of verified.items) {
    for (const entry of item.files) {
      if (readOrNull(entry.path) !== entry.before) {
        throw new Error('备份与磁盘上的文件不一致（可能刚被别的程序改过），已中止：' + entry.path)
      }
    }
  }

  // 3) Write, then read back.
  const written = []
  try {
    for (const plan of plans) {
      for (const file of plan.files) {
        replaceFile(file.path, file.after)
        written.push({ path: file.path, expected: file.after })
      }
      if (plan.manifestEntry) {
        replaceFile(plan.manifestEntry.path, plan.manifestEntry.after)
        written.push({ path: plan.manifestEntry.path, expected: plan.manifestEntry.after })
      }
    }
    for (const file of written) {
      if (readOrNull(file.path) !== file.expected) {
        throw new Error('写入后回读不一致，正在回滚：' + file.path)
      }
    }
  } catch (error) {
    const stuck = rollbackFrom(manifest)
    const note = stuck.length === 0
      ? '已按备份回滚。'
      : '回滚未能恢复这些文件，请用备份手动处理：' + stuck.join('、')
    throw new Error((error instanceof Error ? error.message : String(error)) + ' ' + note + ' 备份：' + manifestPath)
  }

  return {
    backupId: id,
    applied: plans.map((plan) => ({
      package: plan.package,
      dir: plan.dir,
      localeFiles: plan.files.map((file) => file.path),
      exportsPatched: Boolean(plan.manifestEntry),
    })),
  }
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
  durableWrite(file, JSON.stringify(manifest, null, 2) + '\n')
  return { backupId: id, restored }
}
