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
3. **不污染 pnpm 仓库**。pnpm 的包文件和全局 store 是硬链接共享的；本插件对**任何文件**（包括已存在的 `locale/zh.json`）都先写临时文件再 rename 覆盖，一律换成新 inode，仓库里那份一个字节都不动。
4. **备份先行、改完回读**。动任何文件之前，先把原内容（含"原本不存在"）连同 fsync 写进 `<profile>/.plugin-sticker/backups/<id>/manifest.json`，再核对这份备份与磁盘现状一致，才允许开始写；写完逐个回读比对，任何不一致立即按备份回滚。
5. **坏文件不覆盖**。已有 locale 文件如果不是合法 JSON，直接拒绝修改并提示，绝不当空文件覆盖——宁可不动，也不丢别人原有的翻译。
6. **不联网、不调模型、不执行外部命令**。全部逻辑是 Node 内建模块。
7. **写接口带闸**。设置页的写操作要求一个自定义请求头；跨源页面无法在不触发 CORS 预检的前提下伪造它，所以本地其他网页脚本不能借 `127.0.0.1` 偷偷改你的包。

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
| `sticker_apply` | 按 `{package, title, description}` 写入，返回备份 id，并记住这个名字 |
| `sticker_revert` | 不传参列备份；传 `backup` 还原 |
| `sticker_reconcile` | 检查记录的工牌是否还在；`fix: true` 恢复丢失的，`overwrite: true` 连被改写的也覆盖 |

典型对话：

```
你：看看我装了哪些插件，给没中文名的起个中文名贴上
（模型调 sticker_scan → 读描述 → 调 sticker_apply）
```

## 还原

```
sticker_revert                        → 列出所有备份
sticker_revert {"backup": "<id>"}     → 还原到写入前
sticker_revert {"backup": "<id>", "force": true}   → 覆盖之后的改动强行还原
```

还原有四道检查：

1. **备份结构**。字段缺失、路径不是绝对路径、`before` 类型不对，直接拒绝。
2. **路径白名单**。只允许还原**当前 profile 里真实存在**的插件包内的三个文件：`package.json`、`locale/zh.json`、`locale/en.json`。路径先做 realpath，越界或经符号链接指到别处的，一律拒绝。
3. **不重复还原**。带 `revertedAt` 的备份不会再执行（避免用旧备份反复覆盖新状态）。
4. **不静默覆盖**。备份里记了写入后的内容，还原前先比对磁盘现状；对不上就中止并列出冲突文件，只有显式 `force` 才覆盖。
5. **还原后同步记录**。还原完会把 `stickers.json` 改成磁盘现状：本来没有工牌的就从记录里删掉，改为别的名字的就跟着改。否则下一次检查会把刚还原掉的工牌当成"丢失"再提一次。

## 工牌持久化

名字记在 `<profile>/.plugin-sticker/stickers.json`——**只是记录，不碰插件包**。每次 `sticker_apply` 成功后写一条。

检查时把每条记录分成四类：

| 状态 | 含义 | 默认动作 |
|---|---|---|
| 正常 | 包里名字 = 记录 | 不动 |
| 丢失 | 包里已经没有任何名字（多半是更新冲掉的） | `fix` 可一键恢复 |
| 被改写 | 包里有名字但跟记录不同（可能上游改了自己的 locale） | **只提示**，要 `overwrite` 才覆盖 |
| 不可用 / 已卸载 | 不能写 / 包不在了 | 只报告；卸载的保留记录，重装后还能恢复 |

三个触发点：

1. `sticker_reconcile` 工具
2. 设置页顶部横幅：「恢复丢失的」/「也覆盖被改写的」/「纳入管理」
3. DSH 启动时读一次——**只在日志里报个数字，不写任何文件**

不做定时轮询：没必要，还容易和 pnpm 装包过程撞车。

早期手工贴过、还没进记录的工牌，`fix: true` 会先做一次「纳入管理」：只记名字，不碰包。

## 局限（先说清楚）

- **插件更新会把工牌冲掉**。更新重建包目录，locale 跟着没了。这不是能绕过的 bug——显示名只有包内 locale 一个来源，没有 profile 级覆盖通道。所以本插件做的是**持久化记录 + 更新后提示恢复**，见下一节。
- **自带包改不了**。DSH 安装目录里的包是只读的，扫描时会标出来。
- **需要写权限**。如果 profile 目录只读，或你在受限沙箱下运行，`sticker_apply` 会失败并告诉你原因。
- **只改显示名**。想改包名请直接 fork 插件——包名一变，依赖解析和行 id 都会跟着变。

## 安装

```
# 从 GitHub 按 tag 装，版本锁死、可复现
plugin_manager {"action":"install_bundle","target":"github:hanjiahe123/dsh-plugin-sticker#v0.3.0"}
```

npm 上的 `dsh-plugin-sticker` 目前停在 0.2.1（发版时才更新），新版以 GitHub 的 tag 为准：

```
plugin_manager {"action":"install_bundle","target":"dsh-plugin-sticker"}
```

也可以在 DSH 的「插件」页 → 添加插件，填上面任一地址。

装完刷新「插件」页：设置页立刻可用，agent 工具在下一次会话生效。

## 目录

```
index.js            工具注册与 /api/plugin-sticker 路由
client.js           「设置 → 插件工牌」那一页（自注册浏览器脚本）
lib/ops.js          工具与设置页共用的操作实现（唯一一份规则）
lib/registry.js     工牌记录（stickers.json）的读写与损坏保护
lib/profile.js      profile 定位、文件读取、node_modules 枚举
lib/scan.js         扫描 bundle、判断装法/可写性/exports 状态
lib/sticker.js      计划、写入、备份、还原
locale/             本插件自己的工牌
```

## License

MIT
