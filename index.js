// dsh-plugin-sticker · Host 插件
//
// 给已装的 DSH 插件贴一张"工牌"：把中文显示名写进包里的 locale 元数据。
// 插件本身不猜名字——它只做三件事：扫描、按模型给的名字写入、按备份还原。
//
// 安全约定：
//   1) 只碰 profile 里已安装的包；DSH 安装目录里的包一律只读。
//   2) package.json 只做"加一行 exports"的加法，且写前校验、写后回读。
//   3) 写文件一律走新 inode（rename 覆盖），避免污染 pnpm 的全局仓库。
//   4) 每次写入前先把原文件完整备份到 <profile>/.plugin-sticker/backups/。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProfileDir } from './lib/profile.js'
import { scanBundles } from './lib/scan.js'
import {
  commitPlans,
  listBackups,
  planSticker,
  revertBackup,
  validateDescription,
  validateTitle,
} from './lib/sticker.js'

export const name = 'plugin-sticker'
export const inject = ['tools']

const SELF_PACKAGE = 'dsh-plugin-sticker'
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const README_LIMIT = 600

function textBlocks(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function failure(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Resolve the running profile, preferring explicit configuration. */
function locate(options) {
  return resolveProfileDir({ configured: options.profileDir, selfPackage: SELF_PACKAGE, selfDir: SELF_DIR })
}

function describeScan(value) {
  if (!value.ok) return '扫描失败：' + value.error
  const lines = [
    'profile：' + value.profileDir,
    '共 ' + value.counts.total + ' 个已装 bundle；待贴 ' + value.counts.pending + ' 个；跳过 ' + value.counts.skipped + ' 个。',
    '',
  ]
  for (const row of value.bundles) {
    const flags = [row.hasSticker ? '已贴「' + row.title + '」' : '未贴', row.installKind]
    if (!row.selected) flags.push('未启用')
    if (row.skipReason) flags.push('跳过：' + row.skipReason)
    lines.push('- `' + row.package + '` v' + row.version + ' · ' + flags.join(' · '))
    if (row.description) lines.push('  描述：' + row.description)
    if (!row.hasSticker && row.readmeExcerpt) {
      lines.push('  ' + (row.readmeFile || 'README') + '：' + row.readmeExcerpt.replace(/\s+/g, ' ').trim())
    }
  }
  return lines.join('\n')
}

function describeApply(value) {
  if (!value.ok) {
    const lines = ['没有写入任何文件。']
    if (value.error) lines.push(value.error)
    for (const item of value.rejected ?? []) lines.push('- 拒绝 `' + item.package + '`：' + item.reason)
    return lines.join('\n')
  }
  const lines = ['已写入，备份 id：' + value.backupId, '']
  for (const item of value.applied) {
    lines.push('- `' + item.package + '` → 已贴工牌（' + (item.exportsPatched ? '并放行 locale 导出' : '无需改 exports') + '）')
    for (const file of item.localeFiles) lines.push('  ' + file)
  }
  for (const item of value.rejected ?? []) lines.push('- 跳过 `' + item.package + '`：' + item.reason)
  lines.push('', '刷新「插件」页可见新名字；显示不出来就重启一次 Harness。')
  return lines.join('\n')
}

function describeBackups(value) {
  if (!value.ok) return '操作失败：' + value.error
  if (value.reverted) {
    return '已还原备份 ' + value.backupId + '：' + value.restored.join('、')
  }
  if (!value.backups?.length) return '还没有任何备份。'
  return [
    '可用备份（越新越前）：',
    ...value.backups.map((backup) =>
      '- ' + backup.id + ' · ' + backup.createdAt + (backup.revertedAt ? ' · 已还原' : '') + ' · ' + backup.packages.join('、'),
    ),
  ].join('\n')
}

function scanTool(options) {
  return {
    name: 'sticker_scan',
    description:
      '列出当前 profile 里已安装的所有 DSH 插件包（bundle），以及它们有没有中文工牌；附包名、版本、描述与 README 摘录，供你判断用途。改名前先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textBlocks(describeScan(value)) },
    async execute() {
      const profileDir = locate(options)
      if (!profileDir) {
        return {
          ok: false,
          error: '找不到 profile 目录。请确认 Harness 是用 profile 启动的，或在插件配置里写 profileDir。',
        }
      }
      const rows = scanBundles(profileDir, { selfName: SELF_PACKAGE, installDir: process.env.DSH_INSTALL_DIR })
      const bundles = rows.map((row) => ({
        ...row,
        readmeExcerpt: row.readmeExcerpt ? row.readmeExcerpt.slice(0, README_LIMIT) : null,
      }))
      return {
        ok: true,
        profileDir,
        counts: {
          total: bundles.length,
          pending: bundles.filter((row) => row.canApply && !row.hasSticker).length,
          skipped: bundles.filter((row) => !row.canApply).length,
        },
        bundles,
      }
    },
  }
}

function applyTool(options) {
  return {
    name: 'sticker_apply',
    description:
      '给指定的插件包贴上中文显示名（写入 locale/zh.json 与 locale/en.json，必要时在 package.json 的 exports 里放行 locale）。写入前会完整备份；用 sticker_revert 可一键还原。只传你确认过的包名与名字。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要贴的插件列表，每项一个包。',
          items: {
            type: 'object',
            properties: {
              package: { type: 'string', description: 'sticker_scan 返回的包名，例如 dsh-bili-scroll' },
              title: { type: 'string', description: '中文显示名，建议 2-12 字，不要带引号或换行' },
              description: { type: 'string', description: '可选：中文一句话说明，会写进 locale/zh.json' },
            },
            required: ['package', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textBlocks(describeApply(value)) },
    async execute(args) {
      const items = args?.items
      if (!Array.isArray(items) || items.length === 0) {
        return { ok: false, error: 'items 不能为空。' }
      }
      const profileDir = locate(options)
      if (!profileDir) {
        return { ok: false, error: '找不到 profile 目录。' }
      }

      const rows = scanBundles(profileDir, { selfName: SELF_PACKAGE, installDir: process.env.DSH_INSTALL_DIR })
      const byName = new Map(rows.map((row) => [row.package, row]))
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

      if (plans.length === 0) {
        return { ok: false, rejected }
      }
      try {
        const { backupId, applied } = commitPlans(profileDir, plans)
        return { ok: true, profileDir, backupId, applied, rejected }
      } catch (error) {
        return { ...failure(error), rejected }
      }
    },
  }
}

function revertTool(options) {
  return {
    name: 'sticker_revert',
    description:
      '列出或还原由 sticker_apply 产生的备份。不传 backup 时只列出可用备份；传 backup 时把当时改过的文件恢复原样。',
    parameters: {
      type: 'object',
      properties: {
        backup: { type: 'string', description: '要还原的备份 id；省略则只列出备份' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(describeBackups(value)),
    },
    async execute(args) {
      const profileDir = locate(options)
      if (!profileDir) {
        return { ok: false, error: '找不到 profile 目录。' }
      }
      try {
        if (!args?.backup) {
          return { ok: true, backups: listBackups(profileDir) }
        }
        const result = revertBackup(profileDir, args.backup)
        return { ok: true, reverted: true, ...result }
      } catch (error) {
        return failure(error)
      }
    },
  }
}

export function apply(ctx, config = {}) {
  const options = { profileDir: typeof config?.profileDir === 'string' ? config.profileDir : undefined }
  ctx.effect(() => ctx.tools.register(scanTool(options)))
  ctx.effect(() => ctx.tools.register(applyTool(options)))
  ctx.effect(() => ctx.tools.register(revertTool(options)))
}
