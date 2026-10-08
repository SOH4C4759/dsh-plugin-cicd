# dsh-plugin-cicd（DSH 插件发布台）

把 **DSH 插件的持续构建与发布（CI/CD）**搬进 DeepSeek Harness：侧边栏一个图标，点开是一个占满主区域的独立面板。

> **名字**：界面显示名为「DSH 插件发布台」（副标题「持续构建与发布（CI/CD）」；英文界面为 `DSH Plugin CI/CD`）。包名与仓库 id 保持 `dsh-plugin-cicd` —— 它们只是技术标识，改名会破坏已有安装（profile 的 `link:` 路径、bundles 条目、patch 里的 row id、配置文件路径）。

它回答四个 GitHub 页面各自只说了一部分的问题：

- **构建过了吗** —— 每个仓库最近一次运行的状态、耗时、触发事件。
- **发布了吗** —— 已发布的 Release、还在草稿箱里的 Release、资产清单。
- **本地领先于发布吗** —— 本地 `package.json` 版本、领先/落后提交数、未提交文件数。
- **装的是发布出去的那份吗** —— 本机 profile 里这份是 `link:` 的本地检出、还是 Release 上的 tgz；差几号版本。
- **npm 上是哪一版** —— 这个版本在不在公开源上；不在的话，一次点击就能推上去。

也就是说：**一个包，两条分发渠道**。GitHub Release 给人下载与审阅，npm 让 `dsh plugin add <名字>` 一条命令装完。

面板上能直接做的动作：`构建`（触发 `ci.yml`）、`发布`（触发 `release.yml`，默认产出草稿）、`升版本并发布`、`公开发布草稿`、`推送到 npm vX`（+ 在面板里写 npm token）、`装 Release vX` / `更新到 vX`、`重跑`、`取消`、`看失败日志`，以及更新之后的 `立即重启 DSH`。

## 安装

本机 profile 用 `link:` 指向检出目录，和其它插件一致：

```powershell
dsh plugin --profile desktop add "link:F:\CodeProj\dsh-plugin-cicd"
```

装完需要重启 DSH 才会被组合进运行时（宿主半边与浏览器半边都要）。

## 零代码操作（给不写程序的人）

面板的目标是**只用鼠标**就能完成日常使用。凡是下表打了勾的，都不需要打开终端：

| 要做的事 | 怎么做 | 需要命令行吗 |
|---|---|---|
| 登录 GitHub | 面板顶部的「用浏览器登录 GitHub」→ 打开授权页 → 输入面板显示的一次性代码 | **不需要**（Host 替你跑 `gh auth login --web`，把码显示出来） |
| 补齐权限 | 同一处的「补齐权限」，走同样的浏览器流程 | **不需要** |
| 添加仓库 | 「管理仓库」→ 从你的仓库列表勾选（本地检出自动匹配） | **不需要** |
| 移除仓库 | 取消勾选 | **不需要** |
| 触发构建 / 发布出草稿 | 仓库那一行的「构建」「发布」 | **不需要** |
| 公开草稿 | 展开行 →「公开草稿」→「确认公开？」（两次点击） | **不需要** |
| 给 npm 一个 token | 面板顶部（未登录时才出现）粘贴 Access Token →「写入并验证」 | **不需要**（Host 写进 npm 自己读的 `~/.npmrc`，插件不保存 token） |
| 推送到 npm | 展开行 →「推送到 npm vX」→「确认推送」（两次点击；开了 2FA 就在同一行填一次性密码） | **不需要**（Host 用 DSH 自带的 pnpm 发布，复用同一个包管理器） |
| 更新已装的那份 | 行上的「更新到 vX」（**只有 profile 装的是更旧的发布包时才有**；`link:` 检出与"装它会降级"两种情况的按钮在展开处）→ 展开处「确认更新」 | **不需要**（Host 把 tgz 交给 DSH 自己的插件管理器安装） |
| 让新版生效 | 更新后面板直接问「现在重启？」→「立即重启 DSH」 | **不需要**（转发给 `dsh-plugin-restart`；没装它会明确说） |
| 看失败日志 / 重跑 / 取消 | 展开行里的对应按钮 | **不需要** |
| 账号、权限、仓库清单 | 设置 → **插件** → **DSH 插件发布台** → **GitHub** | **不需要** |

**仍然需要命令行的两件事**，如实列出，不假装不需要：

1. **安装这个插件本身**（一次性）——见下一节。
2. **改版本号并打 tag**——版本号写在 `package.json`，tag 指向提交，这是"发布的到底是什么"的唯一来源；面板不去改你的源码。面板的「发布」按**当前**版本号出包，要在同一版本上重发就再点一次（会替换资产）。

「更新」装完要重启才生效，这一步**面板会主动问**（见下文《更新已安装的插件》）；重启由 `dsh-plugin-restart` 执行，发布台自己不碰进程。

连 `gh` 都没装时，面板给下载页链接；而安装 `gh` 这一步在 Windows 上目前仍需一次终端（或用安装包）。

## 别人怎么装（下载即用）

Release 里有两个资产，回答两个不同的问题：

