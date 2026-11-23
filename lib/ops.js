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
import { scanBundles, stickerOf, SELF_PACKAGE } from './scan.js'
import { forgetSticker, loadRegistry, recordSticker } from './registry.js'

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
    let backupId
    let applied
    try {
      const committed = commitPlans(dir, plans)
      backupId = committed.backupId
      applied = committed.applied
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rejected,
      }
    }

    // Remember the choice so a future package update can be repaired. A failure
    // here must not fail the write that already succeeded.
    const warnings = []
    for (const plan of plans) {
      try {
        recordSticker(dir, plan.package, {
          title: plan.title,
          description: plan.description,
          version: byName.get(plan.package)?.version ?? null,
        })
      } catch (error) {
        warnings.push('写好了 locale，但记录名字失败：' + plan.package + '（' + (error instanceof Error ? error.message : String(error)) + '）')
      }
    }

    return { ok: true, profileDir: dir, backupId, applied, rejected, ...(warnings.length ? { warnings } : {}) }
  }

  function backups() {
    return { ok: true, backups: listBackups(requireProfile()) }
  }

  /**
   * After a revert, the registry must describe what is on disk now.
   * Otherwise the next check reports a phantom "changed" or "lost" sticker and
   * offers to restore a name the user just removed.
   */
  function syncRegistry(dir, restored) {
    const byName = new Map(scan(dir).map((row) => [row.package, row]))
    for (const packageName of restored) {
      const row = byName.get(packageName)
      if (!row) continue
      const current = stickerOf(row.dir)
      try {
        if (!current || !current.title) forgetSticker(dir, packageName)
        else {
          recordSticker(dir, packageName, {
            title: current.title,
            description: current.description,
            version: row.version,
          })
        }
      } catch {
        // a registry write failure must not fail the revert that already happened
      }
    }
  }

  function revert(id, { force = false } = {}) {
    const dir = requireProfile()
    if (!id) return { ok: true, backups: listBackups(dir) }
    try {
      const result = revertBackup(dir, id, { force, installDir })
      syncRegistry(dir, result.restored ?? [])
      return { ok: true, reverted: true, ...result }
    } catch (error) {
      return {
        ok: false,
        backupId: id,
        error: error instanceof Error ? error.message : String(error),
        conflicts: error && Array.isArray(error.conflicts) ? error.conflicts : [],
      }
    }
  }

  /**
   * Compare what was recorded with what each package currently shows.
   * Read-only: nothing is written here.
   */
  function stickerState() {
    const dir = requireProfile()
    const registry = loadRegistry(dir)
    const rows = scan(dir)
    const byName = new Map(rows.map((row) => [row.package, row]))
    const entries = []

    for (const [packageName, record] of Object.entries(registry.stickers)) {
      const row = byName.get(packageName)
      if (!row) {
        entries.push({ package: packageName, status: 'removed', recorded: record })
        continue
      }
      if (!row.canApply) {
        entries.push({ package: packageName, status: 'unavailable', recorded: record, reason: row.skipReason })
        continue
      }
      const current = row.title
      const status = !current ? 'lost' : current === record.title ? 'ok' : 'changed'
      entries.push({
        package: packageName,
        status,
        recorded: record,
        currentTitle: current ?? null,
        version: row.version,
        versionChanged: record.recordedVersion !== row.version,
      })
    }

    const recorded = new Set(Object.keys(registry.stickers))
    return {
      ok: true,
      profileDir: dir,
      problem: registry.problem ?? null,
      unrecorded: rows
        .filter((row) => row.hasSticker && !recorded.has(row.package))
        .map((row) => ({ package: row.package, title: row.title })),
      summary: {
        ok: entries.filter((entry) => entry.status === 'ok').length,
        lost: entries.filter((entry) => entry.status === 'lost').length,
        changed: entries.filter((entry) => entry.status === 'changed').length,
        unavailable: entries.filter((entry) => entry.status === 'unavailable').length,
        removed: entries.filter((entry) => entry.status === 'removed').length,
      },
      entries,
    }
  }

  /**
   * Restore stickers whose package lost them.
   * @param options.fix - false reports only.
   * @param options.overwrite - also take back names something else changed.
   */
  function reconcile({ fix = false, overwrite = false } = {}) {
    const state = stickerState()
    const targets = state.entries.filter((entry) =>
      entry.status === 'lost' || (overwrite && entry.status === 'changed'),
    )
    if (!fix) {
      return { ...state, fixed: 0, adopted: 0, applied: [], rejected: [] }
    }

    // Adopt stickers written before this feature existed: record the name that is
    // already on the package. No package file is touched by an adoption.
    let adopted = 0
    const adoptErrors = []
    const dir = requireProfile()
    const adoptRows = state.unrecorded.length > 0 ? new Map(scan(dir).map((row) => [row.package, row])) : null
    for (const item of adoptRows ? state.unrecorded : []) {
      try {
        const row = adoptRows.get(item.package)
        const current = row ? stickerOf(row.dir) : null
        recordSticker(dir, item.package, {
          title: item.title,
          description: current?.description ?? undefined,
          version: row?.version ?? null,
        })
        adopted += 1
      } catch (error) {
        adoptErrors.push('纳入记录失败：' + item.package + '（' + (error instanceof Error ? error.message : String(error)) + '）')
      }
    }

    if (targets.length === 0) {
      return { ...stickerState(), fixed: 0, adopted, applied: [], rejected: adoptErrors.map((reason) => ({ package: '(纳入)', reason })) }
    }

    const items = targets.map((entry) => ({
      package: entry.package,
      title: entry.recorded.title,
      ...(typeof entry.recorded.description === 'string' ? { description: entry.recorded.description } : {}),
    }))
    const result = apply(items)
    const after = stickerState()
    return {
      ...after,
      fixed: result.ok ? result.applied.length : 0,
      adopted,
      applied: result.ok ? result.applied : [],
      rejected: result.rejected ?? (result.error ? [{ package: '(批量)', reason: result.error }] : []),
    }
  }

  return { list, apply, backups, revert, stickerState, reconcile }
}
