# dsh-plugin-cicd（发布台）

把 **GitHub Actions 的持续构建与发布**搬进 DeepSeek Harness：侧边栏一个图标，点开是一个占满主区域的独立面板。

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

## 配置：仓库列表是可配置的

包本身**不带仓库列表**。哪些仓库被监视是部署状态，不是包状态——把某个人的私有仓库名打包进公开包，每个安装者都得先去拆它。所以列表写在 profile 的 `cordis.patch.yml`（它在包自带的 patch 之后应用，会覆盖它）：

```yaml
- id: dsh-plugin-cicd
  config:
    owner: SOH4C4759
    ghPath: 'C:\Program Files\GitHub CLI\gh.exe'   # 可选，默认从 PATH 与常见安装位置解析
    repos:
      - repo: dsh-plugin-restart
        localPath: 'F:\CodeProj\dsh-plugin-restart'
      - repo: dsh-ui-sound
        localPath: 'F:\CodeProj\dsh-ui-sound'
      - repo: someone-else/their-plugin            # 直接写 "owner/name" 也可以
```

选项（每个都有默认值，只写你要改的）：

| 键 | 默认 | 含义 |
|---|---|---|
| `owner` | `''` | 裸 `repo` 名用的 GitHub 账号；写全 `owner/name` 时可不填 |
| `repos` | `[]` | 字符串，或 `{ repo, localPath?, label? }`；`localPath` 必须是绝对路径 |
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
