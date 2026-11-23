// dsh-plugin-sticker · Host 插件
//
// 给已装的 DSH 插件贴一张"工牌"：把中文显示名写进包里的 locale 元数据。
// 插件本身不猜名字——它只做三件事：扫描、按调用方给的名字写入、按备份还原。
//
// 两个入口共用 lib/ops.js 里的同一份实现：
//   · 工具  sticker_scan / sticker_apply / sticker_revert（给 agent 用）
//   · 路由  /api/plugin-sticker/*（给「设置 → 插件工牌」那一页用）
//
// 安全约定：
//   1) 只碰 profile 里已安装的包；DSH 安装目录里的包一律只读。
//   2) package.json 只做"加一行 exports"的加法，且写前校验、写后回读。
//   3) 写文件一律走新 inode（rename 覆盖），避免污染 pnpm 的全局仓库。
//   4) 每次写入前先把原文件完整备份到 <profile>/.plugin-sticker/backups/。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProfileDir } from './lib/profile.js'
import { createOps } from './lib/ops.js'

export const name = 'plugin-sticker'
export const inject = ['tools']

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))

function textBlocks(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
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
  if (!value.ok) {
    const lines = ['操作失败：' + value.error]
    for (const conflict of value.conflicts ?? []) {
      lines.push('- ' + (conflict.state === 'missing' ? '已被删除' : '已被改动') + '：' + conflict.path)
    }
    return lines.join('\n')
  }
  if (value.reverted) {
    return '已还原备份 ' + value.backupId + '：' + value.restored.join('、') + (value.forced ? '（覆盖了之后的改动）' : '')
  }
  if (!value.backups?.length) return '还没有任何备份。'
  return [
    '可用备份（越新越前）：',
    ...value.backups.map((backup) =>
      '- ' + backup.id + ' · ' + backup.createdAt + (backup.revertedAt ? ' · 已还原' : '') + ' · ' + backup.packages.join('、'),
    ),
  ].join('\n')
}