| 资产 | 用途 |
|---|---|
| `dsh-plugin-cicd-<version>.tgz` | **可安装的那份**：一条命令装，不用解压、不需要本地检出 |
| `dsh-plugin-cicd-<version>.zip` | 整棵仓库树，给人看/审/做 diff |
| `SHA256SUMS.txt` | 上面两个的校验和（用途是"确认你下载的没坏"，不是防篡改——见 [RELEASING.md](RELEASING.md)） |

```powershell
# 1. 下载 tgz（或从 Release 页面直接下）
gh release download v0.1.0 -R SOH4C4759/dsh-plugin-cicd -p '*.tgz'

# 2. 装进你的 profile（把 desktop 换成你自己的）
dsh plugin --profile desktop add "file:$PWD\dsh-plugin-cicd-0.1.0.tgz"

# 3. 重启 DSH，侧边栏出现「发布台」图标
```

`file:` 指向本地的 tgz，pnpm 会解包进 profile 的 `node_modules`。这条路径已经在发布资产上实测过：解包后 `scripts/verify-bundle.mjs` 与 `tests/host-checks.mjs` 都能跑通，`cordis.patch.yml` 与 `scripts/configure.mjs` 都在包里（`npm pack` 只带 `files` 白名单，CI 每次都验这两点）。

## 更新已安装的插件（把上一条从终端搬进面板）

上面那三行命令，现在就是面板上一个按钮：**「装 Release vX」/「更新到 vX」**。它做的正是那三行的前两步，第三步（重启）由面板接着问。

每一行都会先回答"这个 profile 里现在装的是什么"，因为**版本号相等不代表同一份代码**：

| profile 里的依赖 | 面板的判断 | 行上有没有按钮 |
|---|---|---|
| `link:F:\...`（本地检出） | **本地检出** —— 跑的不是发布出去的那份，即使版本号与 Release 完全相同 | **没有**。展开处有次要按钮【装 Release vX】（+ 说明会替换掉什么），因为这台机器是**开发这份插件的地方**，行上的按钮只会把正在改的代码换成 tgz |
| `file:...\x-1.2.0.tgz`，装的是 1.2.0，Release 是 1.3.0 | **可更新** —— 行上出现「可更新 v1.3.0」标记 | **有**，【更新到 v1.3.0】——这是行上唯一会被摆出来的安装动作 |
| 装的是 2.0.0，Release 是 1.3.0 | 面板明说**装它会往回退**，不假装是"更新" | **没有**（等于把降级当日常维护）。展开处仍可点，但只是次要按钮 |

**为什么把行让出来**：面板的行是"你现在要做的事"。对**插件作者自己**来说，`link:` 是常态，装 Release 不是要做的事，而是**取消掉让开发能进行的那套设置**；而 `ahead`（profile 里更新）那种情况，行上摆按钮等于**把降级摆在最显眼的位置**。这个能力保留在展开处——"发布出去的那份到底装不装得起来"仍然要能在这里回答——只是不再叫卖。
| 装的是 1.2.0-rc.1 | 两边**无法比较**，如实说不能比较，而不是猜一个先后 |
| 版本相同、且就是 Release 的 tgz | **已是最新**，没有按钮 |
| 不在这个 profile 的依赖里 | **未安装** —— 没有"已装的那份"可以更新，并写出找的是哪个 profile |
| 还没有已发布的 Release（草稿不算） | **没有可装的** |

装的时候：

