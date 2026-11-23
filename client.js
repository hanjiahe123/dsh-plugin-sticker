/**
 * dsh-plugin-sticker —— 浏览器半端（「设置」里的一页）
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject, apply }),
 *     })
 *
 * 这一页自己不做任何文件操作：所有读写都打 Host 的 /api/plugin-sticker/*，
 * 和 agent 用的 sticker_* 工具走同一份实现（lib/ops.js）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-sticker',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/plugin-sticker'

    const asJson = async (res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 401 ? '（没权限）' : ''))
      return res.json()
    }
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-sticker-client': '1' },
      body: JSON.stringify(body || {}),
    }))

    const KIND = {
      link: '本地链接',
      registry: 'npm',
      git: 'GitHub',
      'local-path': '本地路径',
      installation: '自带（只读）',
      bundled: '自带（只读）',
    }

    const CSS = `
[data-ps-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:680px;}
[data-ps-lead]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ps-head]{display:flex;align-items:center;gap:10px;}
[data-ps-head] h2{margin:0;font-size:14px;font-weight:600;}
[data-ps-grow]{flex:1;min-width:0;}
[data-ps-list]{display:flex;flex-direction:column;gap:2px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;overflow:hidden;}
[data-ps-row]{display:flex;align-items:center;gap:10px;padding:9px 11px;
  border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
[data-ps-row]:first-child{border-top:0;}
[data-ps-row][data-off]{opacity:.55;}
[data-ps-meta]{display:flex;flex-direction:column;gap:3px;width:230px;min-width:0;flex:none;}
[data-ps-name]{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-ps-tags]{display:flex;gap:6px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ps-tag]{padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));}
[data-ps-input]{flex:1;min-width:0;box-sizing:border-box;padding:6px 9px;border-radius:7px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-ps-input]:focus{outline:none;border-color:var(--dsw-alias-border-accent,#3b82f6);}
[data-ps-input][disabled]{cursor:not-allowed;}
[data-ps-btn]{flex:none;padding:6px 11px;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-ps-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2));}
[data-ps-btn][disabled]{opacity:.45;cursor:default;}
[data-ps-btn][data-primary]{border-color:transparent;background:var(--dsw-alias-brand-bg,#3b82f6);color:#fff;}
[data-ps-note]{font-size:11.5px;line-height:17px;padding:7px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));}
[data-ps-note][data-bad]{color:#f87171;}
[data-ps-empty]{padding:14px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ps-sub]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ps-bak]{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:11.5px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
`

    function Panel() {
      const [loading, setLoading] = React.useState(true)
      const [bundles, setBundles] = React.useState([])
      const [backups, setBackups] = React.useState([])
      const [drafts, setDrafts] = React.useState({})
      const [busy, setBusy] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [conflict, setConflict] = React.useState(null)
      const [recon, setRecon] = React.useState(null)

      const refresh = React.useCallback(async () => {
        setLoading(true)
        try {
          const [list, backupState, stickerState] = await Promise.all([
            jget('/list'),
            jget('/backups'),
            jget('/reconcile'),
          ])
          if (!list.ok) throw new Error(list.error || '读取失败')
          setBundles(list.bundles || [])
          setBackups(backupState.ok ? backupState.backups || [] : [])
          setRecon(stickerState.ok ? stickerState : null)
          const next = {}
          for (const row of list.bundles || []) next[row.package] = row.title || ''
          setDrafts(next)
          setNote(null)
        } catch (error) {
          setNote({ bad: true, text: String(error && error.message ? error.message : error) })
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      async function save(row) {
        const title = (drafts[row.package] || '').trim()
        if (!title) {
          setNote({ bad: true, text: '名字不能为空。' })
          return
        }
        setBusy(row.package)
        try {
          const result = await jpost('/apply', { items: [{ package: row.package, title }] })
          if (!result.ok) {
            const why = (result.rejected || []).map((item) => item.reason).join('；')
            throw new Error(why || result.error || '写入失败')
          }
          setNote({ text: '已写入「' + title + '」。刷新「插件」页可见新名字。' })
          await refresh()
        } catch (error) {
          setNote({ bad: true, text: String(error && error.message ? error.message : error) })
        } finally {
          setBusy(null)
        }
      }

      async function revert(id, force = false) {
        setBusy(id)
        try {
          const result = await jpost('/revert', { backup: id, force })
          if (!result.ok) {
            if (!force && Array.isArray(result.conflicts) && result.conflicts.length > 0) {
              setConflict({ id, message: result.error })
            }
            throw new Error(result.error || '还原失败')
          }
          setConflict(null)
          setNote({ text: '已还原' + (result.forced ? '（覆盖了之后的改动）' : '') + '：' + (result.restored || []).join('、') })
          await refresh()
        } catch (error) {
          setNote({ bad: true, text: String(error && error.message ? error.message : error) })
        } finally {
          setBusy(null)
        }
      }

      async function repair(overwrite) {
        setBusy('repair')
        try {
          const result = await jpost('/reconcile', { fix: true, overwrite })
          if (!result.ok) throw new Error(result.error || '修复失败')
          setNote({ text: '已恢复 ' + (result.fixed || 0) + ' 个工牌，纳入记录 ' + (result.adopted || 0) + ' 个。刷新「插件」页可见。' })
          await refresh()
        } catch (error) {
          setNote({ bad: true, text: String(error && error.message ? error.message : error) })
        } finally {
          setBusy(null)
        }
      }

      const editable = bundles.filter((row) => row.canApply)
      const skipped = bundles.filter((row) => !row.canApply)

      return h('div', { 'data-ps-page': '' },
        h('div', { 'data-ps-head': '' },
          h('h2', { 'data-ps-grow': '' }, '插件工牌'),
          h('button', {
            'data-ps-btn': '',
            disabled: loading,
            onClick: refresh,
          }, loading ? '读取中…' : '刷新'),
        ),
        h('div', { 'data-ps-lead': '' },
          '给已装插件起个中文名。只写插件包里的 locale 文件，不改包名、不动依赖，随时可以还原。',
        ),
        recon && (recon.summary.lost + recon.summary.changed) > 0
          ? h('div', { 'data-ps-note': '' },
            h('div', {},
              '插件更新后有 ' + recon.summary.lost + ' 个工牌丢了' +
              (recon.summary.changed > 0 ? '，另有 ' + recon.summary.changed + ' 个名字被别的来源改写' : '') + '。'),
            h('div', { 'data-ps-row': '' },
              recon.summary.lost > 0
                ? h('button', {
                  'data-ps-btn': '',
                  'data-primary': '',
                  disabled: busy === 'repair',
                  onClick: () => repair(false),
                }, '恢复丢失的（' + recon.summary.lost + '）')
                : null,
              recon.summary.changed > 0
                ? h('button', {
                  'data-ps-btn': '',
                  disabled: busy === 'repair',
                  onClick: () => repair(true),
                }, '也覆盖被改写的（' + recon.summary.changed + '）')
                : null,
            ),
          )
          : null,
        recon && (recon.unrecorded?.length ?? 0) > 0
          ? h('div', { 'data-ps-note': '' },
            h('div', {},
              '还有 ' + recon.unrecorded.length + ' 个工牌没被记录。没有记录，插件更新后就没法提示你恢复。'),
            h('div', { 'data-ps-row': '' },
              h('button', {
                'data-ps-btn': '',
                disabled: busy === 'repair',
                onClick: () => repair(false),
              }, '纳入管理（' + recon.unrecorded.length + '）'),
            ),
          )
          : null,
        note ? h('div', { 'data-ps-note': '', ...(note.bad ? { 'data-bad': '' } : {}) }, note.text) : null,
        conflict ? h('div', { 'data-ps-note': '', 'data-bad': '' },
          h('div', {}, conflict.message),
          h('div', { 'data-ps-row': '' },
            h('button', {
              'data-ps-btn': '',
              onClick: () => revert(conflict.id, true),
            }, '仍要还原（会覆盖之后的改动）'),
            h('button', { 'data-ps-btn': '', onClick: () => setConflict(null) }, '取消'),
          ),
        ) : null,

        h('div', { 'data-ps-list': '' },
          editable.length === 0
            ? h('div', { 'data-ps-empty': '' }, loading ? '读取中…' : '没有可改的插件。')
            : editable.map((row) => h('div', { 'data-ps-row': '', key: row.package },
              h('div', { 'data-ps-meta': '' },
                h('div', { 'data-ps-name': '', title: row.package }, row.package),
                h('div', { 'data-ps-tags': '' },
                  h('span', { 'data-ps-tag': '' }, 'v' + row.version),
                  h('span', { 'data-ps-tag': '' }, KIND[row.installKind] || row.installKind),
                  row.hasSticker ? null : h('span', { 'data-ps-tag': '' }, '未贴'),
                  row.selected ? null : h('span', { 'data-ps-tag': '' }, '未启用'),
                ),
              ),
              h('input', {
                'data-ps-input': '',
                value: drafts[row.package] || '',
                placeholder: '显示名，例如：刷B站',
                maxLength: 40,
                disabled: busy === row.package,
                onChange: (event) => {
                  const value = event.target.value
                  setDrafts((current) => ({ ...current, [row.package]: value }))
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') save(row)
                },
              }),
              h('button', {
                'data-ps-btn': '',
                'data-primary': '',
                disabled: busy === row.package || (drafts[row.package] || '').trim() === (row.title || ''),
                onClick: () => save(row),
              }, busy === row.package ? '写入中…' : '贴上'),
            )),
        ),

        skipped.length > 0 ? h('div', {},
          h('div', { 'data-ps-sub': '' }, '改不了（' + skipped.length + '）'),
          h('div', { 'data-ps-list': '' },
            skipped.map((row) => h('div', { 'data-ps-row': '', 'data-off': '', key: row.package },
              h('div', { 'data-ps-meta': '' },
                h('div', { 'data-ps-name': '', title: row.package }, row.package),
                h('div', { 'data-ps-tags': '' },
                  h('span', { 'data-ps-tag': '' }, KIND[row.installKind] || row.installKind),
                  h('span', { 'data-ps-tag': '' }, row.skipReason === 'installation' ? '自带包只读' : row.skipReason === 'not-writable' ? '没有写权限' : 'exports 不是对象，不能加 locale'),
                ),
              ),
            )),
          ),
        ) : null,

        h('div', {},
          h('div', { 'data-ps-sub': '' }, '备份'),
          backups.length === 0
            ? h('div', { 'data-ps-bak': '' }, '还没有备份。贴上之后这里会出现可还原的记录。')
            : backups.slice(0, 8).map((backup) => h('div', { 'data-ps-bak': '', key: backup.id },
              h('span', { 'data-ps-grow': '', title: backup.id },
                new Date(backup.createdAt).toLocaleString() + ' · ' + backup.packages.join('、') +
                (backup.revertedAt ? ' · 已还原' : '')),
              h('button', {
                'data-ps-btn': '',
                disabled: Boolean(backup.revertedAt) || busy === backup.id,
                onClick: () => revert(backup.id),
              }, busy === backup.id ? '还原中…' : '还原'),
            )),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-plugin-sticker')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-plugin-sticker: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'plugin-sticker', order: 31, label: '插件工牌' },
          () => h(Panel),
        ))
      },
    }
  },
})
