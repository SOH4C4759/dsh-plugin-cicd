# dsh-plugin-cicd（DSH 插件发布台）

把 **DSH 插件的持续构建与发布（CI/CD）**搬进 DeepSeek Harness：侧边栏一个图标，点开是一个占满主区域的独立面板。

> **名字**：界面显示名为「DSH 插件发布台」（副标题「持续构建与发布（CI/CD）」；英文界面为 `DSH Plugin CI/CD`）。包名与仓库 id 保持 `dsh-plugin-cicd` —— 它们只是技术标识，改名会破坏已有安装（profile 的 `link:` 路径、bundles 条目、patch 里的 row id、配置文件路径）。

它回答四个 GitHub 页面各自只说了一部分的问题：

- **构建过了吗** —— 每个仓库最近一次运行的状态、耗时、触发事件。
- **发布了吗** —— 已发布的 Release、还在草稿箱里的 Release、资产清单。
- **本地领先于发布吗** —— 本地 `package.json` 版本、领先/落后提交数、未提交文件数。
- **装的是发布出去的那份吗** —— 本机 profile 里这份是 `link:` 的本地检出、还是 Release 上的 tgz；差几号版本。

面板上能直接做的动作：`构建`（触发 `ci.yml`）、`发布`（触发 `release.yml`，默认产出草稿）、`升版本并发布`、`公开发布草稿`、`装 Release vX` / `更新到 vX`、`重跑`、`取消`、`看失败日志`，以及更新之后的 `立即重启 DSH`。

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
| 更新已装的那份 | 行上的「装 Release vX」/「更新到 vX」→ 展开处「确认更新」 | **不需要**（Host 把 tgz 交给 DSH 自己的插件管理器安装） |
| 让新版生效 | 更新后面板直接问「现在重启？」→「立即重启 DSH」 | **不需要**（转发给 `dsh-plugin-restart`；没装它会明确说） |
| 看失败日志 / 重跑 / 取消 | 展开行里的对应按钮 | **不需要** |
| 账号、权限、仓库清单 | 设置 → **GitHub 账户**（与「账户」相邻的一项） | **不需要** |

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

| profile 里的依赖 | 面板的判断 |
|---|---|
| `link:F:\...`（本地检出） | **本地检出** —— 跑的不是发布出去的那份，即使版本号与 Release 完全相同。按钮是【装 Release vX】 |
| `file:...\x-1.2.0.tgz`，装的是 1.2.0，Release 是 1.3.0 | **可更新** —— 行上出现「可更新 v1.3.0」标记，按钮是【更新到 v1.3.0】 |
| 装的是 2.0.0，Release 是 1.3.0 | 面板明说**装它会往回退**，不假装是"更新" |
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

调用一律用 `execFile` 传 argv、**不经 shell**；仓库名、workflow 名、tag 在进入 `gh` 之前都按 slug 形状校验过。子进程带 `GH_PROMPT_DISABLED=1`，否则一个想提问的 `gh` 会挂在没人持有的 stdin 上，面板只会转圈到超时。

## 安全边界

- 所有路由都是 **POST + 仅回环 + 同源**（`isTrustedRequest`），与宿主设置桥对自家回环路由的信任策略一致：只有「来自本机」且「来自这个 Host 服务的文档」的请求能过。这些路由以本机 GitHub 凭据行事，所以不能只按端口放行。
- 只读部分：状态、概览、运行、日志。**有副作用的是六条**：`dispatch`、`run-action`、`release-action`、`version-bump`、`update`、`restart`。
- `version-bump` 是唯一会**写本地检出**的路由：只改 `package.json` 的版本行，然后 `git commit` 只提交这一个文件并推送当前分支。工作区不干净、分支没有上游、或落后于上游时它直接拒绝，不做任何写入。
- `update` 是唯一会**改 profile 依赖**的路由：下载 Release 里的 tgz，再交给 Host 的插件管理器安装；失败时由管理器还原 `package.json` 与 lockfile。
- `restart` 自己不重启任何东西：它把请求转发到同一个 Host 上的 `/api/dsh-restart/restart`，由 `dsh-plugin-restart` 决定停哪个进程、用什么命令拉起来。没有那个插件就回 `501 restart-unavailable`。
- `公开发布草稿` 是唯一的不可逆动作，所以它要两次点击、中间那一步明说「发布后任何人可见，无法收回」。

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

一律返回 `{ ok: true, value }` 或 `{ ok: false, code, message }`。

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

它自己也用同一套：[`ci.yml`](.github/workflows/ci.yml) 每次 push 跑 [`tests/host-checks.mjs`](tests/host-checks.mjs)（120 条离线检查，覆盖入口校验/配置夹取/降级路径/发布预检与版本号运算/安装态与更新判决）、[`tests/mount-check.mjs`](tests/mount-check.mjs)（30 条：真挂载、真起 HTTP、真走路由，含更新与转发重启的两条拒绝路径）、[`tests/bump-e2e.mjs`](tests/bump-e2e.mjs)（29 条：真 git 仓库、真提交、真推送，以及每条拒绝都不留半截改动）与 [`tests/client-render.mjs`](tests/client-render.mjs)（41 条：用桩 React 真渲染面板，证明「发布」与【升版本并发布】确实按判决切换、被拦的原因真的到了屏幕上，以及一次更新真的 POST 了 `/update`、随后真的问要不要重启、点下去真的 POST 了 `/restart`），并真造一个发布包；[`release.yml`](.github/workflows/release.yml) 在 `v*` tag 上构建并上传 Release，**对解包后的资产**再跑一遍这几套。发布流程见 [RELEASING.md](RELEASING.md)。

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

## License

MIT，见 [LICENSE](LICENSE)。