1. `gh release download <tag> -p <tgz>` 把资产下到**插件自己的目录** `<DSH_HOME>\dsh-plugin-cicd\downloads\`（不是临时目录——profile 的依赖会指向这个路径，下完就删会让清单再也装不上）。
2. 交给 **DSH 自己的插件管理器**（`ctx.get('pluginManager').installBundle`），也就是 `dsh plugin add` 走的同一条 pnpm 路径：它持有 profile 锁，失败时把 `package.json` / `pnpm-lock.yaml` 还原。发布台**不**自己起一个 `dsh plugin` 子进程——那会是对同一个 profile 的第二个写入者。
3. 面板接着**问要不要重启**（不假设答案）。重启转发给 `dsh-plugin-restart`；没装这个插件时回一句明确的「没挂载」，而不是一个看不出所以然的失败。

一次只跑一个更新（再来一个回 `409 busy`），因为插件管理器本来就会排队，而两个转圈比一个明确的拒绝更难懂。

**没有装它就没有这部份**：`update` 路由需要 Host 提供 `pluginManager` 服务，没有就回 `501 plugin-manager-missing`，而不是假装装过。

## 推送到 npm（第二条分发渠道）

Release 是给人下载的，npm 是给 `dsh plugin add` 装的。面板把它们并排放：一行上既有 GitHub 的 tag，也有 npm 上的版本。**独立按钮，不和「发布」绑在一起**——推送不可逆，不该搭在另一个动作上顺带发生。

每一行先说清 npm 现在是什么状态：

| 面板看到 | 判定 | 按钮 |
|---|---|---|
| 这个版本已在 npm 上 | **已发布** | 没有按钮（npm 不允许同一版本推第二次） |
| 名字在 npm 上还没人占 | **未注册** | 【推送到 npm vX】——这次就是**首次发布** |
| 名字已存在，但这个版本没推过 | **未发布** | 【推送到 npm vX】 |
| 问不到源（离线/被拦） | **未知** | **没有按钮**——宁可不给，也不给一个注定失败的 |

推送前会逐条拒绝，且**每一条都发生在任何字节上传之前**：

- **`private: true`** —— 作者的决定，不是这里能绕过的（本仓库集里的 `dsh-knowledge-console` 就是这种）。
- **工作区有未提交改动** —— `publish` 打包的是**工作目录**；`files` 白名单挡不住"白名单目录里的新文件"。
- **这个版本已经在 npm 上** —— npm 不接受同一版本推两次，撤回也只在很短的时间内可行。
- **没有登录 npm** —— 面板直接给出解决路径（见下）。
- **没有本地检出 / 没有版本号 / 读不到源**。

### 凭据：和复用 `gh` 同一个原则

插件**不保存任何 token**。它用 DSH 自带的 pnpm（`profileContext.packageManager`，也就是插件管理器安装时用的那个），凭据来自 npm 自己读的用户级 `.npmrc`。

`gh` 那侧不需要教：它自己开浏览器设备码流程。npm 这侧不一样——token 得**手动在网站上建**，而且那条路的 UI 在 2025 年 11 月变过。所以未登录时面板给的是**从零开始的四步**，不是一句话：

| 步 | 面板说什么 |
|---|---|
| ① 没有账号 | 「打开 npmjs.com 注册」按钮 + **注册后必须到邮箱点确认链接**（未验证邮箱的账号发不出去） |
| ② 建 token | 「打开 token 页面」→ `npmjs.com/settings/~/tokens`。**类型只有 Granular Access Token 一种可选**：Classic token 已于 **2025-11-19 被 npm 全部撤销**，现在也建不出来。Permissions 选 `Read and write`，Packages 选全部或只勾这个包 |
| ②a 有效期 | **最长 90 天**，这是 npm 对可写 token 的硬限制。到期就静默失效，回到第 ② 步再建一个 |
| ②b 2FA | 只有"给 CI 用、没人能输一次性密码"时才勾 **Bypass 2FA**。在这里推**不要勾** |
| ③ 粘贴 | 写进 `%USERPROFILE%\.npmrc`（**就是 `npm login` 会写的那个文件**；其他行原样保留，旧版本留一份 `.bak`），然后立刻用 `whoami` 验证 |
| ④ 2FA | 推送的确认行里会出现一次性密码输入框 |

token 不回显、不落插件、不进日志；页面在请求返回的那一刻就清空输入框。token 被拒时，面板直接把**排查清单**摊在同一块里（复制不全 / 权限不是 Read and write / 已撤销或超过 90 天 / 范围是别的包 / 邮箱未验证），而不是只回一句 `ERR_PNPM_WHOAMI_UNAUTHORIZED`。

**如果 npmjs.com 在你这台机器上打不开**——实测过：整站被 Cloudflare 挑战拦下（`/`、`/signup`、`/settings/~/tokens` 一起回 **403 `Just a moment...`**，走本地代理也一样）——那就**换一台设备或换一个网络**（手机流量最省事）生成 token，再粘到第 ③ 步。**面板只认这个 token，不在乎它在哪里生成**，这一步和你本机的浏览器无关。

同时**别再指望命令行**：`POST registry.npmjs.org/-/user/org.couchdb.user:*` 现在回 **405 Method Not Allowed**，也就是 `npm login --auth-type=legacy` / `pnpm login` 这条路已被 npm 移除；而建 token 的 `POST /-/npm/v1/tokens` 虽然还活着并真在认证（假凭据回 `404 User not found`），但 npm 公告写明新 classic token 不能再经 API 创建。所以**网站（或在另一台设备上打开它）是唯一的路**。发布本身不受影响：`registry.npmjs.org` 一直是通的。

**凭据是三个状态，不是一个布尔值**（`npmAuthState`）。`whoami` 是用户级端点，而 granular token 是**包级范围**的——它完全可能在 `whoami` 上被拒、却发布得好好的。把这种拒绝读成"没登录"，就会正好挡住引导让用户去建的那种 token，还会对刚做完第 ③ 步的人说"你还没开始"。所以：

| 状态 | 面板 |
|---|---|
| `signed-in`（`whoami` 答了） | 顶部显示 `npm <账号>`，不出引导 |
| `credential-present`（`.npmrc` 里有 token，但 `whoami` 不确认） | 一句说明 + 原样显示 `whoami` 的拒绝，**照着可以推**；真伪由推送来判 |
| `none`（两者都没有） | 四步引导 |
| 没有答案（`/npm-status` 未响应） | **什么都不显示**——"没有答案"不等于"没有凭据" |

同理，推送的闸门是"**有没有可用来认证的东西**"，不是"`whoami` 答没答"：token 不对的话推送本来就会失败，而失败已经被归类成下一步。

推送失败也**归类**成下一步做什么，而不是把 npm 的原话丢给用户：`otp-required`（去填一次性密码）、`email-unverified`（去点确认链接）、`not-logged-in`（重建 token）、`already-published`（先升版本）、`payment-required`（私有包要付费）、`forbidden`（检查 token 的 Packages 范围）、`not-found`、`rate-limited`、`registry-error`、`network`、`timeout`、`unknown`。npm 的原话仍然原样显示在下面——归类是补充，不是替换。

开了 2FA 的账号，推送时 npm 要一次性密码：确认行里就有那个输入框。子进程的 stdin 是关闭的（`ignore`），所以它**不会**挂着等一个没人持有的 stdin——失败会明说是要 OTP，而不是转圈到超时。

### 另一条路：完全不用 token（trusted publishing）

如果你的目标是"CI 里自动发布"，**不该**用上面这条路。npm 支持 **trusted publishing（GitHub Actions OIDC）**：`release.yml` 加 `id-token: write` 权限并在 npm 上登记这个仓库，发布时用 OIDC 换一次性凭据——**没有任何长期 token**，还自带 provenance。这与本插件"不存凭据"的原则完全一致，也是本仓库更推荐的方向。

面板**不做**这件事：它是在**这台机器上推一次**的路径，不是 CI 的替代品。CI 发布需要 token 时，token 应放在仓库 secret 里（`NPM_TOKEN`），而不是这台机器上。

## B 站更新播报（第三条渠道）

插件更新了，除了 Release 和 npm，还有一件观众真的会看的事：在**介绍这个插件的视频**下面留一句"更新了什么"。这一条也做进面板里——每个仓库绑一个 BV 号，Release 公开之后自动在评论区补一条更新说明。

**触发条件只有一个：Release 已公开。** 草稿不算——草稿只有作者能看见，为它发"上线了"是对着空气说话。所以：

- 面板每 `bilibiliWatchSeconds`（默认 90 秒）巡检一次每个**已绑定**的仓库；
- 点【公开草稿】成功后立刻巡检一次（这一下就是"发布成功"的那一刻）；
- DSH 启动约 15 秒后巡检一次——关机期间发布的那些版本，只有这一次能补上；
- 幂等键是 `(仓库, tag)`，落在 `<DSH_HOME>\dsh-plugin-cicd\bilibili-announcements.json` 里。**同一个版本永远只发一条**；这份记录读不出来时**什么也不发**（否则会把已经发过的评论再刷一遍），面板会把原因写在最上面。

绑定视频时会写一条**基线**：绑定那一刻已经公开的版本不算"这次更新"。所以把视频接上来不会追发历史版本，只有之后的新版本会播报。

### 凭据：为什么必须是"网页登录"

发评论走的是 B 站 **Web** 接口，所以凭据必须是网页会话。这里踩过一回，记在文档里免得再踩：`biliup login` 写下的 `cookies.json` 是 **BiliTV 登录**（`platform: BiliTV`）——它能投稿（APP 接口），但所有 Web 会员接口一律回 `-101 账号未登录`。所以本插件**不假设"文件里有 SESSDATA 就能用"**，而是拿凭据去问一次账号接口，并把答案写在面板上；认不出来时给出的原话是"这份凭据是 BiliTV 登录（APP/TV）……"，不是"你没登录"。

凭据有两种给法，面板里都能做，不需要终端：

1. **【登录 B 站】**：走 passport 的网页二维码接口，生成一个链接——用手机 B 站扫，或者在你已经登录 B 站的浏览器里打开确认。面板轮询到确认后把 Cookie 存进插件自己的文件。
2. **粘贴一次**：浏览器 F12 → Application → Cookies → `bilibili.com`，把 `SESSDATA` 与 `bili_jct`（即 csrf）复制进来。B 站**当场接受才写入**——存一份已经回 `-101` 的凭据，只会让面板显示一个假的"已登录"。

两者都落在 `<DSH_HOME>\dsh-plugin-cicd\bilibili-cookies.json`（`bilibiliCookieFile` 可以指向别处，比如 biliup 那份，作为**兜底**读取；面板自己写的永远优先）。插件不回显这个文件的内容，【退出 B 站登录】也只删自己写的这一份——外部那份属于别的工具，不动。

### 评论内容

默认模板是 `【更新 {tag}】{summary}`：`{summary}` 取 Release 标题；标题就是版本号时改取 Release 正文第一段（去掉 Markdown、去掉 GitHub 自动生成的 "What's Changed / Full Changelog" 和 `by @someone in https://…` 尾巴）。可用占位符：`{tag}` `{version}` `{label}` `{repo}` `{title}` `{summary}` `{url}` `{date}`；不认识的占位符**留在原地并报出来**，不会被悄悄删掉。

