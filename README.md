# dsh-plugin-cicd（DSH 插件发布台）

把 **DSH 插件的持续构建与发布（CI/CD）**搬进 DeepSeek Harness：侧边栏一个图标，点开是一个占满主区域的独立面板。

> **名字**：界面显示名为「DSH 插件发布台」（副标题「持续构建与发布（CI/CD）」；英文界面为 `DSH Plugin CI/CD`）。包名与仓库 id 保持 `dsh-plugin-cicd` —— 它们只是技术标识，改名会破坏已有安装（profile 的 `link:` 路径、bundles 条目、patch 里的 row id、配置文件路径）。

它回答三个 GitHub 页面各自只说了一部分的问题：

- **构建过了吗** —— 每个仓库最近一次运行的状态、耗时、触发事件。
- **发布了吗** —— 已发布的 Release、还在草稿箱里的 Release、资产清单。
- **本地领先于发布吗** —— 本地 `package.json` 版本、领先/落后提交数、未提交文件数。

面板上能直接做的动作：`构建`（触发 `ci.yml`）、`发布`（触发 `release.yml`，默认产出草稿）、`公开发布草稿`、`重跑`、`取消`、`看失败日志`。

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
| 看失败日志 / 重跑 / 取消 | 展开行里的对应按钮 | **不需要** |
| 账号、权限、仓库清单 | 设置 → **GitHub 账户**（与「账户」相邻的一项） | **不需要** |

**仍然需要命令行的两件事**，如实列出，不假装不需要：

1. **安装这个插件本身**（一次性）——见下一节。
2. **改版本号并打 tag**——版本号写在 `package.json`，tag 指向提交，这是"发布的到底是什么"的唯一来源；面板不去改你的源码。面板的「发布」按**当前**版本号出包，要在同一版本上重发就再点一次（会替换资产）。

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

- 七条路由全部是 **POST + 仅回环 + 同源**（`isTrustedRequest`），与宿主设置桥对自家回环路由的信任策略一致：只有「来自本机」且「来自这个 Host 服务的文档」的请求能过。这些路由以本机 GitHub 凭据行事，所以不能只按端口放行。
- 只读部分：状态、概览、运行、日志。**有副作用的只有三条**：`dispatch`、`run-action`、`release-action`。
- `公开发布草稿` 是唯一的不可逆动作，所以它要两次点击、中间那一步明说「发布后任何人可见，无法收回」。

## HTTP 接口

面板用的就是这些，脚本也可以直接用：

| 路由 | 作用 |
|---|---|
| `POST /api/dsh-cicd/status` | `gh` 身份与解析后的仓库列表 |
| `POST /api/dsh-cicd/overview` | 每个仓库的运行 + Release + 本地 git 状态（`{force:true}` 绕过缓存） |
| `POST /api/dsh-cicd/runs` | `{repo, limit}` 单仓库运行列表 |
| `POST /api/dsh-cicd/dispatch` | `{repo, workflow?, ref?, inputs?}` 触发 workflow_dispatch |
| `POST /api/dsh-cicd/run-action` | `{repo, runId, action}`，action ∈ `rerun` / `rerun-failed` / `cancel` |
| `POST /api/dsh-cicd/release-action` | `{repo, tag, action}`，action ∈ `publish` / `delete`（`delete` 有意不给按钮） |
| `POST /api/dsh-cicd/logs` | `{repo, runId}` 失败步骤日志的尾部 |

一律返回 `{ ok: true, value }` 或 `{ ok: false, code, message }`。

## 设计取舍

- **UI 落在 `sidebar.panellist` + `main`**，不是浮层：侧边栏拿按钮，主区域拿页面，点开顶开内容而不是遮住它。
- **颜色只取 `--dsw-alias-*` 主题 token**，没有自带调色板——面板跟随亮/暗主题，而不是自带一套深色。
- **后台轮询失败不清空、不弹错**：合盖的笔记本不会产生一个不是用户造成的错误横幅，只是停止更新。
- **HTML/CSS/JS 三处都没有 `position: absolute` 的浮窗**：`main` 面板是布局里的一列。

## 本仓库自身的 CI/CD

它自己也用同一套：[`ci.yml`](.github/workflows/ci.yml) 每次 push 跑 [`tests/host-checks.mjs`](tests/host-checks.mjs)（29 条离线检查，覆盖入口校验/配置夹取/降级路径）并真造一个发布包，[`release.yml`](.github/workflows/release.yml) 在 `v*` tag 上构建并上传 Release。发布流程见 [RELEASING.md](RELEASING.md)。

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

## License

MIT，见 [LICENSE](LICENSE)。
