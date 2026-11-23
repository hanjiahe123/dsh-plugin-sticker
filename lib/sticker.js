import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { scanBundles, SELF_PACKAGE } from './scan.js'

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

  return {
    package: target.package,
    dir: target.dir,
    title: target.title,
    description: target.description,
    files,
    manifestEntry,
  }
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
        ...plan.files.map((file) => ({ path: file.path, before: file.before, after: file.after })),
        ...(plan.manifestEntry
          ? [{ path: plan.manifestEntry.path, before: plan.manifestEntry.before, after: plan.manifestEntry.after }]
          : []),
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

/**
 * The only paths a revert may touch: the exact files apply writes, inside bundles
 * that exist in this profile right now. Rebuilt from the live profile, never from
 * the manifest, so a tampered manifest cannot point a restore at another file.
 */
function allowedTargets(profileDir, installDir) {
  const paths = new Set()
  const dirs = new Set()
  for (const row of scanBundles(profileDir, { selfName: SELF_PACKAGE, installDir })) {
    // Packages shipped with the installation live inside the app archive and are
    // never sticker targets, so a manifest must not reach into them either.
    if (row.installKind === 'installation' || row.skipReason === 'installation') continue
    let dir
    try {
      dir = fs.realpathSync(row.dir)
    } catch {
      continue
    }
    dirs.add(dir)
    paths.add(path.join(dir, 'package.json'))
    paths.add(path.join(dir, 'locale', 'zh.json'))
    paths.add(path.join(dir, 'locale', 'en.json'))
  }
  return { paths, dirs }
}

/**
 * Resolve a path to its real location, following symlinks when it exists and
 * resolving the parent directory when it does not. Null when neither is possible.
 */
function realPathOf(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    // fall through: the file may legitimately not exist yet
  }
  try {
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file))
  } catch {
    return null
  }
}

/** Reject a malformed manifest before its paths are used for anything. */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('备份文件结构不对')
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) throw new Error('备份文件没有条目')
  for (const item of manifest.items) {
    if (!item || typeof item !== 'object') throw new Error('备份条目结构不对')
    if (typeof item.package !== 'string') throw new Error('备份条目缺少包名')
    if (!Array.isArray(item.files)) throw new Error('备份条目缺少文件列表')
    for (const entry of item.files) {
      if (!entry || typeof entry !== 'object') throw new Error('备份里的文件项结构不对')
      if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) {
        throw new Error('备份里有非法路径：' + String(entry.path))
      }
      if (entry.before !== null && typeof entry.before !== 'string') {
        throw new Error('备份内容类型不对：' + entry.path)
      }
      if (entry.after !== undefined && entry.after !== null && typeof entry.after !== 'string') {
        throw new Error('备份记录的类型不对：' + entry.path)
      }
    }
  }
}

/**
 * Restore one backup.
 *
 * Refuses: a malformed manifest, a path outside the allowed targets, a backup that
 * was already reverted, and — unless forced — a restore that would overwrite files
 * changed since that backup was taken.
 */
export function revertBackup(profileDir, id, { force = false, installDir } = {}) {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) throw new Error('备份 id 不合法：' + id)
  const file = path.join(backupRoot(profileDir), id, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('找不到这个备份：' + id)
  }
  validateManifest(manifest)
  if (manifest.revertedAt) {
    throw new Error('这个备份已在 ' + manifest.revertedAt + ' 还原过，不会重复执行')
  }

  const { paths: allowedPaths } = allowedTargets(profileDir, installDir ?? process.env.DSH_INSTALL_DIR)
  const plan = []
  const conflicts = []
  const restored = []
  for (const item of manifest.items) {
    // A package directory that no longer exists cannot be restored: recreating
    // files inside a deleted package would leave debris nothing tracks.
    if (typeof item.dir === 'string' && !fs.existsSync(item.dir)) {
      const error = new Error('这个插件已经不在 profile 里（可能被卸载了），无法还原：' + item.package)
      error.backupId = id
      throw error
    }
    for (const entry of item.files) {
      const real = realPathOf(entry.path)
      if (!real || !allowedPaths.has(real)) {
        let message
        if (!real) {
          message = '备份里的路径无法解析，已拒绝还原：' + entry.path
        } else if (typeof item.dir === 'string' && path.relative(item.dir, real) !== '' &&
          !path.relative(item.dir, real).startsWith('..')) {
          message = '备份里的文件不在允许范围（只允许 package.json 与 locale 两种文件），已拒绝：' + entry.path
        } else {
          message = '备份里的路径越出了插件目录，已拒绝：' + entry.path
        }
        const error = new Error(message)
        error.backupId = id
        throw error
      }
      plan.push({ ...entry, real })
      if (typeof entry.after === 'string') {
        const current = readOrNull(real)
        if (current !== entry.after) {
          conflicts.push({ path: real, state: current === null ? 'missing' : 'changed' })
        }
      }
    }
    restored.push(item.package)
  }

  if (conflicts.length > 0 && !force) {
    const error = new Error(
      '这次还原会覆盖之后的改动（' + conflicts.length + ' 个文件），已中止。' +
      '先还原更晚的那次备份；确认要覆盖就带 force 再来一次。',
    )
    error.backupId = id
    error.conflicts = conflicts
    throw error
  }

  for (const entry of plan) {
    if (entry.before === null) fs.rmSync(entry.real, { force: true })
    else replaceFile(entry.real, entry.before)
  }

  for (const entry of plan) {
    if (readOrNull(entry.real) !== entry.before) {
      const error = new Error('还原后回读不一致：' + entry.real)
      error.backupId = id
      throw error
    }
  }

  manifest.revertedAt = new Date().toISOString()
  if (conflicts.length > 0) manifest.forcedAt = manifest.revertedAt
  durableWrite(file, JSON.stringify(manifest, null, 2) + '\n')
  return { backupId: id, restored, forced: conflicts.length > 0 }
}