默认模板**不带链接**：带外链的评论更容易被 B 站过滤，而被过滤和发成功在这边看起来一模一样。想要链接就把 `{url}` 写进 `bilibiliTemplate`。

发之前**一定先预览**：面板上点【发更新评论】会先问 Host "这条会写成什么"（`dryRun`），把即将发送的原文和 Host 的判决一起显示出来，确认后才真的发。预览由 Host 组装，不是浏览器——否则会出现"看到的是一句、发出去的是另一句"。

### 失败怎么处理

B 站的拒绝会被归类，而不是原样抛给用户：`-101` 未登录、`-400` 被拒、`-403` 无权限、`-412` 风控拦截、`-509` 频率限制、`12061` 内容被过滤……每一类给的是下一步做法。失败会记进播报记录；同一个版本失败 3 次后就停下等人工判断——风控拦下来的东西，连续重试只会更糟。

## 配置：用脚本，不要手改 YAML

包本身**不带仓库列表**——哪些仓库被监视是部署状态，不是包状态；把某个人的私有仓库名打进公开包，每个安装者都得先去拆它。

列表放在一个由脚本管理的 JSON 文件里（默认 `%USERPROFILE%\.dsh\dsh-plugin-cicd\repos.json`），profile patch 只留两行机器相关的配置：

