// One implementation of every sticker operation, shared by the agent tools and
// the Settings page API. Neither caller keeps its own copy of the rules.

import {
  commitPlans,
  listBackups,
  planSticker,
  revertBackup,
  validateDescription,
  validateTitle,
} from './sticker.js'
import { scanBundles, SELF_PACKAGE } from './scan.js'

export { SELF_PACKAGE }

/**
 * @param options.profileDir - resolves the running profile directory.
 * @param options.installDir - DSH installation directory; its packages are read-only.
 */
export function createOps({ profileDir, installDir }) {
  function requireProfile() {
    const dir = profileDir()
    if (!dir) {
      throw new Error('找不到 profile 目录。请确认 Harness 是用 profile 启动的，或在插件配置里写 profileDir。')
    }
    return dir
  }

  function scan(dir) {
    return scanBundles(dir, { selfName: SELF_PACKAGE, installDir })
  }

  /**
   * Current inventory.
   * @param options.readmeLimit - 0 omits README excerpts (the page does not need them).
   */
  function list({ readmeLimit = 0 } = {}) {
    const dir = requireProfile()
    const bundles = scan(dir).map((row) => ({
      ...row,
      readmeExcerpt: readmeLimit > 0 && row.readmeExcerpt ? row.readmeExcerpt.slice(0, readmeLimit) : null,
    }))
    return {
      ok: true,
      profileDir: dir,
      counts: {
        total: bundles.length,
        pending: bundles.filter((row) => row.canApply && !row.hasSticker).length,
        skipped: bundles.filter((row) => !row.canApply).length,
      },
      bundles,
    }
  }

  /**
   * Write one sticker per item.
   * @param items - [{ package, title, description? }]
   */
  function apply(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, error: 'items 不能为空。' }
    }
    const dir = requireProfile()
    const byName = new Map(scan(dir).map((row) => [row.package, row]))
    const plans = []
    const rejected = []

    for (const item of items) {
      const packageName = typeof item?.package === 'string' ? item.package.trim() : ''
      const row = byName.get(packageName)
      if (!row) {
        rejected.push({ package: packageName || '(空)', reason: '不在这个 profile 的已装 bundle 里' })
        continue
      }
      if (!row.canApply) {
        rejected.push({ package: row.package, reason: '这个包不能改（' + row.skipReason + '）' })
        continue
      }
      const titleError = validateTitle(item.title)
      if (titleError) {
        rejected.push({ package: row.package, reason: titleError })
        continue
      }
      const descriptionError = validateDescription(item.description)
      if (descriptionError) {
        rejected.push({ package: row.package, reason: descriptionError })
        continue
      }
      try {
        plans.push(
          planSticker({
            package: row.package,
            dir: row.dir,
            title: item.title.trim(),
            description: item.description,
          }),
        )
      } catch (error) {
        rejected.push({ package: row.package, reason: error instanceof Error ? error.message : String(error) })
      }
    }

    if (plans.length === 0) return { ok: false, rejected }
    try {
      const { backupId, applied } = commitPlans(dir, plans)
      return { ok: true, profileDir: dir, backupId, applied, rejected }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rejected,
      }
    }
  }

  function backups() {
    return { ok: true, backups: listBackups(requireProfile()) }
  }

  function revert(id, { force = false } = {}) {
    const dir = requireProfile()
    if (!id) return { ok: true, backups: listBackups(dir) }
    try {
      return { ok: true, reverted: true, ...revertBackup(dir, id, { force, installDir }) }
    } catch (error) {
      return {
        ok: false,
        backupId: id,
        error: error instanceof Error ? error.message : String(error),
        conflicts: error && Array.isArray(error.conflicts) ? error.conflicts : [],
      }
    }
  }

  return { list, apply, backups, revert }
}
