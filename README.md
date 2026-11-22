# 插件工牌 · dsh-plugin-sticker

给 DSH 里已经装好的插件贴一张"工牌"——把 `dsh-bili-scroll` 这种包名，换成「刷B站」这种能看懂的名字。

插件**不猜名字**。它只提供三件事：扫描、按你（或你的 agent）给的名字写入、按备份还原。名字由对话里的模型读完描述后决定，所以不花额外 token，也不会被别人的 README 带偏。

## 它到底改了什么

对每个被贴的包，只动这些：

| 文件 | 动作 |
|---|---|
| `<包>/locale/zh.json` | 新建或合并，写入 `meta.title` / `meta.description` |
| `<包>/locale/en.json` | 同上，英文名与英文说明 |
| `<包>/package.json` | **仅当** `exports` 是对象映射且没有 `./locale/*.json` 时，加一行放行 |

包名、入口、依赖、`main` 一律不动——所以配置、定时任务、历史会话全都照旧。

## 安全措施

1. **只碰 profile 里网上下载/本地链接的包**。DSH 安装目录里的自带包一律只读，标 `installation` 跳过。
2. **`package.json` 只做加法**。写前校验原导出项一个不少，写后回读；不是对象形式的 `exports` 直接拒绝，不冒险改写。
3. **不污染 pnpm 仓库**。pnpm 的包文件和全局 store 是硬链接共享的；本插件写入时先写新文件再 rename 覆盖，切开链接，仓库那份一个字节都不动。
4. **写入前完整备份**。原文件内容（或"原本不存在"）记在 `<profile>/.plugin-sticker/backups/<id>/manifest.json`，`sticker_revert` 一键还原。
5. **不联网、不调模型、不执行外部命令**。全部逻辑是 Node 内建模块。
6. **写接口带闸**。设置页的写操作要求一个自定义请求头；跨源页面无法在不触发 CORS 预检的前提下伪造它，所以本地其他网页脚本不能借 `127.0.0.1` 偷偷改你的包。

## 设置页

装好后打开 **设置 → 插件工牌**：

- 每个可改的插件一行：包名、版本、装法，右边一个输入框直接改名字，回车或点「贴上」即写入。
- 改不了的（DSH 自带包、没有写权限、`exports` 不是对象映射）单独列在下面，并写明原因。
- 底部是备份列表，每条带「还原」。

设置页和 agent 工具走**同一份实现**（`lib/ops.js`），所以两边行为一致：同样的校验、同样的备份、同样的报错。

## 三个工具

| 工具 | 作用 |
|---|---|
| `sticker_scan` | 列出已装的 bundle：包名、版本、描述、README 摘录、有没有工牌、能不能改 |
| `sticker_apply` | 按 `{package, title, description}` 写入，返回备份 id |
| `sticker_revert` | 不传参列备份；传 `backup` 还原 |

典型对话：

```
你：看看我装了哪些插件，给没中文名的起个中文名贴上
（模型调 sticker_scan → 读描述 → 调 sticker_apply）
```

## 还原

```
sticker_revert                        → 列出所有备份
sticker_revert {"backup": "<id>"}     → 还原到写入前
```

## 局限（先说清楚）

- **插件更新会掉**。更新会重建包目录，工牌跟着没了。重新贴一次即可；这不是 bug，是"改别人包"的固有代价。
- **自带包改不了**。DSH 安装目录里的包是只读的，扫描时会标出来。
- **需要写权限**。如果 profile 目录只读，或你在受限沙箱下运行，`sticker_apply` 会失败并告诉你原因。
- **只改显示名**。想改包名请直接 fork 插件——包名一变，依赖解析和行 id 都会跟着变。

## 安装

在 DSH 的「插件」页选择从 Git / 本地目录安装本仓库，或用：

```
plugin_manager {"action": "install_bundle", "target": "<本仓库的 tarball 地址或本地目录>"}
```

装完刷新「插件」页，新工具在下一次会话生效。

## 目录

```
index.js            工具注册与 /api/plugin-sticker 路由
client.js           「设置 → 插件工牌」那一页（自注册浏览器脚本）
lib/ops.js          工具与设置页共用的操作实现（唯一一份规则）
lib/profile.js      profile 定位、文件读取、node_modules 枚举
lib/scan.js         扫描 bundle、判断装法/可写性/exports 状态
lib/sticker.js      计划、写入、备份、还原
locale/             本插件自己的工牌
```

## License

MIT