```yaml
- id: dsh-plugin-cicd
  config:
    owner: SOH4C4759
    ghPath: 'C:\Program Files\GitHub CLI\gh.exe'
```

日常操作全走插件自带的脚本：

```powershell
$cfg = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-cicd\scripts\configure.mjs"
# 或直接用你的检出目录：F:\CodeProj\dsh-plugin-cicd\scripts\configure.mjs

node $cfg list                                             # 现在登记了什么
node $cfg add dsh-plugin-restart --path F:\CodeProj\dsh-plugin-restart
node $cfg add someone-else/their-plugin                    # 别人的仓库，只读
node $cfg remove dsh-plugin-restart
node $cfg owner SOH4C4759
node $cfg check                                            # 面板此刻会显示什么
```

- 插件**每次请求都重读这个文件**，所以 `add` 在面板下一次轮询（默认 30 秒）就生效，**不需要重启**。
- 写入是原子的（临时文件 + rename），旧版本留一份 `.bak`。
- 校验与宿主同规则：仓库名必须是 `name` 或 `owner/name`，`--path` 必须是绝对路径——相对路径会按宿主进程的目录解析，那不是你的 shell 目录。
- 文件读不了或格式错时，面板会**明确报错**而不是假装"没有仓库"，并回退到 patch 里的 `repos`。

patch 里仍可用的选项（每个都有默认值）：

| 键 | 默认 | 含义 |
|---|---|---|
| `owner` | `''` | 裸 `repo` 名用的 GitHub 账号；配置文件里的同名值优先 |
| `repos` | `[]` | 手写兜底；配置文件存在时以文件为准 |
| `configFile` | `<DSH_HOME>\dsh-plugin-cicd\repos.json` | 受管列表的位置 |
| `projectsRoot` | `''` | 本地检出所在根目录；面板添加仓库时据此自动填 `localPath`（按各目录 `package.json` 的 `name` 匹配，所以目录名与仓库名不同也能找到） |
| `defaultBranch` | `main` | 面板触发 workflow 用的 ref |
| `buildWorkflow` | `ci.yml` | `构建` 按钮触发的 workflow |
| `releaseWorkflow` | `release.yml` | `发布` 按钮触发的 workflow |
| `ghPath` | `''` | 空 = 从 PATH 与 `%ProgramFiles%\GitHub CLI\gh.exe` 等位置解析 |
| `requestTimeoutMs` | `20000` | 单次 `gh` 调用的硬超时 |
| `overviewTtlMs` | `15000` | 概览缓存窗口；面板轮询会走缓存 |
| `logTailLines` | `120` | 失败日志取最后多少行 |
| `pollSeconds` | `30` | 面板自动刷新间隔 |
| `npmRegistry` | `https://registry.npmjs.org/` | 推送目标源。改成私有源即可（只能 http/https，且 URL 里带凭据会被拒绝）；`.npmrc` 里的 token 行按这个源的 host 匹配 |
| `enabled` | `true` | 关掉后路由只回「已停用」，不碰 GitHub |

所有值都做**夹取**而不是拒绝：手写的 patch 不该能让宿主起不来，最坏情况是某个路由报告「未配置」。

## 首次使用：授权引导

面板不自己存凭据，它用你机器上的 `gh`。所以第一次打开时它可能无事可做——这时面板不会只显示一句"读不到"，而是**按缺什么给什么**：

| 状态 | 面板给出 |
|---|---|
| 找不到 `gh` | `winget install --id GitHub.cli`（可一键复制）+ cli.github.com 链接 |
| 装了但没登录 | `gh auth login`，并说明选 GitHub.com → HTTPS → 浏览器登录，完成后点「重新检测」 |
| 登录了但缺 scope | `gh auth refresh -h github.com -s repo,workflow`，缺哪个补哪个 |
| 没有任何仓库 | `configure.mjs add ...` 的实际命令 + 配置文件路径 |

scope 是从 `gh auth status` 真读出来的：缺 `repo` 读不到私有仓库，缺 `workflow` 无法触发构建——这两种情况在按钮按下去之前就会说明白。细粒度 token 不报 scope 行时按"未知"处理，不会误报成"全都缺"。

## 为什么复用 `gh` 而不是自带 token

本机 `gh` 已经登录、已经带好了 token scope。复用它意味着：插件**不存任何凭据**，不需要你再走一次 OAuth/PAT，而面板执行的命令就是你会手敲的那条（`gh run list` / `gh workflow run` / `gh release edit`）。反过来，任何要求你再输一次 token 的方案，都是把同一条权限链复制了第二份。