function scanTool(ops) {
  return {
    name: 'sticker_scan',
    description:
      '列出当前 profile 里已安装的所有 DSH 插件包（bundle），以及它们有没有中文工牌；附包名、版本、描述与 README 摘录，供你判断用途。改名前先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textBlocks(describeScan(value)) },
    async execute() {
      try {
        return ops.list({ readmeLimit: 600 })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function applyTool(ops) {
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
      return ops.apply(args?.items)
    },
  }
}

function revertTool(ops) {
  return {
    name: 'sticker_revert',
    description:
      '列出或还原由 sticker_apply 产生的备份。不传 backup 时只列出可用备份；传 backup 时把当时改过的文件恢复原样。',
    parameters: {
      type: 'object',
      properties: {
        backup: { type: 'string', description: '要还原的备份 id；省略则只列出备份' },
        force: { type: 'boolean', description: '备份之后这些文件又改过时，仍然覆盖（默认 false，会中止并列出冲突）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(describeBackups(value)),
    },
    async execute(args) {
      return ops.revert(args?.backup, { force: args?.force === true })
    },
  }
}

function describeReconcile(value) {
  if (!value.ok) return '检查失败：' + value.error
  const { summary } = value
  const lines = [
    '记录 ' + value.entries.length + ' 条：正常 ' + summary.ok + '、丢失 ' + summary.lost +
      '、被改写 ' + summary.changed + '、不可用 ' + summary.unavailable + '、已卸载 ' + summary.removed,
  ]
  if (value.problem) lines.push('注意：' + value.problem)
  if (value.unrecorded?.length) {
    lines.push('另有 ' + value.unrecorded.length + ' 个工牌还没被记录（fix: true 可纳入管理，不写包）：' +
      value.unrecorded.map((item) => item.package).join('、'))
  }
  for (const entry of value.entries) {
    const name = entry.recorded?.title ?? '(无记录)'
    if (entry.status === 'ok') {
      lines.push('- `' + entry.package + '` · 正常 · ' + name)
    } else if (entry.status === 'lost') {
      lines.push('- `' + entry.package + '` · 丢失（包里已无名字，记为「' + name + '」）')
    } else if (entry.status === 'changed') {
      lines.push('- `' + entry.package + '` · 被改写 · 当前「' + (entry.currentTitle ?? '') + '」/ 记录「' + name + '」')
    } else if (entry.status === 'unavailable') {
      lines.push('- `' + entry.package + '` · 不可用（' + entry.reason + '）')
    } else {
      lines.push('- `' + entry.package + '` · 已卸载（记录保留，重装后可恢复）')
    }
  }
  if (value.fixed || value.adopted) {
    lines.push('', '已恢复 ' + (value.fixed || 0) + ' 个，纳入记录 ' + (value.adopted || 0) + ' 个。')
  } else if (summary.lost + summary.changed > 0) {
    lines.push('', '用 fix: true 恢复丢失的；连被改写的一起覆盖再加 overwrite: true。')
  }
  return lines.join('\n')
}

function reconcileTool(ops) {
  return {
    name: 'sticker_reconcile',
    description:
      '检查已记录的工牌是否还在：插件更新后包里的名字可能被冲掉。只读检查，传 fix 才写回。丢失的默认恢复；被别的来源改写的要 overwrite 才覆盖。',
    parameters: {
      type: 'object',
      properties: {
        fix: { type: 'boolean', description: 'true 时把丢失的工牌写回去' },
        overwrite: { type: 'boolean', description: '配合 fix：连"当前名字与记录不同"的也覆盖（默认不动）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(describeReconcile(value)),
    },
    async execute(args) {
      try {
        return ops.reconcile({ fix: args?.fix === true, overwrite: args?.overwrite === true })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      data += chunk
      if (data.length > limit) {
        done = true
        resolve(null)
      }
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolve(null)
    })
  })
}

/** The Settings page talks to the same operations the tools use. */
function registerRoutes(ctx, ops) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') return

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/plugin-sticker',
    handler: async (req, res) => {
      let url
      try {
        url = new URL(req.url, 'http://127.0.0.1')
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad url' })
      }
      const pathname = url.pathname
      // Writing is gated on a custom header: a cross-origin page cannot set it
      // without a CORS preflight, which this route never answers.
      const trusted = req.headers['x-sticker-client'] === '1'
      try {
        if (req.method === 'GET' && pathname === '/api/plugin-sticker/list') {
          return sendJson(res, 200, ops.list())
        }
        if (req.method === 'GET' && pathname === '/api/plugin-sticker/backups') {
          return sendJson(res, 200, ops.backups())
        }
        if (req.method === 'GET' && pathname === '/api/plugin-sticker/reconcile') {
          return sendJson(res, 200, ops.stickerState())
        }
        if (req.method === 'POST' && pathname === '/api/plugin-sticker/reconcile') {
          if (!trusted) return sendJson(res, 403, { ok: false, error: '缺少客户端标记，拒绝写入' })
          const body = await readBody(req)
          if (!body) return sendJson(res, 200, { ok: false, error: '请求体不是合法 JSON' })
          return sendJson(res, 200, ops.reconcile({ fix: body.fix === true, overwrite: body.overwrite === true }))
        }
        if (req.method === 'POST' && pathname === '/api/plugin-sticker/apply') {
          if (!trusted) return sendJson(res, 403, { ok: false, error: '缺少客户端标记，拒绝写入' })
          const body = await readBody(req)
          if (!body) return sendJson(res, 200, { ok: false, error: '请求体不是合法 JSON' })
          return sendJson(res, 200, ops.apply(body.items))
        }
        if (req.method === 'POST' && pathname === '/api/plugin-sticker/revert') {
          if (!trusted) return sendJson(res, 403, { ok: false, error: '缺少客户端标记，拒绝写入' })
          const body = await readBody(req)
          if (!body) return sendJson(res, 200, { ok: false, error: '请求体不是合法 JSON' })
          return sendJson(res, 200, ops.revert(body.backup, { force: body.force === true }))
        }
        return sendJson(res, 404, { ok: false, error: '未知路由：' + pathname })
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}

export function apply(ctx, config = {}) {
  const configured = typeof config?.profileDir === 'string' ? config.profileDir : undefined
  const ops = createOps({
    profileDir: () => resolveProfileDir({ configured, selfPackage: 'dsh-plugin-sticker', selfDir: SELF_DIR }),
    installDir: process.env.DSH_INSTALL_DIR,
  })

  ctx.effect(() => ctx.tools.register(scanTool(ops)))
  ctx.effect(() => ctx.tools.register(applyTool(ops)))
  ctx.effect(() => ctx.tools.register(revertTool(ops)))
  ctx.effect(() => ctx.tools.register(reconcileTool(ops)))
  registerRoutes(ctx, ops)

  // Startup check: report only. Restoring without being asked would edit other
  // packages the moment the user launches DSH.
  try {
    const state = ops.stickerState()
    const pending = state.summary.lost + state.summary.changed
    if (pending > 0) {
      console.log(
        '[plugin-sticker] 工牌缺失 ' + state.summary.lost + ' 个、被改写 ' + state.summary.changed +
        ' 个；在 设置 → 插件工牌 里可一键恢复。',
      )
    }
  } catch {
    // profile not resolvable in this host; the tools report that themselves
  }
}