npm 这一侧是同一条原则的两个面：**包管理器**复用 Host 自己的 pnpm（`profileContext.packageManager`——插件管理器安装插件时用的就是它，第二个答案早晚会和第一个不一致），**凭据**放在 npm 自己读的 `.npmrc` 里。面板提供了一个写 token 的入口，但写的是那个文件，不是插件的任何存储：这与"面板能登录 GitHub 但插件不存 token"是同一句话。

调用一律用 `execFile` 传 argv、**不经 shell**；仓库名、workflow 名、tag 在进入 `gh` 之前都按 slug 形状校验过。子进程带 `GH_PROMPT_DISABLED=1`，否则一个想提问的 `gh` 会挂在没人持有的 stdin 上，面板只会转圈到超时。

## 安全边界

- 所有路由都是 **POST + 仅回环 + 同源**（`isTrustedRequest`），与宿主设置桥对自家回环路由的信任策略一致：只有「来自本机」且「来自这个 Host 服务的文档」的请求能过。这些路由以本机 GitHub 凭据行事，所以不能只按端口放行。
- 只读部分：状态、概览、运行、日志、npm 状态。**有副作用的是八条**：`dispatch`、`run-action`、`release-action`、`version-bump`、`update`、`restart`、`npm-login`、`npm-publish`。
- `version-bump` 是唯一会**写本地检出**的路由：只改 `package.json` 的版本行，然后 `git commit` 只提交这一个文件并推送当前分支。工作区不干净、分支没有上游、或落后于上游时它直接拒绝，不做任何写入。
- `update` 是唯一会**改 profile 依赖**的路由：下载 Release 里的 tgz，再交给 Host 的插件管理器安装；失败时由管理器还原 `package.json` 与 lockfile。
- `restart` 自己不重启任何东西：它把请求转发到同一个 Host 上的 `/api/dsh-restart/restart`，由 `dsh-plugin-restart` 决定停哪个进程、用什么命令拉起来。没有那个插件就回 `501 restart-unavailable`。
- `npm-login` 是唯一会**写用户级配置**的路由：把 token 合并进 `~/.npmrc`（其他行原样保留，旧版本留 `.bak`）。token **绝不出现在任何响应、日志或状态里**——`npm-status` 只回答"有没有那一行"，不回答"那行是什么"。
- `npm-publish` 是另一个**不可逆**动作：npm 不允许同一版本推两次，撤回也只在很短的时间内可行。所以它也要两次点击，且推送前逐条拒绝（`private: true`、脏工作区、版本已存在、未登录）。
- `公开发布草稿`、`npm-publish` 是仅有的两个不可逆动作，两者都要两次点击、中间那一步明说后果。

## HTTP 接口

面板用的就是这些，脚本也可以直接用：

| 路由 | 作用 |
|---|---|
| `POST /api/dsh-cicd/status` | `gh` 身份与解析后的仓库列表 |
| `POST /api/dsh-cicd/overview` | 每个仓库的运行 + Release + 本地 git 状态（`{force:true}` 绕过缓存） |
| `POST /api/dsh-cicd/runs` | `{repo, limit}` 单仓库运行列表 |
| `POST /api/dsh-cicd/dispatch` | `{repo, workflow?, ref?, inputs?}` 触发 workflow_dispatch；触发**发布流程**时会先做发布预检（见下节） |
| `POST /api/dsh-cicd/run-action` | `{repo, runId, action}`，action ∈ `rerun` / `rerun-failed` / `cancel` |
| `POST /api/dsh-cicd/release-action` | `{repo, tag, action}`，action ∈ `publish` / `delete`（`delete` 有意不给按钮） |
| `POST /api/dsh-cicd/version-bump` | `{repo, release?}`，release ∈ `patch`（默认）/ `minor` / `major`：升 `package.json`、提交、推送当前分支 |
| `POST /api/dsh-cicd/logs` | `{repo, runId}` 失败步骤日志的尾部 |
| `POST /api/dsh-cicd/update` | `{repo, tag?}`：把该 Release 的 `.tgz` 下载到 `<DSH_HOME>\dsh-plugin-cicd\downloads\` 并装进当前 profile。tag 缺省 = 最新一个**非草稿**且带 tgz 的 Release |
| `POST /api/dsh-cicd/restart` | 无参数：转发到 `dsh-plugin-restart` 的重启路由；没挂载则 `501 restart-unavailable` |
| `POST /api/dsh-cicd/npm-status` | 无参数（`{force:true}` 绕缓存）：`whoami` 的结果 + 每个包在源上的状态。**按需拉取，不参与 30 秒轮询**——每个仓库一次 HTTPS 加一次 `whoami` |
| `POST /api/dsh-cicd/npm-login` | `{token}`：把 token 合并进用户级 `.npmrc` 再用 `whoami` 验证。token 不回显 |
| `POST /api/dsh-cicd/npm-publish` | `{repo, otp?}`：用 Host 自己的 pnpm 发布当前版本。`otp` 是 2FA 一次性密码（6–8 位） |
| `POST /api/dsh-cicd/bilibili-status` | 无参数（`{force:true}` 绕缓存）：凭据状态 + 每个仓库的绑定/已播报/失败 + 播报记录文件。**不碰 GitHub** |
| `POST /api/dsh-cicd/bilibili-login-start` | 无参数：生成 B 站网页登录二维码，返回 `{ url, key, expiresAt }` |
| `POST /api/dsh-cicd/bilibili-login-poll` | 无参数：问一次是否已确认。`state` ∈ `waiting` / `scanned` / `succeeded` / `expired`；成功后 Cookie 落盘 |
| `POST /api/dsh-cicd/bilibili-login-cancel` | 无参数：放弃这次登录 |
| `POST /api/dsh-cicd/bilibili-credential` | `{cookie}` 或 `{sessdata, bili_jct}`：验证通过才写入插件自己的凭据文件 |
| `POST /api/dsh-cicd/bilibili-logout` | 无参数：删掉插件自己写的那份凭据（不动 `bilibiliCookieFile` 指定的外部文件） |
| `POST /api/dsh-cicd/bilibili-bind` | `{repo, bvid, auto?}`：绑定/解绑视频；绑定会写一条基线，`bvid: ''` 即解绑（播报记录保留） |
| `POST /api/dsh-cicd/bilibili-announce` | `{repo, tag?, text?, force?, dryRun?}`：组装（`dryRun`）或发送这一条更新评论。`tag` 缺省 = 最新的**已公开** Release |

一律返回 `{ ok: true, value }` 或 `{ ok: false, code, message }`。

`npm-status` 的每条仓库记录：`{ repo, label, localPath, packageName, version, dirty, privatePackage, state, latest, blockers, canPublish, registryProblem, registry, pageUrl }`。`state` ∈ `unregistered` / `unpublished` / `published` / `unknown`；`blockers` 是**具名原因**（`private-package`、`dirty-tree`、`not-logged-in`、`already-published`、`registry-unreachable`、`no-checkout`、`no-version`、`no-package-name`）——"没有按钮"是最没用的一句话，`private: true` 和"没登录"在屏幕上同样是空白，修法却完全不同。

`overview` 的每一行多一个 `install` 块：`{ profile, profileDir, profileReadable, packageName, present, spec, kind, installedVersion, latestTag, latestVersion, latestAsset, state }`。`state` ∈ `not-installed` / `no-release` / `current` / `update` / `ahead` / `differs` / `checkout`——判决在 Host 上做，所以面板和 `update` 路由不会各说一套。

`status` 另外报出 `profile: { name, dir, readable }`：更新写的是哪个 profile，是**报出来**的而不是假设的——「没装」和「面板看错了 profile」是两句不同的话，只有路径能把它们分开。

## 为什么「发布」曾经必然失败，以及现在的做法

**根因**：发布用的是 `package.json` 里的版本号，而 `release.yml` 有意拒绝覆盖**属于另一个提交的同号 Release**（否则公开草稿会创建旧提交上的 tag，tag 与资产从此不一致，而且整个过程静默）。于是只要树往前走了而版本没升，点「发布」触发的运行一定在第一步失败，约 10 秒后红掉；面板却提前宣告「已产出草稿」，真正的原因还藏在两层点击之后。实测有四个失败运行属于这一类（`dsh-plugin-restart` ×3、`dsh-plugin-cicd` ×1）。

**现在**：

1. **概览行先给出判决**（`releaseCheck`）。宿主拿 `releases[].target_commitish` 与「这次发布会构建的提交」对比：只有**能证明**版本已被另一个提交占用时才判 `blocked`（脏工作区、分支名 target、读不到远端提交都算「证明不了」，一律放行）——预检拦下一个本来能成功的发布，比没有预检更糟。行上出现【版本被占用】标记，展开即写明 `v1.0.0 已属于 48ce81c，而这次发布会构建 e6a1cc1`。
2. **`dispatch` 会拒绝注定失败的发布**，返回 `409 version-taken`，不再浪费一次运行。
3. **面板给出解法**：被占用时按钮变成【升版本并发布】，确认框里写明「从 1.0.1 升到 1.0.2、提交并推送到 main」——一次点击完成 `version-bump` + 发布触发。
4. **文案不再替运行结果打包票**：触发后说的是「是否真的产出草稿要看这次运行的结果，失败时展开点【日志】」。

`version-bump` 的拒绝清单（都保证**一个字节都没写**）：工作区有未提交改动（发布构建的是已推送的提交，这些文件会**静默缺席**于发布包）、分支没有上游、落后于上游、版本号不是 `major.minor.patch`、清单里出现第二个 `version` 键。推送失败**不回滚**：提交是真的，失败通常是 `github.com:443` 的老问题，所以如实回「本地已提交 X，推送失败」并让你重试推送。

## 设计取舍

- **UI 落在 `sidebar.panellist` + `main`**，不是浮层：侧边栏拿按钮，主区域拿页面，点开顶开内容而不是遮住它。
- **颜色只取 `--dsw-alias-*` 主题 token**，没有自带调色板——面板跟随亮/暗主题，而不是自带一套深色。
- **后台轮询失败不清空、不弹错**：合盖的笔记本不会产生一个不是用户造成的错误横幅，只是停止更新。
- **HTML/CSS/JS 三处都没有 `position: absolute` 的浮窗**：`main` 面板是布局里的一列。

## 本仓库自身的 CI/CD

它自己也用同一套：[`ci.yml`](.github/workflows/ci.yml) 每次 push 跑 [`tests/host-checks.mjs`](tests/host-checks.mjs)（167 条离线检查，覆盖入口校验/配置夹取/降级路径/发布预检与版本号运算/安装态与更新判决/npm 源与 token 与每条拒绝）、[`tests/mount-check.mjs`](tests/mount-check.mjs)（35 条：真挂载、真起 HTTP、真走路由，含更新、转发重启与 npm 三条拒绝路径）、[`tests/bump-e2e.mjs`](tests/bump-e2e.mjs)（29 条：真 git 仓库、真提交、真推送，以及每条拒绝都不留半截改动）与 [`tests/client-render.mjs`](tests/client-render.mjs)（71 条：用桩 React 真渲染面板，证明「发布」与【升版本并发布】确实按判决切换、被拦的原因真的到了屏幕上、一次更新真的 POST 了 `/update` 并接着问要不要重启、以及一次 npm 推送真的 POST 了 `/npm-publish` 且未登录时真的能只靠粘贴 token 完成），并真造一个发布包；[`release.yml`](.github/workflows/release.yml) 在 `v*` tag 上构建并上传 Release，**对解包后的资产**再跑一遍这几套。发布流程见 [RELEASING.md](RELEASING.md)。

`tests/host-checks.mjs` 里另有一半检查需要真实的 `gh` 与特定的仓库状态，用 `DSH_CICD_LIVE=1` 打开：

```powershell
node tests/host-checks.mjs                    # 离线，CI 跑的就是这个
$env:DSH_CICD_LIVE = 1; node tests/host-checks.mjs
```

### 推送通道被阻断时

本机实测：`github.com:443` 会被间歇阻断（`git push` 报 `Connection was reset` 或直接连不上），而 `api.github.com:443` 一直可达——所以 `git` 挂了但 `gh` 一切正常。

[`scripts/push-via-api.ps1`](scripts/push-via-api.ps1) 走 API 造出**逐字节相同 SHA** 的提交对象再移动 ref，因此本地与远程不会分叉，不需要事后 `git reset --hard`：

```powershell
pwsh -File scripts/push-via-api.ps1 -RepoPath 'F:\CodeProj\dsh-plugin-cicd'
```

它在每一步比对重建出的 blob / tree / commit SHA 与本地提交，任何一处不一致就中止并**不移动 ref**；成功后连同 `refs/remotes/origin/main` 一起更新，否则 `git status` 会显示一个并不存在的「领先」。仓库已经同步时它什么都不做。

## 已知边界

- 路径按 Windows 书写（`F:\...`），`ghPath` 的默认候选也是 Windows 安装位置；其它平台请显式配 `ghPath`。
- 私有仓库要求 `gh` 已登录且 token 有 `repo` scope。
- 只观察 GitHub 上的仓库；本地没有远程的仓库（例如还在本地开发的）不在范围内。
- **更新需要 Host 提供 `pluginManager` 服务**（DSH 自带）。没有它时 `update` 回 `501`，不会退化成自己起一个 `dsh` 子进程去写 profile。
- **重启需要装了 `dsh-plugin-restart`**。发布台不自己杀进程——停哪个、怎么拉起来是那个插件的契约。
- 更新的判定读的是 `node_modules/<name>/package.json` 的版本，不是依赖字符串。`link:` 时它等于本地检出的版本，所以"版本一样"绝不能被当成"装的是发布的那份"——那正是 `checkout` 这个状态存在的理由。
- **npm 推送复用 Host 自己的包管理器**：优先 `profileContext.packageManager`（DSH 自带的 pnpm），其次 `DSH_PNPM`，再其次打包应用自带的 `resources/runtime/pnpm`，最后才是 PATH 上的 `pnpm`。走到最后一步而机器上没有 pnpm 时，报错会明说 `ENOENT` 与它找的是什么。源码里 `npm-status` 只做 `whoami`，网络那一侧是 HTTPS `fetch`（**不走** `HTTP_PROXY`，本机实测直连可达）。
- **npm 推送没有 provenance**，而且用的是长期 token（可写 token 最长 90 天）。真需要 `--provenance`（构建来源可验证）或不想在机器上放任何 token 的包，应当走 **trusted publishing（GitHub Actions OIDC）**——那才是 CI 的正路，面板这条路是"在这台机器上推一次"。
- npm 在 2025-11 之后**只有 Granular Access Token**：Classic token 已全部撤销且不能再创建。可写 token 默认强制 2FA、最长 90 天。任何还写着"建一个 Classic Automation token"的文档都已经过期了。
- `private: true` 的包（例如 `dsh-knowledge-console`）面板**不会**提供推送按钮，这是有意的：那行字段是作者的决定。

## License

MIT，见 [LICENSE](LICENSE)。
