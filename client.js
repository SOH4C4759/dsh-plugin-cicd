/**
 * Browser half of the `dsh-plugin-cicd` bundle — 发布台 (Release Console).
 *
 * Three registrations:
 *   main                 the operating view: one compact row per repository
 *   sidebar.panellist    its sidebar button
 *   settings.section     「GitHub 账户」: sign-in, scopes, and the repository list
 *
 * The layout rule is density. This panel's job is to answer "which of my
 * repositories needs attention" at a glance, and a card per repository with a
 * path line, a run line and a release list answers it in three screens instead of
 * one. So a row is ~32px and carries only what is actionable; everything else
 * (path, releases, run history, logs) lives in the row's expansion.
 *
 * Nothing here requires a terminal. Signing in runs `gh auth login --web` from the
 * Host and renders the one-time code; registering a repository is a tick on a list
 * fetched from GitHub. The commands still exist — `configure.mjs` is the scripted
 * path, and the setup block shows them collapsed — but they are the fallback, not
 * the instruction.
 *
 * Deliberate choices:
 *   - No Harness Client package is required; only `react`, which is a platform
 *     seed word in the client module table.
 *   - The stylesheet is tagged `data-plugin`/`data-plugin-css` so the loader's
 *     claimStyles/removeOwnedStyles cannot take it over or delete it.
 *   - A failed BACKGROUND poll never clears the last known state and never raises
 *     a banner: it stops updating, so a sleeping machine produces no error the
 *     user did not cause.
 *   - Colours come only from `--dsw-alias-*`, so both themes stay legible.
 *   - Publishing a draft is public and one-way, so it takes two clicks.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-cicd',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-cicd'
    /** Sidebar entry id and `main` slot key — the same value links the two. */
    const PANEL_ID = 'dsh-cicd'
    /** Settings page id. `account` is a shipped section, so this must not reuse it. */
    const SETTINGS_ID = 'github-account'
    /** npm's own settings page; a second fresh id for the same reason. */
    const NPM_SETTINGS_ID = 'npm-credentials'
    /** And the third: the Bilibili update notes. Same rule, another fresh id. */
    const BILIBILI_SETTINGS_ID = 'bilibili-announce'
    const STYLE_ID = 'dsh-plugin-cicd-styles'

    const BASE = '/api/dsh-cicd'
    /**
     * The pages a first npm credential needs.
     *
     * Two of these come from GitHub's own migration note for the November 2025 npm
     * token change, which is also where the fact that classic tokens are gone was
     * confirmed — a guide that guessed at either would send a first-time publisher
     * somewhere that no longer exists.
     */
    const NPM_SIGNUP_URL = 'https://www.npmjs.com/signup'
    const NPM_TOKENS_URL = 'https://www.npmjs.com/settings/~/tokens'
    const NPM_TOKEN_DOCS_URL = 'https://docs.npmjs.com/creating-and-viewing-access-tokens'
    /**
     * The Host protocol this page needs.
     *
     * A page refresh replaces this file but not the Host process, so a route can
     * be missing while the button that calls it is on screen. Comparing this
     * number turns that into one sentence instead of a bare HTTP status.
     */
    const PROTOCOL = 6
    const STATUS_TIMEOUT_MS = 20_000
    const OVERVIEW_TIMEOUT_MS = 60_000
    const ACTION_TIMEOUT_MS = 45_000
    /**
     * An update downloads a release tarball and then runs pnpm against the profile.
     * Both are seconds of real work on a machine that is doing nothing else, and the
     * first pnpm run after a store change is the slow one — so this action gets its
     * own, longer bound instead of borrowing the 45 s the dispatch actions use.
     */
    const UPDATE_TIMEOUT_MS = 180_000
    /**
     * Asking npm is one HTTPS request per repository plus a `whoami`; a publish
     * uploads the tarball. Neither is an "action" a person waits on twice, so the
     * status gets a short bound and the publish shares the update's long one.
     */
    const NPM_TIMEOUT_MS = 45_000
    const NOTICE_TTL_MS = 5_000
    /**
     * While an attempt is pending this polls `/auth-state` — and it is the only
     * thing the user is waiting for at that moment. One second rather than two: the
     * code normally exists within a second of the click, this is a loopback call,
     * and it stops as soon as the attempt settles.
     */
    const AUTH_POLL_MS = 1_000

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'panel': 'DSH 插件发布台',
      'title': 'DSH 插件发布台',
      'subtitle': '持续构建与发布（CI/CD）',
      'settings.label': 'GitHub 账户',
      'settings.title': 'GitHub 账户',
      'settings.subtitle': '发布台用这台机器上的 gh 访问 GitHub，插件自己不保存任何凭据。',
      'action.refresh': '刷新',
      'action.manage': '管理仓库',
      'action.close': '收起',
      'action.build': '构建',
      'action.release': '发布',
      'action.bumpRelease': '升版本并发布',
      'action.publishDraft': '公开草稿',
      'action.confirmPublish': '确认公开？',
      'action.update': '更新到 {tag}',
      'action.installRelease': '装 Release {tag}',
      'action.confirmUpdate': '确认更新',
      'action.restartNow': '立即重启 DSH',
      'action.restartLater': '稍后',
      'action.open': '打开',
      'action.logs': '日志',
      'action.hideLogs': '收起日志',
      'action.rerun': '重跑',
      'action.cancel': '取消',
      'action.expand': '详情',
      'action.collapse': '收起',
      'action.add': '添加',
      'action.remove': '移除',
      'action.signIn': '用浏览器登录 GitHub',
      'action.recheck': '重新检测',
      'action.grantScopes': '补齐权限',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.openDevicePage': '打开授权页面',
      'action.cancelSignIn': '取消登录',
      'action.signOut': '退出登录',
      'action.signOutConfirm': '确认退出登录？',
      'state.signedOut': '已退出登录：令牌已从系统凭据存储移除。注意 git 推送会随之失效（git 的凭据本来就由 gh 提供），重新登录后恢复。',
      'label.runs': '运行记录',
      'chip.published': '已发布',
      'chip.unpublished': '未发布',
      'chip.draft': '草稿',
      'chip.versionTaken': '版本被占用',
      'chip.update': '可更新 {tag}',
      'chip.checkout': '本地检出',
      'chip.dirty': '未提交 {count}',
      'chip.ahead': '领先 {count}',
      'chip.behind': '落后 {count}',
      'chip.private': '私有',
      'state.loading': '正在读取…',
      'state.reading': '读取中…',
      'state.hostGone': '无法连接 Host；面板会保留上一次的数据，稍后自动重试。',
      'state.timeout': '请求超时，Host 没有在时限内回答。',
      'stale.title': '页面与宿主半边版本不一致',
      'stale.text': '页面已经是最新的，但运行中的宿主半边还是旧版本——它里面没有这条接口，所以按钮会报 401/404。刷新页面不会更新宿主。',
      'stale.how': '点侧边栏底部的一键重启（或重启 DeepSeek Harness）之后，两半就一致了。',
      'state.noRuns': '还没有运行记录',
      'state.noReleases': '还没有 Release',
      'state.dispatched': '已触发 {workflow}（{repo}）。',
      'state.releaseDispatched': '已触发发布流程（{repo}）。它产出的是草稿——但草稿是否真的出现，要看这次运行的结果：失败时展开该行点【日志】就能看到原因（最常见的是版本号没升）。',
      'state.releaseBumped': '已把 {from} 升到 {tag} 并推送 {branch}，发布流程也已触发。产出的是草稿，是否成功看这次运行的结果。',
      'state.published': '{tag} 已公开。',
      'state.rerun': '已请求重跑。',
      'state.cancelled': '已请求取消。',
      'state.actionFailed': '操作失败：{reason}',
      'state.registered': '已添加 {repo}。',
      'state.removed': '已移除 {repo}。',
      'state.truncated': '（只显示最后 {lines} 行）',
      'drafts.title': '有 {count} 个草稿还没公开',
      'drafts.text': '草稿对外不可见，也不创建 tag，所以在仓库的 Releases 页面看不到——这不是失败。展开下面带【草稿】标记的行，点【公开草稿】即可公开发布。',
      'meta.account': '账号',
      'meta.updated': '更新于 {time}',
      'meta.cached': '缓存',
      'meta.version': '本地',
      'meta.expectedTag': '期望 tag {tag}',
      'meta.noLocal': '未配置本地路径，无法对比本地状态',
      'meta.assets': '{count} 个资产',
      'meta.path': '路径',
      'meta.scopes': '权限',
      'meta.noScopes': '（gh 未报告权限列表）',
      'meta.gh': 'gh',
      'meta.configFrom': '配置来源',
      'meta.projectsRoot': '本地检出根目录',
      'meta.projectsRootUnset': '未设置，添加仓库时无法自动找到本地检出',
      'run.unknown': '未知',
      'release.takenTitle': '发布前检查：这个版本号已经属于另一个提交',
      'release.taken': '{tag} 已属于 {owner}，而这次发布会构建 {built}——release.yml 会拒绝覆盖属于另一个提交的同号 Release（否则 tag 与资产会不一致），所以直接发布必然失败。先把它升到 {next} 再发布。',
      'release.takenNoNext': '{tag} 已属于 {owner}，而这次发布会构建 {built}——release.yml 会拒绝覆盖属于另一个提交的同号 Release，所以直接发布必然失败。先把版本号升到下一号。',
      'release.dirtyNote': '工作区有 {count} 个未提交改动：发布构建的是已推送的提交，这些改动不会进入发布包（升版本也会因此被拒绝）。',
      'release.aheadNote': '有 {count} 个提交还没推送：发布构建的是远端分支，推送之前它们不会进入发布包。',
      'release.dirty': '工作区有 {count} 个未提交改动，先提交或暂存它们。',
      'release.noUpstream': '分支 {branch} 没有上游，无法推送。',
      'release.behind': '分支落后上游 {count} 个提交，先拉取再发布。',
      'release.noCheckout': '这个仓库没有可用的本地检出（找不到 package.json）。',
      'release.noVersion': '本地读不到可升级的版本号。',
      'release.pushFailed': '本地已提交 {tag}，但推送失败：{reason}（提交还在本地，重试推送即可）',
      'release.carried': '这次推送同时带上了此前未推送的 {count} 个提交。',
      'confirm.bumpRelease': '把 package.json 从 {from} 升到 {to}、提交并推送到 {branch}，然后触发发布？这会创建一个提交。',
      'confirm.publish': '公开发布 {tag}？发布后任何人可见，无法收回。',
      'confirm.cancel': '再想想',
      'confirm.update': '把 {profile} profile 里的 {package}（现在指向 {spec}）换成 Release {tag} 的 tgz 并重装？这会改写该 profile 的依赖条目。',
      'install.title': '安装',
      'install.notInstalled': '{package} 不在 {profile} profile 的依赖里，所以没有"已装的那份"可以更新。',
      'install.noRelease': '这个仓库还没有已发布的 Release（草稿不算），所以没有可以装的东西。',
      'install.current': 'profile 里就是 Release {tag} 的包，已经是最新的。',
      'install.checkout': 'profile 里这份指向本地检出（{spec}），跑的不是发布出去的那份。装 Release 会用发布包替换它；要回到开发状态再用 dsh plugin add link:<检出路径> 换回来。',
      'install.ahead': 'profile 里是 v{installed}，比这个 Release（{tag}）新——装它等于用发布包退回到旧版本。',
      'install.differs': 'profile 里是 {installed}，与 Release {tag} 不是同一号版本，无法比较先后。',
      'state.updated': '{package} 已从 {from} 换成 {tag} 的发布包。新版本要重启 DSH 才会真正生效。',
      'state.updatedSame': '{package} 已经指向 {tag} 这份发布包了：没有改动，也不需要重启。',
      'npm.title': 'npm',
      'npm.chipPublished': 'npm v{version}',
      'npm.chipPending': 'npm 待推 v{version}',
      'npm.chipUnregistered': 'npm 上还没有',
      'npm.account': 'npm {account}',
      'npm.registry': '源 {registry}',
      'npm.recheck': '重新检测 npm',
      'npm.notLoggedIn': '{command} 还没有登录 {registry}——发布需要 npm 的凭据，而插件自己不保存 token。下面是从零开始的四步。',
      'npm.guide.step1': '① 还没有 npm 账号？',
      'npm.guide.signup': '打开 npmjs.com 注册',
      'npm.guide.emailNote': '注册后**必须**到邮箱点确认链接：npm 不允许未验证邮箱的账号发布。',
      'npm.guide.step2': '② 生成一个 Access Token',
      'npm.guide.tokens': '打开 token 页面',
      'npm.guide.tokenType': '类型只有一种可选：Granular Access Token。Classic token 已于 2025-11-19 被 npm 全部撤销，现在也建不出来——别去找它。',
      'npm.guide.tokenScope': 'Permissions 选 Read and write；Packages 选全部，或只勾这个包（只勾一个包更安全）。',
      'npm.guide.tokenExpiry': '有效期最长 90 天，这是 npm 对可写 token 的硬限制。到期后 token 就失效了，回到第 ② 步再生成一个。',
      'npm.guide.token2fa': '只有"给 CI 用、没有人能输一次性密码"时才勾 Bypass 2FA。在这里推**不要勾**：推送时面板会让你填一次性密码。',
      'npm.guide.blocked': '如果 npmjs.com 在你这台机器上打不开，或者被"我不是机器人"的验证拦住：**换一台设备或换一个网络**（手机流量最省事）打开 npmjs.com 生成 token，再把那串字符粘到第 ③ 步。面板只认这个 token，不在乎它是在哪里生成的——这一步和你本机的浏览器无关。',
      'npm.guide.step3': '③ 粘贴到下面',
      'npm.guide.step3Note': '它会写进 {npmrc}（npm 自己读的用户级配置文件，其他行原样保留）；插件不保存 token，请求一返回输入框就清空。',
      'npm.guide.step4': '④ 账号开了 2FA？',
      'npm.guide.step4Note': '推送的确认行里会出现一次性密码输入框，填 6 位数字再点一次【确认推送】即可。',
      'npm.guide.docs': 'npm 官方文档',
      'npm.stepUnknown': '无法自动检测',
      'npm.stepTodo': '待做',
      'npm.stepAccountDone': '✓ 已有账号 {account}',
      'npm.stepTokenDone': '✓ 已有可用的 token',
      'npm.stepWrittenDone': '✓ {npmrc} 里已有凭据',
      'npm.status.title': '凭据状态',
      'npm.status.signedIn': '已登录 {account}',
      'npm.status.credentialPresent': '已有凭据，whoami 未确认',
      'npm.status.none': '还没有凭据',
      'npm.status.unknown': '还没读到 npm 的状态',
      'npm.status.unknownHint': 'Host 还没回答 /npm-status（可能是运行中的宿主半边还是旧版本，也可能面板刚打开）。点「重新检测」。在没有答案之前，这里不替你下结论。',
      'npm.packages.title': '每个包在 npm 上的状态',
      'npm.packages.empty': '还没有登记仓库，所以没有可检查的包。',
      'npm.packages.recheck': '重新检测',
      'npm.package.published': '已在 npm 上',
      'npm.package.unpublished': '待推',
      'npm.package.unregistered': '名字空闲',
      'npm.package.unknown': '读不到',
      'npm.package.local': '本地 {version}',
      'npm.package.latest': 'npm 上是 {latest}',
      'npm.credentialPresentShort': '.npmrc 里已经有 {registry} 的凭据，但 whoami 没有确认它——granular token 是包级范围的，whoami 是用户级端点，这很正常。直接推即可，真伪由推送来判。',
      'npm.moreInSettings': '完整引导与每个包的状态在 设置 → npm 凭据。',
      'npm.ciHint': '要给 CI 自动发布？那不该用这里的 token——npm 支持 trusted publishing（GitHub Actions OIDC），不需要任何长期凭据。',
      'settings.npmLabel': 'npm 凭据',
      'settings.npmTitle': 'npm 凭据',
      'settings.npmSubtitle': '发布用 Host 自己的包管理器，凭据走 npm 自己读的 ~/.npmrc——插件不保存任何 token。',
      'settings.npmGuideTitle': '从零开始的四步',
      'npm.credentialPresentTitle': '这个源上已经有一行 token',
      'npm.credentialPresent': '.npmrc 里已经有 {registry} 的凭据，但 whoami 没有确认它。granular token 是包级范围的，而 whoami 是用户级端点——它拒绝一个能正常发布的 token 是正常的。所以推送本身才是真正的验证：直接推，失败时下方会告诉你是要填一次性密码、还是重建 token。',
      'npm.rejectedTitle': '这个 token 没有被接受。按顺序排查：',
      'npm.rejectedCauses': '① 复制不全（前后带了空格或换行）；② 权限不是 Read and write；③ 已被撤销、或超过 90 天有效期；④ token 被限制到别的包或组织；⑤ 账号邮箱还没验证。',
      'npm.hint.otp-required': '这个账号要求一次性密码：在推送的确认行里填 6 位数字，再点一次【确认推送】。',
      'npm.hint.email-unverified': '先去邮箱点确认链接——npm 不允许未验证邮箱的账号发布——然后回来重试。',
      'npm.hint.not-logged-in': 'token 无效、过期或已被撤销：照上面第 ② 步重新生成一个（可写 token 最长 90 天）。',
      'npm.hint.already-published': '这个版本已经在 npm 上了。npm 不接受同一版本推两次：先用【升版本并发布】升版本，再推。',
      'npm.hint.payment-required': 'npm 对私有包收费，公开包免费。检查 package.json 里有没有 private 字段、以及发布的是不是公开包。',
      'npm.hint.forbidden': '这个 token 没有被授权发布这个包：检查 token 的 Packages 范围，以及包名是否属于你的账号或组织。',
      'npm.hint.not-found': '源上没有这个包名可发布的位置：确认包名拼写、以及账号或组织名。',
      'npm.hint.rate-limited': '被源限流了，等几分钟再试。',
      'npm.hint.registry-error': '这是源自己出错（5xx），不是你配置的问题，稍后重试。',
      'npm.hint.network': '连不上源：检查网络或代理设置。',
      'npm.hint.timeout': '推送超过时限还没结束：可能是网络慢，也可能源在等你回答什么。重试一次，仍失败就看下面的原话。',
      'npm.hint.unknown': '没识别出具体原因，看下面 npm 的原话。',
      'npm.tokenPlaceholder': 'npm_… 或粘贴 Access Token',
      'npm.writeToken': '写入并验证',
      'npm.tokenWritten': 'token 已写入 {npmrc}，当前账号 {account}。',
      'npm.npmrcPath': '配置文件',
      'npm.state.published': '这个版本已经在 npm 上了（{version}），没有可推的。',
      'npm.state.unregistered': 'npm 上还没有这个名字：这次推送就是它的首次发布。',
      'npm.state.unpublished': 'npm 上是 {latest}，本地这个 {version} 还没推过。',
      'npm.state.unknown': '读不到 npm 的状态（{reason}），所以不提供推送——宁可不给按钮，也不给一个注定失败的按钮。',
      'npm.action.publish': '推送到 npm v{version}',
      'npm.action.confirm': '确认推送',
      'npm.otpLabel': '一次性密码',
      'npm.otpHint': '账号开了 2FA 才需要；填一次即可，不会被保存。',
      'npm.otpPlaceholder': '6 位数字',
      'npm.blocked.private-package': 'package.json 里写着 "private": true，npm 会拒绝。这是作者的决定，不是这里该绕过的东西。',
      'npm.blocked.not-logged-in': '还没有登录 npm，先把 token 写进去。',
      'npm.blocked.dirty-tree': '工作区有未提交改动：publish 打包的是工作目录，先提交或暂存（files 白名单挡不住名单目录里的新文件）。',
      'npm.blocked.no-checkout': '这个仓库没有可用的本地检出。',
      'npm.blocked.no-version': 'package.json 里没有版本号。',
      'npm.blocked.no-package-name': '读不到包名。',
      'npm.blocked.already-published': '这个版本已经在 npm 上了（npm 不允许同一版本推第二次），先升版本。',
      'npm.blocked.registry-unreachable': '连不上 npm 源，无法确认这个版本在不在。',
      'confirm.npmPublish': '把 {package}@{version} 推到 {registry}？npm 不允许同一版本推第二次，撤回也只在很短的时间内可行——推上去任何人可见。',
      'state.npmPublished': '已把 {package}@{version} 推到 {registry}。',
      'state.npmFirstPublish': '{package}@{version} 已首次发布到 {registry}。',
      'npm.githubDraft': '注意：GitHub 上这个版本只有草稿（或还没有 Release）——npm 会先于 Release 面世。',
      'state.updatedBuilds': '（注意：这次安装有 {count} 个构建脚本被拦住，没有执行。）',
      'restart.ask': '{package} 已经更新到 {tag}，但要重启 DSH 才会用上它——现在重启？',
      'restart.scheduled': '已安排重启：DSH 会在一两秒后关闭并自动重新打开。刷新页面不够，模块已经加载在运行中的进程里。',
      'restart.unavailable': '重启不了：{reason}',
      'setup.needGh': '没有找到 gh CLI，发布台无法访问 GitHub。',
      'setup.needSignIn': '还没有登录 GitHub。登录后这里会列出你的仓库。',
      'setup.needScopes': '当前凭据缺少权限：{scopes}。',
      'setup.scopeHint': '缺 repo 读不到私有仓库，缺 workflow 无法触发构建。',
      'setup.needRepos': '还没有登记仓库。',
      'setup.codeHint': '在浏览器里打开下面的地址，输入这个一次性代码：',
      'setup.waiting': '等待授权…（在浏览器里完成即可，这里会自动继续）',
      'setup.requestingCode': '正在向 GitHub 申请一次性码…',
      'setup.codePending': '授权页面已打开——请把下面出现的码输入进去。码还没到，稍等一下它就会出现。',
      'setup.stalled': '已等待 {seconds} 秒仍没有一次性码：{detail}。最常见的原因是 github.com 不可达（面板读取仓库用的 api.github.com 是另一条线路，可能仍然正常）。你可以继续等——网络恢复后码会自己出现——也可以取消后重试。',
      'setup.stalledNoOutput': 'gh 完全没有输出',
      'setup.stalledQuietOutput': 'gh 只输出了空白内容（通常在重试连接）',
      'setup.stalledSaid': 'gh 说：{text}',
      'setup.unreachableTitle': 'github.com 当前连不上',
      'setup.unreachable': '提示：从本机连不上 github.com:443，而设备码流程需要它——如果一直不出码，多半是这个原因。gh 已经在尝试；若它其实能连上（例如走代理），码仍会出现。',
      'setup.dnsTitle': 'DNS 解析 github.com 失败',
      'setup.dns': '提示：本机解析不出 github.com 的地址，而地址本身是通的（实测直连它的 IP 只需几十毫秒）。gh 也要自行解析域名，所以它连请求都发不出去，这就是一直不出码的原因。换个 DNS 或稍后重试即可；gh 已在尝试，解析一恢复码就会出现。',
      'setup.succeeded': '授权成功，正在读取账号…',
      'setup.failed': '授权未完成：{reason}',
      'setup.expired': '一次性代码已过期，请重新开始。',
      'setup.cancelled': '已取消登录。',
      'setup.advanced': '用命令行配置（可选）',
      'setup.ghInstall': '安装 GitHub CLI（任选其一）',
      'picker.title': '添加仓库',
      'picker.search': '搜索仓库',
      'picker.empty': '没有可添加的仓库（可能是没登录，或账号下没有仓库）。',
      'picker.loading': '正在读取你的仓库…',
      'picker.failed': '读取仓库列表失败：{reason}',
      'picker.local': '本地检出',
      'picker.noLocal': '未找到本地检出',
      'picker.hint': '勾选即添加，取消勾选即移除；改动立刻生效，不需要重启。',
      'picker.reload': '重新载入',

      /* -- Bilibili update notes ------------------------------------------- */
      'bili.settings.label': 'B 站播报',
      'bili.settings.title': 'B 站更新播报',
      'bili.settings.subtitle': '插件发版后，在对应视频的评论区自动补一条更新说明；凭据只落在插件自己的目录里，插件不回显它。',
      'bili.credential.title': '登录状态',
      'bili.credential.ready': '已登录 {uname}',
      'bili.credential.none': '还没有 B 站凭据',
      'bili.credential.unreadable': '凭据读不出来',
      'bili.credential.incomplete': '凭据不完整',
      'bili.credential.not-logged-in': '这份凭据发不了评论',
      'bili.credential.unverified': '还没有验证这份凭据',
      'bili.credential.none.hint': '发评论走的是 B 站 Web 接口，所以凭据必须是网页登录。biliup 默认写下的 cookies.json 是 APP/TV 登录（platform=BiliTV），Web 会员接口一律回 -101「账号未登录」——它能投稿，但发不了评论。',
      'bili.credential.source': '凭据文件 {path}',
      'bili.credential.external': '这份凭据来自配置指定的外部文件（不是面板写入的）：{path}',
      'bili.signIn': '登录 B 站',
      'bili.signIn.hint': '点一下会生成一个登录链接：用手机 B 站扫码，或在你已经登录 B 站的浏览器里打开并确认。这里会自动继续，不需要终端。',
      'bili.openLogin': '打开登录页面',
      'bili.waiting': '等待扫码…',
      'bili.waitingScanned': '已扫码，请在手机上确认…',
      'bili.signIn.done': '已登录：{uname}',
      'bili.signIn.doneNoName': '已登录，但没能读到账号名。',
      'bili.signIn.expired': '二维码已过期，重新点一次【登录 B 站】。',
      'bili.cancelSignIn': '取消登录',
      'bili.paste.title': '或者粘贴一次',
      'bili.paste.hint': '浏览器里 F12 → Application → Cookies → bilibili.com，复制 SESSDATA 与 bili_jct（后者就是 csrf）。只写进插件自己的文件，验证通过才保存。',
      'bili.paste.sessdata': 'SESSDATA',
      'bili.paste.csrf': 'bili_jct',
      'bili.paste.save': '保存并验证',
      'bili.paste.saved': '凭据已保存：{uname}',
      'bili.signOut': '退出 B 站登录',
      'bili.signOut.confirm': '确认退出？',
      'bili.signOut.done': '已删除插件保存的 B 站凭据。',
      'bili.signOut.fallback': '注意：还有一份外部凭据继续生效（{path}），它属于别的工具，这里没有动它。',
      'bili.bind.title': '绑定的视频',
      'bili.chip.announced': '已播报 {tag}',
      'bili.chip.pending': '待播报 {tag}',
      'bili.bind.placeholder': 'BV 号，如 BV1RopP6FEJp',
      'bili.bind.save': '绑定',
      'bili.bind.unbind': '解绑',
      'bili.bind.done': '已绑定 {bvid}{baseline}',
      'bili.bind.baseline': '（基线 {tag}：只有之后发布的新版本会自动播报）',
      'bili.bind.baselineUnknown': '（读不到 Release 列表，绑定时刻之前的版本都按已公开处理）',
      'bili.unbound.done': '已解绑 {repo} 的 B 站视频，播报记录保留。',
      'bili.auto.on': '自动播报',
      'bili.auto.off': '仅手动',
      'bili.auto.toggle': '切换自动播报',
      'bili.announce': '发更新评论',
      'bili.announce.again': '已播报过，重新预览',
      'bili.announce.preview': '将发送这条评论',
      'bili.announce.confirm': '确认发送',
      'bili.announce.force': '仍然发送',
      'bili.announce.cancel': '取消',
      'bili.announce.sent': '已发送到 {bvid} 的评论区（{tag}）。',
      'bili.announce.previewFailed': '预览失败：{reason}',
      'bili.repo.none': '这个仓库还没有绑定 B 站视频。',
      'bili.state.already': '{tag} 已经播报过了。',
      'bili.state.baseline': '{tag} 在绑定视频之前就已经发布了，不算这次更新。',
      'bili.state.no-release': '还没有已公开的 Release（草稿不算）——先在发布台把草稿公开。',
      'bili.state.gave-up': '这条已经失败 {count} 次，先看看原因再手动重试。',
      'bili.state.unbound': '这个仓库还没有绑定 B 站视频。',
      'bili.needCredential': '有仓库绑定了 B 站视频，但还没有可用的 B 站凭据，更新评论发不出去。',
      'bili.openSettings': '在 设置 → B 站播报 里管理',
      'bili.lastSweep': '自动巡检 {time}：{summary}',
      'bili.sweep.none': '还没有需要播报的新版本',
      'bili.sweep.announced': '已播报 {repo} {tag}',
      'bili.sweep.failed': '{repo} {tag} 播报失败',
      'bili.neverSwept': '自动巡检还没有跑过',
      'bili.ledger.problem': '播报记录读不出来（{problem}）。在修好之前不会发送任何评论——否则会把已经发过的评论再发一遍。',
      'bili.template': '模板',
      'bili.template.hint': '可用占位符：{tag} {version} {label} {repo} {title} {summary} {url} {date}。默认不含链接，因为带链接的评论更容易被 B 站过滤。',
      'bili.unknownPlaceholder': '模板里有不认识的占位符：{names}',
      'bili.video.failed': '读不到视频：{reason}',
      'bili.watch.off': '自动巡检已关（bilibiliWatchSeconds: 0），只剩手动按钮与公开草稿后的那一次。',
      'bili.repos.title': '每个仓库',
      'bili.repos.empty': '还没有登记仓库。',
      'bili.announced.title': '已播报',
      'bili.announced.none': '还没有播报过。',
      'bili.failure.last': '上次失败：{message}',
    }

    /** English dictionary, same key set. */
    const en = {
      'panel': 'DSH Plugin CI/CD',
      'title': 'DSH Plugin CI/CD',
      'subtitle': 'Continuous builds and releases for DSH plugins',
      'settings.label': 'GitHub account',
      'settings.title': 'GitHub account',
      'settings.subtitle': 'The console reaches GitHub through the gh CLI on this machine; the plugin stores no credential of its own.',
      'action.refresh': 'Refresh',
      'action.manage': 'Repositories',
      'action.close': 'Done',
      'action.build': 'Build',
      'action.release': 'Release',
      'action.bumpRelease': 'Bump and release',
      'action.publishDraft': 'Publish',
      'action.confirmPublish': 'Publish?',
      'action.update': 'Update to {tag}',
      'action.installRelease': 'Install release {tag}',
      'action.confirmUpdate': 'Update',
      'action.restartNow': 'Restart DSH now',
      'action.restartLater': 'Later',
      'action.open': 'Open',
      'action.logs': 'Logs',
      'action.hideLogs': 'Hide logs',
      'action.rerun': 'Re-run',
      'action.cancel': 'Cancel',
      'action.expand': 'Details',
      'action.collapse': 'Less',
      'action.add': 'Add',
      'action.remove': 'Remove',
      'action.signIn': 'Sign in with a browser',
      'action.recheck': 'Re-check',
      'action.grantScopes': 'Grant scopes',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.openDevicePage': 'Open the authorization page',
      'action.cancelSignIn': 'Cancel sign-in',
      'action.signOut': 'Sign out',
      'action.signOutConfirm': 'Confirm sign out?',
      'state.signedOut': 'Signed out: the token was removed from the operating system credential store. git push stops working until you sign in again — git takes its credential from gh.',
      'label.runs': 'Runs',
      'chip.published': 'Released',
      'chip.unpublished': 'Unreleased',
      'chip.draft': 'Draft',
      'chip.versionTaken': 'version taken',
      'chip.update': 'update {tag}',
      'chip.checkout': 'local checkout',
      'chip.dirty': '{count} uncommitted',
      'chip.ahead': '{count} ahead',
      'chip.behind': '{count} behind',
      'chip.private': 'private',
      'state.loading': 'Loading…',
      'state.reading': 'reading…',
      'state.hostGone': 'Cannot reach the Host; the panel keeps the last known data and retries on its own.',
      'state.timeout': 'The request timed out without an answer from the Host.',
      'stale.title': 'The page and the Host half are different versions',
      'stale.text': 'This page is current, but the running Host half is older and does not have this route, so the buttons answer 401/404. Refreshing the page does not replace the Host.',
      'stale.how': 'Use the one-click restart at the foot of the sidebar (or restart DeepSeek Harness) and the two halves match again.',
      'state.noRuns': 'no runs yet',
      'state.noReleases': 'no releases yet',
      'state.dispatched': 'Triggered {workflow} on {repo}.',
      'state.releaseDispatched': 'Release workflow triggered for {repo}. It produces a DRAFT — but whether a draft actually appears depends on that run: if it fails, expand the row and press Logs to see why (a stale version number is the usual reason).',
      'state.releaseBumped': 'Bumped {from} to {tag} and pushed {branch}; the release workflow is triggered. It produces a draft, and whether it succeeds depends on that run.',
      'state.published': '{tag} is public now.',
      'state.rerun': 'Re-run requested.',
      'state.cancelled': 'Cancellation requested.',
      'state.actionFailed': 'The action failed: {reason}',
      'state.registered': 'Added {repo}.',
      'state.removed': 'Removed {repo}.',
      'state.truncated': '(showing the last {lines} lines)',
      'drafts.title': '{count} draft(s) not published yet',
      'drafts.text': 'A draft is invisible to everyone else and creates no tag, so it does not appear on the repository Releases page — that is not a failure. Expand the rows marked Draft below and press Publish to make one public.',
      'meta.account': 'Account',
      'meta.updated': 'Updated {time}',
      'meta.cached': 'cached',
      'meta.version': 'local',
      'meta.expectedTag': 'expected tag {tag}',
      'meta.noLocal': 'no local path, so local state cannot be compared',
      'meta.assets': '{count} assets',
      'meta.path': 'Path',
      'meta.scopes': 'Scopes',
      'meta.noScopes': '(gh reported no scope list)',
      'meta.gh': 'gh',
      'meta.configFrom': 'Config from',
      'meta.projectsRoot': 'Checkout root',
      'meta.projectsRootUnset': 'not set, so adding a repository cannot find its local checkout',
      'run.unknown': 'unknown',
      'release.takenTitle': 'Release preflight: this version already belongs to another commit',
      'release.taken': '{tag} was created from {owner}, but this release would build {built} — release.yml refuses to overwrite a release of the same version that belongs to another commit (the tag and its assets would disagree), so dispatching now cannot succeed. Bump it to {next} first.',
      'release.takenNoNext': '{tag} was created from {owner}, but this release would build {built} — release.yml refuses to overwrite a release of the same version that belongs to another commit, so dispatching now cannot succeed. Bump the version first.',
      'release.dirtyNote': '{count} uncommitted change(s): a release builds the commit that was pushed, so these files would not be in the published package (and a version bump is refused for the same reason).',
      'release.aheadNote': '{count} commit(s) not pushed yet: a release builds the remote branch, so they would not be in the published package until they are pushed.',
      'release.dirty': 'The checkout has {count} uncommitted change(s); commit or stash them first.',
      'release.noUpstream': 'Branch {branch} has no upstream to push to.',
      'release.behind': 'The branch is {count} commit(s) behind its upstream; pull before releasing.',
      'release.noCheckout': 'This repository has no usable local checkout (no package.json).',
      'release.noVersion': 'No bumpable version number was found locally.',
      'release.pushFailed': 'Committed {tag} locally, but the push failed: {reason} (the commit is still local — retry the push)',
      'release.carried': 'This push also delivered {count} commit(s) that were not pushed before.',
      'confirm.bumpRelease': 'Bump package.json from {from} to {to}, commit it, push {branch}, then trigger the release? This creates a commit.',
      'confirm.publish': 'Publish {tag} publicly? Once published, anyone can see it.',
      'confirm.cancel': 'Not yet',
      'confirm.update': 'Replace {package} in the {profile} profile (currently {spec}) with the tgz from release {tag} and reinstall? This rewrites that profile dependency.',
      'install.title': 'Install',
      'install.notInstalled': '{package} is not a dependency of the {profile} profile, so there is no installed copy to update.',
      'install.noRelease': 'This repository has no published release yet (a draft does not count), so there is nothing to install from.',
      'install.current': 'The profile already holds the package from release {tag}; it is current.',
      'install.checkout': 'This copy points at a local checkout ({spec}), so it is not the code anyone downloaded. Installing the release replaces it; switch back with dsh plugin add link:<checkout path>.',
      'install.ahead': 'The profile holds v{installed}, which is newer than this release ({tag}) — installing it would move backwards to the published copy.',
      'install.differs': 'The profile holds {installed}, which is not the same version number as release {tag}, so the two cannot be ordered.',
      'state.updated': '{package} was replaced with the release package {tag}. The new version takes effect only after DSH restarts.',
      'state.updatedSame': '{package} already points at the {tag} release package: nothing changed, and no restart is needed.',
      'npm.title': 'npm',
      'npm.chipPublished': 'npm v{version}',
      'npm.chipPending': 'npm v{version} pending',
      'npm.chipUnregistered': 'not on npm',
      'npm.account': 'npm {account}',
      'npm.registry': 'registry {registry}',
      'npm.recheck': 'Re-check npm',
      'npm.notLoggedIn': '{command} is not signed in to {registry} — publishing needs npm credentials, and this plugin stores no token of its own. Four steps, from nothing.',
      'npm.guide.step1': '(1) No npm account yet?',
      'npm.guide.signup': 'Open npmjs.com to sign up',
      'npm.guide.emailNote': 'You MUST confirm the link npm emails you: an account with an unverified email cannot publish.',
      'npm.guide.step2': '(2) Create an access token',
      'npm.guide.tokens': 'Open the token page',
      'npm.guide.tokenType': 'There is only one kind left: a Granular Access Token. Classic tokens were all revoked on 2025-11-19 and can no longer be created — do not go looking for one.',
      'npm.guide.tokenScope': 'Set Permissions to Read and write; scope Packages to everything, or to just this package (narrower is safer).',
      'npm.guide.tokenExpiry': 'The maximum lifetime is 90 days, which is npm\'s hard limit for a write token. When it expires it simply stops working; come back to step 2 and make another.',
      'npm.guide.token2fa': 'Tick Bypass 2FA only for CI, where nobody can type a one-time password. For pushing here, leave it OFF — the panel will ask for the code.',
      'npm.guide.blocked': 'If npmjs.com will not open on this machine, or an "are you a robot" check blocks it: create the token on ANOTHER device or network (a phone on mobile data is easiest) and paste the string into step 3. The panel only needs the token — where it was made makes no difference, and this step has nothing to do with this machine\'s browser.',
      'npm.guide.step3': '(3) Paste it below',
      'npm.guide.step3Note': 'It is written to {npmrc} (the user-level file npm itself reads; every other line is preserved). This plugin stores no token, and the field is cleared as soon as the request answers.',
      'npm.guide.step4': '(4) Is 2FA on the account?',
      'npm.guide.step4Note': 'The push confirmation grows a one-time password field: enter the 6 digits and press Push again.',
      'npm.guide.docs': 'npm documentation',
      'npm.stepUnknown': 'cannot be detected',
      'npm.stepTodo': 'to do',
      'npm.stepAccountDone': '✓ account {account} exists',
      'npm.stepTokenDone': '✓ a working token exists',
      'npm.stepWrittenDone': '✓ a credential is already in {npmrc}',
      'npm.status.title': 'Credential',
      'npm.status.signedIn': 'signed in as {account}',
      'npm.status.credentialPresent': 'credential present, whoami unconfirmed',
      'npm.status.none': 'no credential yet',
      'npm.status.unknown': 'npm has not answered yet',
      'npm.status.unknownHint': 'The Host has not answered /npm-status (the running Host half may be an older version, or the panel just opened). Press Re-check. Until there is an answer, this page will not draw a conclusion for you.',
      'npm.packages.title': 'Every package on npm',
      'npm.packages.empty': 'No repository is registered, so there is no package to check.',
      'npm.packages.recheck': 'Re-check',
      'npm.package.published': 'on npm',
      'npm.package.unpublished': 'pending',
      'npm.package.unregistered': 'name is free',
      'npm.package.unknown': 'unreadable',
      'npm.package.local': 'local {version}',
      'npm.package.latest': 'npm has {latest}',
      'npm.credentialPresentShort': '.npmrc already carries a credential for {registry}, but whoami would not confirm it — a granular token is scoped to packages while whoami is a user-level endpoint, so that is normal. Just push; the publish decides whether it is real.',
      'npm.moreInSettings': 'The full guide and every package\'s state live in Settings → npm credentials.',
      'npm.ciHint': 'Publishing from CI? This token is not the way — npm supports trusted publishing (GitHub Actions OIDC), which needs no long-lived credential at all.',
      'settings.npmLabel': 'npm credentials',
      'settings.npmTitle': 'npm credentials',
      'settings.npmSubtitle': 'Publishing uses the Host\'s own package manager, and the credential comes from the ~/.npmrc npm itself reads — this plugin stores no token.',
      'settings.npmGuideTitle': 'Four steps, from nothing',
      'npm.credentialPresentTitle': 'This registry already has a token line',
      'npm.credentialPresent': '.npmrc carries a credential for {registry}, but whoami would not confirm it. A granular token is scoped to PACKAGES while whoami is a user-level endpoint, so refusing a token that publishes perfectly well is normal. The publish itself is the real test: just push, and if it fails the panel says whether to enter a one-time password or make a new token.',
      'npm.rejectedTitle': 'That token was not accepted. Check, in order:',
      'npm.rejectedCauses': '(1) it was copied incompletely (leading or trailing whitespace); (2) Permissions are not Read and write; (3) it was revoked, or passed its 90-day limit; (4) it is scoped to another package or organization; (5) the account email is still unverified.',
      'npm.hint.otp-required': 'This account requires a one-time password: enter the 6 digits in the push confirmation and press Push again.',
      'npm.hint.email-unverified': 'Confirm the link npm emailed you first — an unverified email cannot publish — then try again.',
      'npm.hint.not-logged-in': 'The token is invalid, expired or revoked: make a new one as in step 2 (a write token lasts at most 90 days).',
      'npm.hint.already-published': 'This version is already on npm, which never accepts the same version twice: bump the version first, then push.',
      'npm.hint.payment-required': 'npm charges for private packages and not for public ones. Check for a private flag in package.json and whether this is meant to be public.',
      'npm.hint.forbidden': 'This token is not allowed to publish this package: check its Packages scope, and whether the name belongs to your account or organization.',
      'npm.hint.not-found': 'The registry has no publishable place for that name: check the spelling and the account or organization.',
      'npm.hint.rate-limited': 'The registry is rate-limiting you; try again in a few minutes.',
      'npm.hint.registry-error': 'The registry itself failed (5xx). That is not your configuration — try again shortly.',
      'npm.hint.network': 'The registry cannot be reached: check the network or proxy settings.',
      'npm.hint.timeout': 'The publish did not finish in time: a slow network, or the registry waiting for an answer. Retry once, and read its own words below if it fails again.',
      'npm.hint.unknown': 'No specific cause was recognised; npm\'s own words are below.',
      'npm.tokenPlaceholder': 'npm_… or paste an access token',
      'npm.writeToken': 'Write and verify',
      'npm.tokenWritten': 'The token is in {npmrc}; signed in as {account}.',
      'npm.npmrcPath': 'config file',
      'npm.state.published': 'This version is already on npm ({version}); there is nothing to push.',
      'npm.state.unregistered': 'Nobody owns this name on npm yet: this push would be its first release.',
      'npm.state.unpublished': 'npm has {latest}; the local {version} has not been pushed.',
      'npm.state.unknown': 'The npm state cannot be read ({reason}), so no push is offered — a missing button beats one that must fail.',
      'npm.action.publish': 'Push to npm v{version}',
      'npm.action.confirm': 'Push',
      'npm.otpLabel': 'One-time password',
      'npm.otpHint': 'Only needed with 2FA on the account, and it is never stored.',
      'npm.otpPlaceholder': '6 digits',
      'npm.blocked.private-package': 'package.json says "private": true, which npm refuses. That is the author\'s decision, not something to work around here.',
      'npm.blocked.not-logged-in': 'Not signed in to npm yet; write a token above first.',
      'npm.blocked.dirty-tree': 'The checkout has uncommitted changes: publish packs the working directory, so commit or stash first (the files allow-list does not protect a new file inside a listed directory).',
      'npm.blocked.no-checkout': 'This repository has no usable local checkout.',
      'npm.blocked.no-version': 'package.json has no version.',
      'npm.blocked.no-package-name': 'No package name could be read.',
      'npm.blocked.already-published': 'This version is already on npm, which never accepts the same version twice — bump the version first.',
      'npm.blocked.registry-unreachable': 'The npm registry cannot be reached, so whether this version exists is unknown.',
      'confirm.npmPublish': 'Push {package}@{version} to {registry}? npm never accepts the same version twice, and unpublishing is only possible briefly — once it is up, anyone can see it.',
      'state.npmPublished': 'Pushed {package}@{version} to {registry}.',
      'state.npmFirstPublish': '{package}@{version} is now published to {registry} for the first time.',
      'npm.githubDraft': 'Note: GitHub has only a draft (or no release) for this version — npm would go public before the Release does.',
      'state.updatedBuilds': '(Note: {count} build script(s) were blocked and did not run.)',
      'restart.ask': '{package} is updated to {tag}, but DSH has to restart to use it — restart now?',
      'restart.scheduled': 'Restart scheduled: DSH closes in a second or two and reopens by itself. Refreshing the page is not enough; the module is already loaded in the running process.',
      'restart.unavailable': 'Cannot restart: {reason}',
      'setup.needGh': 'The gh CLI was not found, so the console cannot reach GitHub.',
      'setup.needSignIn': 'Not signed in to GitHub yet. Once you are, your repositories appear here.',
      'setup.needScopes': 'The current credential is missing: {scopes}.',
      'setup.scopeHint': 'Without repo, private repositories cannot be read; without workflow, a build cannot be triggered.',
      'setup.needRepos': 'No repository is registered yet.',
      'setup.codeHint': 'Open the address below in your browser and enter this one-time code:',
      'setup.waiting': 'Waiting for authorization… finish in the browser and this continues by itself.',
      'setup.requestingCode': 'Requesting a one-time code from GitHub…',
      'setup.codePending': 'The authorization page is open — enter the code below once it appears. It has not arrived yet; give it a moment.',
      'setup.stalled': 'No one-time code after {seconds}s: {detail}. The usual cause is that github.com cannot be reached (the panel reads repositories over api.github.com, a different route, so that can still work). You can keep waiting — the code appears once the network recovers — or cancel and try again.',
      'setup.stalledNoOutput': 'gh has printed nothing at all',
      'setup.stalledQuietOutput': 'gh has printed only whitespace (it is usually retrying the connection)',
      'setup.stalledSaid': 'gh said: {text}',
      'setup.unreachableTitle': 'github.com is not reachable right now',
      'setup.unreachable': 'Note: this machine cannot open a connection to github.com:443, which the device-code flow needs — if no code appears, that is the likely reason. gh is already trying; if it can reach GitHub by another route (a proxy, for instance) the code will still appear.',
      'setup.dnsTitle': 'Cannot resolve github.com',
      'setup.dns': 'Note: this machine cannot resolve github.com to an address, while the address itself is reachable (connecting straight to its IP takes tens of milliseconds). gh resolves the name too, so it cannot even send the request — which is why no code appears. A different resolver, or simply retrying later, fixes it; gh is already trying and the code appears as soon as resolution works.',
      'setup.succeeded': 'Authorized. Reading the account…',
      'setup.failed': 'Sign-in did not finish: {reason}',
      'setup.expired': 'The one-time code expired. Start again.',
      'setup.cancelled': 'Sign-in cancelled.',
      'setup.advanced': 'Configure from a command line (optional)',
      'setup.ghInstall': 'Install GitHub CLI (either one)',
      'picker.title': 'Add repositories',
      'picker.search': 'Search repositories',
      'picker.empty': 'Nothing to add (not signed in, or this account has no repositories).',
      'picker.loading': 'Reading your repositories…',
      'picker.failed': 'Reading the repository list failed: {reason}',
      'picker.local': 'local checkout',
      'picker.noLocal': 'no local checkout found',
      'picker.hint': 'Ticking adds, unticking removes; the change applies at once, with no restart.',
      'picker.reload': 'Reload',

      /* -- Bilibili update notes ------------------------------------------- */
      'bili.settings.label': 'Bilibili notes',
      'bili.settings.title': 'Bilibili update notes',
      'bili.settings.subtitle': 'When a plugin is released, one short note is added to the comment section of the video that introduces it. The credential lives only in this plugin\'s own directory, and is never echoed back.',
      'bili.credential.title': 'Sign-in',
      'bili.credential.ready': 'Signed in as {uname}',
      'bili.credential.none': 'No Bilibili credential yet',
      'bili.credential.unreadable': 'The credential cannot be read',
      'bili.credential.incomplete': 'The credential is incomplete',
      'bili.credential.not-logged-in': 'This credential cannot comment',
      'bili.credential.unverified': 'Not verified yet',
      'bili.credential.none.hint': 'Commenting is a WEB API, so the credential has to be a web session. The cookies.json biliup writes by default is an APP/TV login (platform=BiliTV): it can upload, and every web member endpoint answers it with -101 账号未登录 — so it cannot comment.',
      'bili.credential.source': 'Credential file {path}',
      'bili.credential.external': 'This credential comes from the external file named in the config, not from this panel: {path}',
      'bili.signIn': 'Sign in to Bilibili',
      'bili.signIn.hint': 'One click produces a sign-in link: scan it with the Bilibili app, or open it in a browser that is already signed in and confirm. This page continues by itself — no terminal needed.',
      'bili.openLogin': 'Open the sign-in page',
      'bili.waiting': 'Waiting to be scanned…',
      'bili.waitingScanned': 'Scanned — confirm it on your phone…',
      'bili.signIn.done': 'Signed in: {uname}',
      'bili.signIn.doneNoName': 'Signed in, but the account name could not be read.',
      'bili.signIn.expired': 'The code expired. Press 【Sign in to Bilibili】 again.',
      'bili.cancelSignIn': 'Cancel sign-in',
      'bili.paste.title': 'Or paste one',
      'bili.paste.hint': 'In the browser: F12 → Application → Cookies → bilibili.com, and copy SESSDATA and bili_jct (the latter is the csrf). It is written to this plugin\'s own file, and only after Bilibili accepts it.',
      'bili.paste.sessdata': 'SESSDATA',
      'bili.paste.csrf': 'bili_jct',
      'bili.paste.save': 'Save and verify',
      'bili.paste.saved': 'Credential saved: {uname}',
      'bili.signOut': 'Sign out of Bilibili',
      'bili.signOut.confirm': 'Sign out?',
      'bili.signOut.done': 'The credential this plugin stored has been deleted.',
      'bili.signOut.fallback': 'Note: an external credential is still in use ({path}). It belongs to another tool and was left alone.',
      'bili.bind.title': 'Bound video',
      'bili.chip.announced': 'Announced {tag}',
      'bili.chip.pending': 'Waiting to announce {tag}',
      'bili.bind.placeholder': 'BV id, e.g. BV1RopP6FEJp',
      'bili.bind.save': 'Bind',
      'bili.bind.unbind': 'Unbind',
      'bili.bind.done': 'Bound {bvid}{baseline}',
      'bili.bind.baseline': ' (baseline {tag}: only releases published after this are announced automatically)',
      'bili.bind.baselineUnknown': ' (the release list could not be read, so everything published before now counts as already public)',
      'bili.unbound.done': 'Unbound the video for {repo}; the announcement history is kept.',
      'bili.auto.on': 'Automatic',
      'bili.auto.off': 'Manual only',
      'bili.auto.toggle': 'Toggle automatic announcing',
      'bili.announce': 'Post update note',
      'bili.announce.again': 'Already announced — preview again',
      'bili.announce.preview': 'This is the comment that would be posted',
      'bili.announce.confirm': 'Post it',
      'bili.announce.force': 'Post anyway',
      'bili.announce.cancel': 'Cancel',
      'bili.announce.sent': 'Posted to the comments under {bvid} ({tag}).',
      'bili.announce.previewFailed': 'Preview failed: {reason}',
      'bili.repo.none': 'This repository has no video bound.',
      'bili.state.already': '{tag} has already been announced.',
      'bili.state.baseline': '{tag} was published before the video was bound, so it is not this update.',
      'bili.state.no-release': 'There is no published release yet (a draft does not count) — publish the draft from the panel first.',
      'bili.state.gave-up': 'This one has failed {count} times; read why before retrying by hand.',
      'bili.state.unbound': 'This repository has no video bound.',
      'bili.needCredential': 'A repository is bound to a video, but there is no usable Bilibili credential, so update notes cannot be posted.',
      'bili.openSettings': 'Manage under Settings → Bilibili notes',
      'bili.lastSweep': 'Sweep {time}: {summary}',
      'bili.sweep.none': 'nothing new to announce',
      'bili.sweep.announced': 'announced {repo} {tag}',
      'bili.sweep.failed': '{repo} {tag} failed to announce',
      'bili.neverSwept': 'The sweep has not run yet',
      'bili.ledger.problem': 'The announcement ledger cannot be read ({problem}). Nothing will be posted until it can — otherwise every comment already posted would be posted again.',
      'bili.template': 'Template',
      'bili.template.hint': 'Placeholders: {tag} {version} {label} {repo} {title} {summary} {url} {date}. The default carries no link, because a comment with a link is filtered more often.',
      'bili.unknownPlaceholder': 'The template uses placeholders that do not exist: {names}',
      'bili.video.failed': 'The video cannot be read: {reason}',
      'bili.watch.off': 'The sweep is off (bilibiliWatchSeconds: 0); only the manual button and the sweep after publishing a draft remain.',
      'bili.repos.title': 'Per repository',
      'bili.repos.empty': 'No repository is registered yet.',
      'bili.announced.title': 'Announced',
      'bili.announced.none': 'Nothing has been announced yet.',
      'bili.failure.last': 'Last failure: {message}',
    }

    /* ------------------------------------------------------------- styles -- */

    const CSS = `
/* One scale for the whole panel. Every rule below reads these; nothing picks its
   own size, height or radius, because that is how a UI drifts into six different
   font sizes and three different button heights. */
.dsc-root {
  --dsc-fs-sm: 11px;   /* secondary: meta, chips, hints, detail, logs */
  --dsc-fs-md: 12px;   /* primary: rows, buttons, inputs, notices */
  --dsc-fs-lg: 15px;   /* titles, and the one-time code */
  --dsc-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --dsc-ctl-h: 26px;   /* every clickable control is this tall */
  --dsc-ctl-r: 6px;    /* every control, code block and chip container */
  --dsc-box-r: 10px;   /* every container */
  --dsc-gap: 8px;
  display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 20px;
  height: 100%; overflow: auto;
  font-family: inherit; font-size: var(--dsc-fs-md); line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsc-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dsc-heading { display: flex; align-items: baseline; gap: var(--dsc-gap); min-width: 0; }
.dsc-title { font-size: var(--dsc-fs-lg); font-weight: 600; }
.dsc-subtitle { font-size: var(--dsc-fs-sm); color: var(--dsw-alias-label-secondary); }
.dsc-meta { display: flex; align-items: center; gap: var(--dsc-gap); flex-wrap: wrap; font-size: var(--dsc-fs-sm); color: var(--dsw-alias-label-secondary); }
.dsc-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* One button. data-kind changes colour only; data-square changes width only. */
.dsc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: var(--dsc-ctl-h); padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsc-ctl-r);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: var(--dsc-fs-md); font-weight: 400; line-height: 1;
  cursor: pointer; white-space: nowrap;
}
.dsc-btn:hover:not([disabled]) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dsc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsc-btn[disabled] { opacity: .5; cursor: default; }
.dsc-btn[data-kind="primary"] { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.dsc-btn[data-kind="danger"] { border-color: transparent; background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-btn[data-kind="quiet"] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dsc-btn[data-kind="quiet"]:hover:not([disabled]) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsc-btn[data-square="true"] { width: var(--dsc-ctl-h); padding: 0; }

.dsc-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 7px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  font-size: var(--dsc-fs-sm); line-height: 1; color: var(--dsw-alias-label-secondary); white-space: nowrap; flex: none;
}
.dsc-chip[data-state="success"] { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dsc-chip[data-state="error"] { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dsc-chip[data-state="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dsc-chip[data-state="busy"] { color: var(--dsw-alias-brand-primary); border-color: currentColor; }
.dsc-chip[data-state="idle"] { color: var(--dsw-alias-state-idle-primary); border-color: currentColor; }
.dsc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.dsc-dot[data-state="success"] { background: var(--dsw-alias-state-success-primary); }
.dsc-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary); }
.dsc-dot[data-state="warn"] { background: var(--dsw-alias-state-warn-primary); }
.dsc-dot[data-state="busy"] { background: var(--dsw-alias-brand-primary); }

/* One container, one row per repository, separators instead of card gaps. */
.dsc-list { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.dsc-item { border-top: 1px solid var(--dsw-alias-border-l1); }
.dsc-item:first-child { border-top: none; }
.dsc-row { display: flex; align-items: center; gap: var(--dsc-gap); padding: 5px 10px; min-height: 32px; }
.dsc-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 70px; flex: 0 1 auto; }
.dsc-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: var(--dsc-fs-sm); }
.dsc-right { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.dsc-detail { padding: 4px 10px 10px 28px; display: flex; flex-direction: column; gap: var(--dsc-gap); font-size: var(--dsc-fs-sm); color: var(--dsw-alias-label-secondary); }
.dsc-mono { font-family: var(--dsc-mono); overflow-wrap: anywhere; }
.dsc-sub { display: flex; flex-direction: column; gap: 3px; }
.dsc-line { display: flex; align-items: center; gap: var(--dsc-gap); padding: 3px 0; border-top: 1px dashed var(--dsw-alias-border-l1); }
.dsc-line:first-child { border-top: none; }
.dsc-empty { padding: var(--dsc-gap) 2px; font-size: var(--dsc-fs-sm); color: var(--dsw-alias-label-secondary); }
/* A line that only points somewhere else: quieter than a warning, and never a
   control, so it cannot be mistaken for one. */
.dsc-quiet { font-size: var(--dsc-fs-sm); color: var(--dsw-alias-label-secondary); }

.dsc-notice, .dsc-warn, .dsc-error {
  padding: 6px 10px; border-radius: var(--dsc-ctl-r); font-size: var(--dsc-fs-md); line-height: 1.5;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
}
.dsc-warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dsc-error { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dsc-notice code, .dsc-setup code, .dsc-cmd code {
  font-family: var(--dsc-mono); font-size: var(--dsc-fs-sm);
  background: var(--dsw-alias-bg-layer-2); padding: 1px 5px; border-radius: 4px;
}
.dsc-setup {
  border: 1px solid var(--dsw-alias-brand-primary); border-radius: var(--dsc-box-r);
  background: var(--dsw-alias-bg-layer-1); padding: 10px 12px;
  display: flex; flex-direction: column; gap: var(--dsc-gap);
  font-size: var(--dsc-fs-md); color: var(--dsw-alias-label-secondary);
}
.dsc-setup-line { display: flex; align-items: center; gap: var(--dsc-gap); flex-wrap: wrap; }
.dsc-setup-strong { color: var(--dsw-alias-label-primary); }
.dsc-code { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 7px 10px; border-radius: var(--dsc-ctl-r); background: var(--dsw-alias-bg-layer-2); }
.dsc-code-value { font-family: var(--dsc-mono); font-size: var(--dsc-fs-lg); letter-spacing: .12em; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsc-cmd { display: flex; align-items: center; gap: var(--dsc-gap); flex-wrap: wrap; padding: 5px 8px; border-radius: var(--dsc-ctl-r); background: var(--dsw-alias-bg-layer-2); }
.dsc-cmd code { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
.dsc-logs {
  margin: 0; padding: var(--dsc-gap) 10px; max-height: 200px; overflow: auto; border-radius: var(--dsc-ctl-r);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-family: var(--dsc-mono); font-size: var(--dsc-fs-sm); line-height: 1.5; white-space: pre-wrap;
}
.dsc-picker { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsc-box-r); background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; overflow: hidden; }
.dsc-picker-head { display: flex; align-items: center; gap: var(--dsc-gap); padding: var(--dsc-gap) 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsc-input {
  flex: 1 1 auto; min-width: 0; height: var(--dsc-ctl-h); padding: 0 10px;
  font-family: inherit; font-size: var(--dsc-fs-md); line-height: 1;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsc-ctl-r);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.dsc-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* The one-time password field is a control, not a form field: it shares the control
   height and radius so it sits on a confirmation line with the buttons. */
.dsc-otp { flex: 0 0 110px; min-width: 0; }
.dsc-picker-list { max-height: 260px; overflow: auto; }
.dsc-picker-row { display: flex; align-items: center; gap: var(--dsc-gap); padding: 5px 10px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: var(--dsc-fs-md); cursor: pointer; }
.dsc-picker-row:first-child { border-top: none; }
.dsc-picker-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsc-check { width: 14px; height: 14px; flex: none; accent-color: var(--dsw-alias-brand-primary); }
.dsc-hint { padding: 7px 10px; font-size: var(--dsc-fs-sm); color: var(--dsw-alias-label-secondary); border-top: 1px solid var(--dsw-alias-border-l1); }
`

    /**
     * Inject the stylesheet once per document.
     *
     * The loader's materialize step claims every `<style>` that carries no
     * `data-plugin` attribute for the package being materialized, and a later HMR
     * replace of THAT package deletes what it claimed. Tagging the element with
     * this package's own identity keeps it out of both paths.
     */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', 'dsh-plugin-cicd')
      style.setAttribute('data-plugin-css', STYLE_ID)
      style.textContent = CSS
      document.head.append(style)
    }

    /** POST one JSON body with a hard timeout; never throws. */
    async function postJson(path, body, timeoutMs) {
      const controller = new AbortController()
      const timer = globalThis.setTimeout(() => {
        controller.abort()
      }, timeoutMs)
      try {
        const response = await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        return { ok: true, response, payload }
      } catch (error) {
        return { ok: false, aborted: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) }
      } finally {
        globalThis.clearTimeout(timer)
      }
    }

    /** A short local time stamp; an unparseable value is shown as-is. */
    function stamp(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const parsed = new Date(iso)
      if (Number.isNaN(parsed.getTime())) return iso
      return parsed.toLocaleString()
    }

    /** A compact "how long did it take" label for a settled run. */
    function duration(run) {
      if (run === null || run.createdAt === '' || run.updatedAt === '') return ''
      const from = new Date(run.createdAt).getTime()
      const to = new Date(run.updatedAt).getTime()
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return ''
      const seconds = Math.round((to - from) / 1000)
      return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
    }

    /** Map a run's state onto the chip vocabulary. */
    function runState(run) {
      if (run === null) return 'idle'
      if (run.status !== 'completed') return 'busy'
      if (run.conclusion === 'success') return 'success'
      if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'startup_failure') return 'error'
      return 'idle'
    }

    /** The 7-character commit form git itself prints, for a message a person reads. */
    function shortSha(value) {
      return typeof value === 'string' && value !== '' ? value.slice(0, 7) : '?'
    }

    /**
     * A failed release route's reason, in the panel's language.
     *
     * The Host answers with a stable `code` plus the facts, and its `message` is the
     * English fallback a log would show. Rendering the fallback here would put an
     * English sentence in an otherwise Chinese panel, so the codes that the panel
     * can explain are translated and anything unknown falls back to the raw message.
     *
     * @param {Function} t - dictionary lookup.
     * @param {object|null} payload - route body.
     * @param {object|null} response - fetch response, for the status fallback.
     * @returns {string} a sentence for the error line.
     */
    function releaseFailure(t, payload, response) {
      const code = typeof payload?.code === 'string' ? payload.code : ''
      const value = payload?.value ?? {}
      if (code === 'dirty-tree') return t('release.dirty', { count: String(value.dirty ?? '?') })
      if (code === 'no-upstream') return t('release.noUpstream', { branch: String(value.branch ?? '?') })
      if (code === 'behind') return t('release.behind', { count: String(value.behind ?? '?') })
      if (code === 'no-checkout') return t('release.noCheckout')
      if (code === 'unusable-version' || code === 'unusable-manifest') return t('release.noVersion')
      if (code === 'push-failed') return t('release.pushFailed', { tag: String(value.tag ?? ''), reason: String(payload?.message ?? '') })
      if (code === 'version-taken') {
        return t(value.nextTag === null || value.nextTag === undefined ? 'release.takenNoNext' : 'release.taken', {
          tag: String(value.tag ?? ''),
          owner: shortSha(value.owner),
          built: shortSha(value.built),
          next: String(value.nextTag ?? ''),
        })
      }
      return typeof payload?.message === 'string' && payload.message !== '' ? payload.message : `HTTP ${String(response?.status ?? '?')}`
    }

    /** A compact isometric package, drawn with `currentColor`. */
    function ConsoleIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M8 1.6 2.4 4.5v7L8 14.4l5.6-2.9v-7L8 1.6Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M2.6 4.6 8 7.3l5.4-2.7M8 7.3v6.9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      )
    }

    /** One pill. */
    function Chip(props) {
      return h('span', { className: 'dsc-chip', 'data-state': props.state ?? 'idle', title: props.title }, props.children)
    }

    /**
     * One button.
     *
     * `kind` changes colour and `square` changes width — nothing is allowed to
     * change its own height or font size, which is how a toolbar ends up with
     * three different button sizes.
     */
    function Btn(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsc-btn',
          'data-kind': props.kind,
          'data-square': props.square === true ? 'true' : undefined,
          title: props.title,
          disabled: props.disabled === true,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /** A value with a copy button — the fallback path, never the instruction. */
    function CopyLine(props) {
      const { t, command } = props
      /**
       * When the value is already on screen, showing it again beside the copy button
       * just prints the same string twice. The button is then the whole control.
       */
      const hideCommand = props.hideCommand === true
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => {
        if (!copied) return undefined
        const timer = globalThis.setTimeout(() => {
          setCopied(false)
        }, 2_000)
        return () => {
          globalThis.clearTimeout(timer)
        }
      }, [copied])
      return h(
        'div',
        { className: 'dsc-cmd' },
        hideCommand ? null : h('code', null, command),
        h(
          Btn,
          {
            kind: 'quiet',
            onClick: () => {
              // Clipboard access needs a secure context; the loopback GUI is one,
              // but a refusal must not be reported as a successful copy.
              const write = globalThis.navigator?.clipboard?.writeText
              if (typeof write !== 'function') return
              void write.call(globalThis.navigator.clipboard, command).then(() => setCopied(true)).catch(() => setCopied(false))
            },
          },
          copied ? t('action.copied') : t('action.copy'),
        ),
      )
    }

    /**
     * The browser sign-in, driven from the panel.
     *
     * The Host runs `gh auth login --web` and streams back the one-time code, so
     * the user's whole job is: click, open the linked page, type the code. No
     * terminal — and the plugin still never sees the token, because `gh` writes it.
     */
    function SignIn(props) {
      const { t, status, onChanged } = props
      const [attempt, setAttempt] = React.useState(status?.auth ?? { state: 'idle' })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const gh = status?.gh ?? {}
      const missing = Array.isArray(gh.missingScopes) ? gh.missingScopes : []

      const start = React.useCallback(
        async (mode) => {
          setBusy(true)
          setError(null)
          const result = await postJson('/auth-start', { mode, scopes: mode === 'refresh' ? missing : [] }, ACTION_TIMEOUT_MS)
          setBusy(false)
          if (!result.ok) {
            setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
            return
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            return
          }
          setAttempt(result.payload.value)
        },
        [missing, t],
      )

      // Poll only while an attempt is pending: waking up every two seconds for the
      // rest of the session would be work nobody asked for.
      const pending = attempt.state === 'pending' || attempt.state === 'running'
      /**
       * `onChanged` is passed as an inline arrow, so its identity changes on every
       * render of the parent. Keeping it in a dependency array therefore tore this
       * interval down and restarted it whenever anything re-rendered — and a timer
       * that is reset more often than it fires never fires at all, which is how the
       * one-time code could sit unread in the Host while the panel showed nothing.
       * A ref carries the latest callback without being a dependency.
       */
      const onChangedRef = React.useRef(onChanged)
      onChangedRef.current = onChanged
      React.useEffect(() => {
        if (!pending) return undefined
        let cancelled = false
        /* Ask once immediately: the code usually exists by the time /auth-start
           answers, so waiting a full interval just to see it is pure latency. */
        const poll = async () => {
          const result = await postJson('/auth-state', {}, STATUS_TIMEOUT_MS)
          if (cancelled || !result.ok || result.payload?.ok !== true) return
          const next = result.payload.value
          setAttempt(next)
          if (next.state === 'succeeded') onChangedRef.current()
        }
        void poll()
        const timer = globalThis.setInterval(() => { void poll() }, AUTH_POLL_MS)
        return () => {
          cancelled = true
          globalThis.clearInterval(timer)
        }
      }, [pending])

      const cancel = React.useCallback(async () => {
        await postJson('/auth-cancel', {}, STATUS_TIMEOUT_MS)
        setAttempt({ state: 'idle' })
      }, [])

      const code = typeof attempt.code === 'string' && attempt.code !== '' ? attempt.code : null
      const url = typeof attempt.url === 'string' && attempt.url !== '' ? attempt.url : 'https://github.com/login/device'

      /**
       * Nothing left to do.
       *
       * Once the credential carries every scope the panel needs, this component has
       * no button to offer and no status worth reporting. Returning `null` retires
       * it: leaving a redundant "sign in" button, or the remains of "authorized,
       * reading the account…", made a finished login look stuck — and it stayed
       * that way until something else happened to re-render the block.
       */
      if (gh.available === true && gh.authenticated === true && missing.length === 0 && !pending) return null

      return h(
        'div',
        { className: 'dsc-sub' },
        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, error) : null,
        pending
          ? h(
              React.Fragment,
              null,
              h('span', { className: 'dsc-setup-strong' }, code === null ? t('setup.requestingCode') : t('setup.codeHint')),
              h(
                'div',
                { className: 'dsc-code' },
                h('span', { className: 'dsc-code-value' }, code ?? '····-····'),
                /* Opening the page before the code exists is the reported failure:
                   the browser shows GitHub's device page and there is nothing to
                   type. The button therefore stays disabled until there is a code. */
                /* Always usable: the device page's address is static, so opening it
                   costs nothing and waiting for the code to enable it was the reason
                   nothing at all appeared to happen. */
                h(Btn, { kind: 'primary', onClick: () => globalThis.open(url, '_blank', 'noopener,noreferrer') }, t('action.openDevicePage')),
                code !== null ? h(CopyLine, { t, command: code, hideCommand: true }) : null,
              ),
              h('span', null, code === null ? t('setup.codePending') : t('setup.waiting')),
              /* Advisory, never a refusal: the probe cannot see a proxy that gh
                 might be using, so this reports a likely cause without stopping
                 an attempt that could still succeed. */
              pending && attempt.reachable === false
                ? h(
                    'span',
                    { className: 'dsc-warn' },
                    h('strong', null, t(attempt.reachabilityStage === 'dns' ? 'setup.dnsTitle' : 'setup.unreachableTitle')),
                    ' — ',
                    t(attempt.reachabilityStage === 'dns' ? 'setup.dns' : 'setup.unreachable'),
                  )
                : null,
              /* A stalled attempt keeps running — the code has been observed to
                 arrive once the network recovers — so this reports the wait
                 instead of declaring a failure the user would have to retry. */
              pending && attempt.stalled === true
                ? h('span', { className: 'dsc-warn' }, t('setup.stalled', {
                    seconds: String(Math.max(1, Math.round((typeof attempt.waitedMs === 'number' ? attempt.waitedMs : 0) / 1000))),
                    detail: typeof attempt.outputExcerpt === 'string' && attempt.outputExcerpt !== ''
                      ? t('setup.stalledSaid', { text: attempt.outputExcerpt })
                      : (typeof attempt.outputBytes === 'number' && attempt.outputBytes > 0 ? t('setup.stalledQuietOutput') : t('setup.stalledNoOutput')),
                  }))
                : null,
              h('div', { className: 'dsc-actions' }, h(Btn, { onClick: cancel }, t('action.cancelSignIn'))),
            )
          : h(
              'div',
              { className: 'dsc-actions' },
              gh.available !== true
                ? h(Btn, { kind: 'primary', onClick: () => globalThis.open('https://cli.github.com/', '_blank', 'noopener,noreferrer') }, 'cli.github.com')
                : missing.length > 0
                  ? h(Btn, { kind: 'primary', disabled: busy, onClick: () => void start('refresh') }, t('action.grantScopes'))
                  /*
                   * Open the page from inside the click.
                   *
                   * The address is static and does not depend on the code, and opening
                   * it here is what makes the click keep its promise. It has to happen
                   * synchronously in the handler: a window opened from an effect after
                   * an await is outside the user gesture and browsers block it. gh's
                   * own browser launch does not happen until it has a code — which is
                   * precisely the situation where nothing seems to happen.
                   */
                  : h(Btn, { kind: 'primary', disabled: busy, onClick: () => {
                      globalThis.open('https://github.com/login/device', '_blank', 'noopener,noreferrer')
                      void start('login')
                    } }, t('action.signIn')),
              h(Btn, { disabled: busy, onClick: onChanged }, t('action.recheck')),
            ),
        attempt.state === 'succeeded' ? h('span', null, t('setup.succeeded')) : null,
        attempt.state === 'expired' ? h('span', { className: 'dsc-warn' }, t('setup.expired')) : null,
        attempt.state === 'cancelled' ? h('span', null, t('setup.cancelled')) : null,
        attempt.state === 'failed' ? h('span', { className: 'dsc-warn' }, t('setup.failed', { reason: attempt.message ?? t('run.unknown') })) : null,
      )
    }

    /**
     * The repository list: fetched from GitHub, ticked to register.
     *
     * This is what replaced "run `configure.mjs add <repo> --path <absolute dir>`".
     * The local checkout is looked up from the configured root, so the user ticks a
     * box and types nothing.
     */
    function RepoPicker(props) {
      const { t, onChanged } = props
      const [repos, setRepos] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState(null)
      const [filter, setFilter] = React.useState('')

      const load = React.useCallback(async () => {
        setError(null)
        setRepos(null)
        const result = await postJson('/repos-available', { limit: 200 }, OVERVIEW_TIMEOUT_MS)
        if (!result.ok) {
          setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
          return
        }
        if (!result.response.ok || result.payload?.ok !== true) {
          // A missing route is a version mismatch, not a failure of the account.
          setError(isMissingRoute(result.response.status)
            ? t('stale.text')
            : t('picker.failed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
          return
        }
        setRepos(result.payload.value.repos ?? [])
      }, [t])

      React.useEffect(() => {
        void load()
      }, [load])

      const toggle = React.useCallback(
        async (entry) => {
          setBusy(entry.fullName)
          setError(null)
          /**
           * Add with the full `owner/name`: the picker knows it, and it is
           * self-sufficient — a fresh install has no `owner` configured, and a bare
           * name would then register something the Host cannot resolve to a slug.
           * Remove with whatever form is actually stored.
           */
          const target = entry.registered && typeof entry.registeredAs === 'string' ? entry.registeredAs : entry.fullName
          const result = entry.registered
            ? await postJson('/config-remove', { repo: target }, ACTION_TIMEOUT_MS)
            : await postJson('/config-add', { repo: target }, ACTION_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
            return
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            return
          }
          setRepos((current) => (current ?? []).map((item) => (item.fullName === entry.fullName ? { ...item, registered: !entry.registered } : item)))
          onChanged()
        },
        [onChanged, t],
      )

      const needle = filter.trim().toLowerCase()
      const visible = (repos ?? []).filter((entry) => needle === ''
        || entry.fullName.toLowerCase().includes(needle)
        || entry.description.toLowerCase().includes(needle))

      return h(
        'div',
        { className: 'dsc-picker' },
        h(
          'div',
          { className: 'dsc-picker-head' },
          h('input', {
            className: 'dsc-input',
            type: 'search',
            value: filter,
            placeholder: t('picker.search'),
            onChange: (event) => setFilter(event.target.value),
          }),
          h(Btn, { onClick: () => void load() }, t('picker.reload')),
        ),
        error !== null ? h('div', { className: 'dsc-warn' }, error) : null,
        repos === null
          ? h('div', { className: 'dsc-empty' }, t('picker.loading'))
          : visible.length === 0
            ? h('div', { className: 'dsc-empty' }, t('picker.empty'))
            : h(
                'div',
                { className: 'dsc-picker-list' },
                visible.map((entry) =>
                  h(
                    'label',
                    { className: 'dsc-picker-row', key: entry.fullName },
                    h('input', {
                      className: 'dsc-check',
                      type: 'checkbox',
                      checked: entry.registered,
                      disabled: busy !== '',
                      onChange: () => void toggle(entry),
                    }),
                    h('span', { className: 'dsc-name', style: { minWidth: '0' } }, entry.bare),
                    entry.private ? h(Chip, { state: 'idle' }, t('chip.private')) : null,
                    h('span', { className: 'dsc-grow' }, entry.description),
                    entry.localPath !== ''
                      ? h(Chip, { state: 'success', title: entry.localPath }, t('picker.local'))
                      : h(Chip, { state: 'idle' }, t('picker.noLocal')),
                  ),
                ),
              ),
        h('div', { className: 'dsc-hint' }, t('picker.hint')),
      )
    }

    /** One repository row, expandable into path, releases, runs and logs. */
    function RepoRow(props) {
      const { t, data, busy, onAction, onBump, onPublish, onUpdate, npm, onNpmPublish, bili, onBiliBind, onBiliPreview, onBiliAnnounce, logs, onLogs } = props
      const [open, setOpen] = React.useState(false)
      /**
       * A draft release is the panel's one invisible outcome: it exists, it is not
       * a failure, and it cannot be seen anywhere until it is published. So a row
       * that has one opens itself — the Publish button is the answer to "why is
       * this not released", and it should not be behind a click that nobody knows
       * to make. The effect keys on the tag, so collapsing the row by hand stays
       * collapsed until the draft state actually changes.
       */
      React.useEffect(() => {
        if (data.draftTag !== null && data.draftTag !== undefined) setOpen(true)
      }, [data.draftTag])
      const [confirming, setConfirming] = React.useState(null)
      /** The bump confirmation is inline, like publishing a draft: it creates a commit. */
      const [bumping, setBumping] = React.useState(false)
      /** Installing a release rewrites a profile dependency, so it asks first too. */
      const [updating, setUpdating] = React.useState(false)
      /** A publish cannot be undone, so it asks first — and 2FA needs somewhere to type. */
      const [publishing, setPublishing] = React.useState(false)
      const [otp, setOtp] = React.useState('')
      const run = data.latestRun
      const local = data.local ?? { available: false }
      /**
       * What this profile has installed for this repository's package.
       *
       * The Host decides, not the page: the answer depends on the profile this Host
       * is running from, and a panel that guessed it from the row's version number
       * would offer "update" where the two copies are the same code and hide it where
       * they are not (a `link:` checkout and a released tarball can carry the same
       * version).
       */
      const install = data.install ?? null
      const installState = install === null ? '' : String(install.state ?? '')
      /** States where the release artifact can genuinely replace what is installed. */
      const installable = installState === 'update' || installState === 'checkout' || installState === 'ahead' || installState === 'differs'
      const installLabel = installState === 'update' ? 'action.update' : 'action.installRelease'
      const installExplain = (() => {
        if (install === null) return null
        const params = {
          package: String(install.packageName ?? ''),
          profile: String(install.profile ?? ''),
          tag: String(install.latestTag ?? ''),
          spec: String(install.spec ?? ''),
          installed: String(install.installedVersion ?? '?'),
        }
        if (installState === 'checkout') return t('install.checkout', params)
        if (installState === 'ahead') return t('install.ahead', params)
        if (installState === 'differs') return t('install.differs', params)
        if (installState === 'current') return t('install.current', params)
        if (installState === 'no-release') return t('install.noRelease', params)
        return t('install.notInstalled', params)
      })()
      /**
       * What npm holds for this package, and why a push is or is not offered.
       *
       * Fetched on demand by the page rather than baked into the overview, so it is
       * `null` until the first answer arrives — and a `null` renders nothing at all,
       * which is the honest thing to show when the registry has not been asked.
       */
      const npmInfo = npm ?? null
      const npmBlockers = Array.isArray(npmInfo?.blockers) ? npmInfo.blockers : []
      const npmCanPush = npmInfo !== null && npmInfo.canPublish === true
      const npmExplain = (() => {
        if (npmInfo === null) return null
        const params = {
          version: String(npmInfo.version ?? '?'),
          latest: String(npmInfo.latest ?? '—'),
          reason: String(npmInfo.registryProblem ?? npmInfo.state ?? ''),
        }
        if (npmInfo.canPublish === true) {
          if (npmInfo.state === 'unregistered') return t('npm.state.unregistered', params)
          if (npmInfo.state === 'published') return t('npm.state.published', params)
          return t('npm.state.unpublished', params)
        }
        /* The first blocker is the one to fix first; the rest are consequences. */
        const first = npmBlockers[0]
        const key = `npm.blocked.${first ?? 'registry-unreachable'}`
        const text = t(key, params)
        return text === key ? t('npm.state.unknown', params) : text
      })()
      /**
       * Whether releasing the local version is possible, decided by the Host so this
       * panel and the dispatch route cannot disagree. `blocked` is only ever proven
       * (the version's release belongs to another commit), never guessed.
       */
      const check = data.releaseCheck ?? null
      const blocked = check !== null && check.state === 'blocked'
      const state = runState(run)

      /* Only non-zero local signals are shown: a column of "clean" chips is noise,
         and the row exists to make the exceptions visible. */
      const chips = []
      /* A version that is already taken makes 发布 impossible, so the row says so
         before the button is pressed rather than after a run has failed. */
      if (blocked) chips.push(h(Chip, { key: 'v', state: 'warn', title: t('release.takenTitle') }, t('chip.versionTaken')))
      /* An installed copy that is genuinely behind the release is the one update
         worth a chip; a `link:` checkout is the normal state here and saying so on
         every row would be a column of noise. */
      if (installState === 'update' && typeof install?.latestTag === 'string') {
        chips.push(h(Chip, { key: 'u', state: 'warn', title: installExplain ?? undefined }, t('chip.update', { tag: install.latestTag })))
      }
      /*
       * The npm chip is the whole row-level surface for the second channel: a version
       * that is on npm is a fact worth seeing, and a version that is not is a job
       * waiting. Anything else — private, dirty, not signed in — belongs in the
       * expansion, where there is room to say what to do about it.
       */
      if (npmInfo !== null && npmInfo.state === 'published') {
        chips.push(h(Chip, { key: 'n', state: 'success', title: String(npmInfo.pageUrl ?? '') }, t('npm.chipPublished', { version: String(npmInfo.version ?? '') })))
      } else if (npmCanPush) {
        chips.push(h(Chip, { key: 'n', state: 'warn', title: npmExplain ?? undefined }, t('npm.chipPending', { version: String(npmInfo.version ?? '') })))
      }
      /*
       * A published release whose update note has not gone out yet. It is a chip
       * rather than a sentence because the row is scanned: the answer to "why has
       * this not been announced" belongs behind the expansion, next to the button.
       */
      if (bili?.binding != null && typeof data.publishedTag === 'string' && data.publishedTag !== '') {
        const announced = Array.isArray(bili.announced) ? bili.announced : []
        const baselineTag = bili.baseline === null || bili.baseline === undefined ? null : bili.baseline.tag
        const covered = announced.some((entry) => entry.tag === data.publishedTag) || baselineTag === data.publishedTag || (bili.baseline !== null && baselineTag === null)
        if (!covered) chips.push(h(Chip, { key: 'bl', state: 'warn' }, t('bili.chip.pending', { tag: data.publishedTag })))
      }
      if (local.available === true) {
        if (Number.isFinite(local.dirty) && local.dirty > 0) chips.push(h(Chip, { key: 'd', state: 'warn' }, t('chip.dirty', { count: String(local.dirty) })))
        if (Number.isFinite(local.ahead) && local.ahead > 0) chips.push(h(Chip, { key: 'a', state: 'warn' }, `↑${local.ahead}`))
        if (Number.isFinite(local.behind) && local.behind > 0) chips.push(h(Chip, { key: 'b', state: 'idle' }, `↓${local.behind}`))
      }

      return h(
        'div',
        { className: 'dsc-item' },
        h(
          'div',
          { className: 'dsc-row' },
          h('span', { className: 'dsc-dot', 'data-state': state, title: run === null ? t('state.noRuns') : `${run.workflow} · ${run.conclusion || run.status}` }),
          h('span', { className: 'dsc-name' }, data.label),
          /* Registered, but GitHub has not been read yet: say so rather than
             showing "未发布", which would be a claim the panel cannot make. */
          data.pending === true
            ? h(Chip, { state: 'busy' }, t('state.reading'))
            : data.versionKnown === true && data.version !== null ? h(Chip, { state: 'idle' }, `v${data.version}`) : null,
          data.pending === true
            ? null
            : data.draftTag !== null
              ? h(Chip, { state: 'warn' }, `${t('chip.draft')} ${data.draftTag}`)
              : data.published
                // Name the tag: without a local checkout the panel knows the release
                // from GitHub alone, and the tag is the fact it actually has.
                ? h(Chip, { state: 'success' }, data.publishedTag === null ? t('chip.published') : `${t('chip.published')} ${data.publishedTag}`)
                : h(Chip, { state: 'idle' }, t('chip.unpublished')),
          chips,
          h('span', { className: 'dsc-grow' }, data.pending === true ? t('state.reading') : run === null ? t('state.noRuns') : `${run.workflow} · ${duration(run)} · ${stamp(run.createdAt)}`),
          h(
            'div',
            { className: 'dsc-right' },
            data.hasBuildWorkflow ? h(Btn, { disabled: busy !== '', title: t('action.build'), onClick: () => onAction('build', data) }, busy === `build:${data.repo}` ? '…' : t('action.build')) : null,
            data.hasReleaseWorkflow
              ? blocked && typeof check.nextTag === 'string' && check.nextTag !== ''
                /* The version is the obstacle, so the button that works is the one
                   that removes it — refusing to dispatch and leaving the user to edit
                   package.json by hand would be the same dead end, one click later. */
                ? h(Btn, {
                    kind: 'primary',
                    disabled: busy !== '',
                    title: t('action.bumpRelease'),
                    onClick: () => {
                      setOpen(true)
                      setBumping(true)
                    },
                  }, busy === `bump:${data.repo}` ? '…' : t('action.bumpRelease'))
                : h(Btn, { kind: 'primary', disabled: busy !== '', title: t('action.release'), onClick: () => onAction('release', data) }, busy === `release:${data.repo}` ? '…' : t('action.release'))
              : null,
            /* The other half of the loop the console exists for: 发布 cuts the
               release, this one installs it into the profile that is running. */
            installable && install?.latestTag
              ? h(Btn, {
                  disabled: busy !== '',
                  title: installExplain ?? undefined,
                  onClick: () => {
                    setOpen(true)
                    setUpdating(true)
                  },
                }, busy === `update:${data.repo}` ? '…' : t(installLabel, { tag: String(install.latestTag) }))
              : null,
            h(Btn, { kind: 'quiet', square: true, onClick: () => setOpen((value) => !value), title: open ? t('action.collapse') : t('action.expand') }, open ? '▴' : '▾'),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'dsc-detail' },
              data.localPath === ''
                ? h('span', null, t('meta.noLocal'))
                : h('span', { className: 'dsc-mono' }, `${t('meta.path')} ${data.localPath}`),
              data.problems.length > 0 ? h('div', { className: 'dsc-warn' }, data.problems.join(' · ')) : null,

              /* Why 发布 cannot work, and what would make it work. Both notes are
                 about the same trap: a release builds the pushed commit, so anything
                 only in the working tree or only local is silently absent from it. */
              blocked
                ? h('div', { className: 'dsc-warn' }, check.nextTag === null
                    ? t('release.takenNoNext', { tag: check.tag ?? '', owner: shortSha(check.owner), built: shortSha(check.built) })
                    : t('release.taken', { tag: check.tag ?? '', owner: shortSha(check.owner), built: shortSha(check.built), next: check.nextTag }))
                : null,
              local.available === true && Number.isFinite(local.dirty) && local.dirty > 0
                ? h('div', { className: 'dsc-warn' }, t('release.dirtyNote', { count: String(local.dirty) }))
                : null,
              local.available === true && Number.isFinite(local.ahead) && local.ahead > 0
                ? h('div', { className: 'dsc-warn' }, t('release.aheadNote', { count: String(local.ahead) }))
                : null,
              bumping && blocked && typeof check.nextTag === 'string'
                ? h(
                    'div',
                    { className: 'dsc-line' },
                    h('span', { className: 'dsc-grow' }, t('confirm.bumpRelease', {
                      from: data.version ?? '?',
                      to: check.nextTag,
                      branch: typeof local.branch === 'string' && local.branch !== '' ? local.branch : 'main',
                    })),
                    h(Btn, {
                      kind: 'danger',
                      disabled: busy !== '',
                      onClick: () => {
                        setBumping(false)
                        onBump(data)
                      },
                    }, t('action.bumpRelease')),
                    h(Btn, { kind: 'quiet', onClick: () => setBumping(false) }, t('confirm.cancel')),
                  )
                : null,

              /* What this profile has installed, and the one action that changes it.
                 Without this the panel could cut a release and never take it: the
                 installed copy is the half of "is it published?" that GitHub cannot
                 answer. */
              install !== null
                ? h(
                    'div',
                    { className: 'dsc-sub' },
                    h('span', null, t('install.title')),
                    h(
                      'div',
                      { className: 'dsc-line' },
                      h('span', { className: 'dsc-name', style: { minWidth: '0', fontWeight: '500' } }, String(install.packageName ?? '')),
                      /* No version chip when none could be read: the explanation
                         below says which copy this is, and an invented "v?" would
                         be a claim the Host did not make. */
                      install.installedVersion === null
                        ? null
                        : h(Chip, { state: installState === 'current' ? 'success' : installState === 'update' ? 'warn' : 'idle' }, `v${String(install.installedVersion)}`),
                      installState === 'checkout' ? h(Chip, { state: 'warn' }, t('chip.checkout')) : null,
                      h('span', { className: 'dsc-grow', title: String(install.spec ?? '') }, install.present === true ? String(install.spec ?? '') : `— ${String(install.profile ?? '')}`),
                      installable && install.latestTag
                        ? h(Btn, {
                            kind: installState === 'update' ? 'primary' : undefined,
                            disabled: busy !== '',
                            title: installExplain ?? undefined,
                            onClick: () => setUpdating(true),
                          }, busy === `update:${data.repo}` ? '…' : t(installLabel, { tag: String(install.latestTag) }))
                        : null,
                    ),
                    h('span', null, installExplain),
                  )
                : null,
              /* The second channel. A GitHub Release and an npm version are separate
                 facts about the same package, and this is where they sit next to each
                 other instead of in two browser tabs. */
              npmInfo !== null
                ? h(
                    'div',
                    { className: 'dsc-sub' },
                    h('span', null, t('npm.title')),
                    h(
                      'div',
                      { className: 'dsc-line' },
                      h('span', { className: 'dsc-name', style: { minWidth: '0', fontWeight: '500' } }, String(npmInfo.packageName ?? '')),
                      npmInfo.state === 'published'
                        ? h(Chip, { state: 'success' }, `v${String(npmInfo.version ?? '?')}`)
                        : npmInfo.state === 'unregistered'
                          ? h(Chip, { state: 'warn' }, t('npm.chipUnregistered'))
                          : h(Chip, { state: 'idle' }, `v${String(npmInfo.version ?? '?')}`),
                      npmInfo.latest !== null && npmInfo.latest !== undefined
                        ? h('span', { className: 'dsc-grow' }, `npm latest ${String(npmInfo.latest)}`)
                        : h('span', { className: 'dsc-grow' }, String(npmInfo.pageUrl ?? '')),
                      npmCanPush
                        ? h(Btn, {
                            disabled: busy !== '',
                            title: npmExplain ?? undefined,
                            onClick: () => setPublishing(true),
                          }, busy === `npm:${data.repo}` ? '…' : t('npm.action.publish', { version: String(npmInfo.version ?? '') }))
                        : null,
                    ),
                    h('span', null, npmExplain),
                    /* A draft (or missing) GitHub release on the same version is worth
                       saying out loud: the two channels are about to disagree in public. */
                    npmCanPush && data.publishedTag !== `v${String(npmInfo.version ?? '')}`
                      ? h('span', { className: 'dsc-warn' }, t('npm.githubDraft'))
                      : null,
                  )
                : null,
              publishing && npmCanPush
                ? h(
                    'div',
                    { className: 'dsc-line' },
                    h('span', { className: 'dsc-grow' }, t('confirm.npmPublish', {
                      package: String(npmInfo.packageName ?? ''),
                      version: String(npmInfo.version ?? ''),
                      registry: String(npmInfo.registry ?? ''),
                    })),
                    h('input', {
                      className: 'dsc-input dsc-otp',
                      type: 'text',
                      inputMode: 'numeric',
                      autoComplete: 'one-time-code',
                      placeholder: t('npm.otpPlaceholder'),
                      title: t('npm.otpHint'),
                      'aria-label': t('npm.otpLabel'),
                      value: otp,
                      onChange: (event) => setOtp(String(event?.target?.value ?? '').replace(/[^0-9]/g, '').slice(0, 8)),
                    }),
                    h(Btn, {
                      kind: 'danger',
                      disabled: busy !== '',
                      onClick: () => {
                        setPublishing(false)
                        onNpmPublish(data, otp)
                      },
                    }, t('npm.action.confirm')),
                    h(Btn, { kind: 'quiet', onClick: () => setPublishing(false) }, t('confirm.cancel')),
                  )
                : null,

              updating && installable && install?.latestTag
                ? h(
                    'div',
                    { className: 'dsc-line' },
                    h('span', { className: 'dsc-grow' }, t('confirm.update', {
                      package: String(install.packageName ?? ''),
                      profile: String(install.profile ?? ''),
                      spec: install.present === true ? String(install.spec ?? '') : '—',
                      tag: String(install.latestTag),
                    })),
                    h(Btn, {
                      kind: 'danger',
                      disabled: busy !== '',
                      onClick: () => {
                        setUpdating(false)
                        onUpdate(data)
                      },
                    }, t('action.confirmUpdate')),
                    h(Btn, { kind: 'quiet', onClick: () => setUpdating(false) }, t('confirm.cancel')),
                  )
                : null,

              /* The third channel, inside the row that owns it: which video carries
                 this repository's update notes, and the button that posts one now. */
              bili !== null && bili !== undefined
                ? h(BiliBinding, { t, data, bili, busy, onBind: onBiliBind, onPreview: onBiliPreview, onAnnounce: onBiliAnnounce })
                : null,

              h(
                'div',
                { className: 'dsc-sub' },
                h('span', null, `${t('meta.version')} ${data.version ?? '?'}${data.expectedTag === null ? '' : ` · ${t('meta.expectedTag', { tag: data.expectedTag })}`}`),
                data.releases.length === 0
                  ? h('span', null, t('state.noReleases'))
                  : data.releases.map((release) =>
                      h(
                        'div',
                        { className: 'dsc-line', key: release.tag },
                        h('span', { className: 'dsc-name', style: { minWidth: '0', fontWeight: '500' } }, release.tag),
                        release.draft ? h(Chip, { state: 'warn' }, t('chip.draft')) : h(Chip, { state: 'success' }, t('chip.published')),
                        h('span', { className: 'dsc-grow' }, `${stamp(release.createdAt)} · ${t('meta.assets', { count: String(release.assets.length) })}`),
                        release.draft
                          ? confirming === release.tag
                            ? h(
                                React.Fragment,
                                null,
                                h(Btn, { kind: 'danger', disabled: busy !== '', onClick: () => onPublish(release.tag) }, t('action.confirmPublish')),
                                h(Btn, { kind: 'quiet', onClick: () => setConfirming(null) }, t('confirm.cancel')),
                              )
                            : h(Btn, { onClick: () => setConfirming(release.tag) }, t('action.publishDraft'))
                          : null,
                        release.url !== '' ? h(Btn, { kind: 'quiet', onClick: () => globalThis.open(release.url, '_blank', 'noopener,noreferrer') }, t('action.open')) : null,
                      ),
                    ),
              ),

              h(
                'div',
                { className: 'dsc-sub' },
                h('span', null, t('label.runs')),
                data.runs.length === 0
                  ? h('span', null, t('state.noRuns'))
                  : data.runs.slice(0, 4).map((entry) =>
                      h(
                        'div',
                        { className: 'dsc-line', key: String(entry.id) },
                        h(Chip, { state: runState(entry) }, entry.conclusion || entry.status || t('run.unknown')),
                        h('span', { className: 'dsc-grow', title: entry.title }, `${entry.workflow} · ${entry.title}`),
                        h('span', null, duration(entry)),
                        entry.status !== 'completed' && entry.id !== null
                          ? h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => onAction('cancel', data, { runId: entry.id }) }, t('action.cancel'))
                          : null,
                        entry.status === 'completed' && entry.id !== null
                          ? h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => onAction('rerun-failed', data, { runId: entry.id }) }, t('action.rerun'))
                          : null,
                        entry.status === 'completed' && entry.id !== null
                          ? h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => onLogs(data, entry) }, logs !== null && logs.runId === entry.id ? t('action.hideLogs') : t('action.logs'))
                          : null,
                      ),
                    ),
              ),

              logs !== null && logs.repo === data.repo
                ? h(
                    'div',
                    null,
                    h('pre', { className: 'dsc-logs' }, logs.lines.join('\n')),
                    logs.truncated ? h('span', null, t('state.truncated', { lines: String(logs.lines.length) })) : null,
                  )
                : null,
            )
          : null,
      )
    }

    /** Shared data plumbing for the panel and the settings page. */
    function useConsoleState() {
      const [status, setStatus] = React.useState(null)
      const [overview, setOverview] = React.useState(null)
      const [npm, setNpm] = React.useState(null)
      const [bili, setBili] = React.useState(null)
      const [error, setError] = React.useState(null)

      const loadStatus = React.useCallback(async () => {
        const result = await postJson('/status', {}, STATUS_TIMEOUT_MS)
        if (!result.ok) {
          setError(result.aborted ? 'timeout' : 'host')
          return null
        }
        if (result.response.ok && result.payload?.ok === true) {
          setStatus(result.payload.value ?? null)
          setError(null)
          return result.payload.value
        }
        setError(isMissingRoute(result.response.status) ? 'stale-host' : (result.payload?.message ?? `HTTP ${String(result.response.status)}`))
        return null
      }, [])

      /**
       * `silent` is what the poll uses: a failed BACKGROUND request must never
       * clear the last known state nor raise a banner the user did not ask for.
       */
      const loadOverview = React.useCallback(async (options) => {
        const result = await postJson('/overview', { force: options?.force === true }, OVERVIEW_TIMEOUT_MS)
        if (!result.ok) {
          if (options?.silent !== true) setError(result.aborted ? 'timeout' : 'host')
          return
        }
        if (result.response.ok && result.payload?.ok === true) {
          setOverview(result.payload.value ?? null)
          if (options?.silent !== true) setError(null)
        }
      }, [])

      /**
       * The npm registry's view of every configured package.
       *
       * Deliberately NOT part of the overview. The overview is polled every thirty
       * seconds and answers from GitHub; this costs one HTTPS request per repository
       * plus a `whoami`, and its answer changes when someone publishes — so it is
       * fetched when the panel opens, after a publish, and when asked.
       *
       * A failure is reported as "no npm information", never as an empty one: a chip
       * that says "not on npm" because the registry could not be reached would be a
       * statement the Host never made.
       */
      const loadNpm = React.useCallback(async (options) => {
        const result = await postJson('/npm-status', { force: options?.force === true }, NPM_TIMEOUT_MS)
        if (!result.ok || !result.response.ok || result.payload?.ok !== true) return
        setNpm(result.payload.value ?? null)
      }, [])

      /**
       * The Bilibili side: which credential, which video, and what was said.
       *
       * Also not polled, and for a second reason on top of npm's: the answer
       * includes a video lookup and an account lookup, and the panel asks for it
       * when it opens, after an action, and when a person asks. The Host caches
       * both answers (`bilibiliVerifyTtlMs`), so even a refresh loop is bounded.
       */
      const loadBili = React.useCallback(async (options) => {
        const result = await postJson('/bilibili-status', { force: options?.force === true }, OVERVIEW_TIMEOUT_MS)
        if (!result.ok || !result.response.ok || result.payload?.ok !== true) return
        setBili(result.payload.value ?? null)
      }, [])

      return { status, overview, npm, bili, error, setError, loadStatus, loadOverview, loadNpm, loadBili }
    }

    /** Human-readable text for the transport and version failures. */
    function errorText(t, code) {
      if (code === 'timeout') return t('state.timeout')
      if (code === 'host') return t('state.hostGone')
      if (code === 'stale-host') return t('stale.text')
      return code
    }

    /**
     * Whether a response means "this Host half does not have that route".
     *
     * The local web server answers an unmounted `/api/*` path with 401; a Host
     * that mounts a different set can also 404. Both are version mismatches first
     * and request failures second, so they get the version message.
     */
    function isMissingRoute(status) {
      return status === 401 || status === 404
    }

    /** Whether a sign-in or a scope grant is still required. */
    function needsAccountSetup(gh) {
      if (gh.available !== true) return true
      if (gh.authenticated !== true) return true
      return Array.isArray(gh.missingScopes) && gh.missingScopes.length > 0
    }

    /** The console panel: compact rows, and the picker behind one button. */
    function ConsolePage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { status, overview, npm, bili, error, setError, loadStatus, loadOverview, loadNpm, loadBili } = useConsoleState()
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [logs, setLogs] = React.useState(null)
      /**
       * The npm token being typed, held only until the request that writes it.
       *
       * It lives in page state rather than anywhere durable on purpose: the Host
       * writes it to the user-level `.npmrc` that npm itself reads, and clears it from
       * the field the moment that answers.
       */
      const [npmToken, setNpmToken] = React.useState('')
      /** Set when a pasted token was refused, which is when the checklist is read. */
      const [npmTokenRejected, setNpmTokenRejected] = React.useState(false)
      /** The classified outcome of the last publish: `otp-required`, `E403`, … */
      const [npmFailure, setNpmFailure] = React.useState(null)
      /**
       * The update that just landed and the restart it needs.
       *
       * Held as state rather than folded into the notice, because a notice is a
       * sentence that expires and this is a question with two buttons. It is also
       * the one thing here that cannot be discovered later: an updated plugin looks
       * identical until the app restarts, so "you are not running the new code yet"
       * has to be on screen while the user is still looking.
       */
      const [restartPrompt, setRestartPrompt] = React.useState(null)
      /**
       * Which view this panel opens in.
       *
       * A first visit is about setting the tool up, so it opens on the repository
       * list; afterwards the last choice wins. Without this, re-entering the panel
       * dropped back to the setup view every time — even for someone who had just
       * finished configuring it and wanted to see the repositories.
       */
      const [managing, setManaging] = React.useState(() => {
        try {
          const stored = globalThis.localStorage?.getItem('dsh-cicd.managing')
          if (stored === 'true') return true
          if (stored === 'false') return false
        } catch {
          /* storage can be unavailable; the default below is fine */
        }
        return true
      })
      React.useEffect(() => {
        try {
          globalThis.localStorage?.setItem('dsh-cicd.managing', String(managing))
        } catch {
          /* a preference that cannot be stored is not worth failing over */
        }
      }, [managing])

      React.useEffect(() => {
        void loadStatus()
        void loadOverview({ force: true })
        // Once, not on the poll: the npm answer changes when someone publishes.
        void loadNpm({})
        // And likewise: a Bilibili answer includes an account and a video lookup.
        void loadBili({})
      }, [loadStatus, loadOverview, loadNpm, loadBili])

      const pollSeconds = status?.config?.pollSeconds ?? 30
      React.useEffect(() => {
        const timer = globalThis.setInterval(() => {
          void loadOverview({ silent: true })
        }, Math.max(10, pollSeconds) * 1000)
        return () => {
          globalThis.clearInterval(timer)
        }
      }, [loadOverview, pollSeconds])

      /**
       * Refresh when the panel comes back into view.
       *
       * This panel can stay mounted while another one is selected, so re-entering it
       * used to show whatever had last been rendered — up to a full poll interval
       * old, which reads as "it still shows the old screen".
       */
      React.useEffect(() => {
        const onVisible = () => {
          if (document.visibilityState === 'visible') void loadOverview({ force: true })
        }
        document.addEventListener('visibilitychange', onVisible)
        globalThis.addEventListener?.('focus', onVisible)
        return () => {
          document.removeEventListener('visibilitychange', onVisible)
          globalThis.removeEventListener?.('focus', onVisible)
        }
      }, [loadOverview])

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = globalThis.setTimeout(() => {
          setNotice(null)
        }, NOTICE_TTL_MS)
        return () => {
          globalThis.clearTimeout(timer)
        }
      }, [notice])

      /** Run one mutating route, then refresh so the panel shows its effect. */
      const run = React.useCallback(
        async (key, path, body, successKey, params) => {
          setBusy(key)
          setNotice(null)
          setError(null)
          const result = await postJson(path, body, ACTION_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? 'timeout' : 'host')
            return
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            return
          }
          setNotice(t(successKey, params))
          await loadOverview({ force: true })
        },
        [loadOverview, setError, t],
      )

      const onAction = React.useCallback(
        (kind, data, extra) => {
          if (kind === 'build') {
            const workflow = status?.config?.buildWorkflow ?? 'ci.yml'
            void run(`build:${data.repo}`, '/dispatch', { repo: data.repo, workflow }, 'state.dispatched', { workflow, repo: data.repo })
            return
          }
          if (kind === 'release') {
            void run(`release:${data.repo}`, '/dispatch', { repo: data.repo, workflow: status?.config?.releaseWorkflow ?? 'release.yml', inputs: { draft: 'true' } }, 'state.releaseDispatched', { repo: data.repo })
            return
          }
          void run(`${kind}:${data.repo}`, '/run-action', { repo: data.repo, runId: extra?.runId, action: kind }, kind === 'cancel' ? 'state.cancelled' : 'state.rerun', {})
        },
        [run, status],
      )

      const onPublish = React.useCallback(
        (repo, tag) => {
          void run(`publish:${repo}`, '/release-action', { repo, tag, action: 'publish' }, 'state.published', { tag })
        },
        [run],
      )

      /**
       * Bump the version, push it, then dispatch the release.
       *
       * One action rather than two buttons because neither half stands alone: a bump
       * with no release leaves a commit nobody asked for, and a release with no bump
       * is the run that could only fail. The new version is the Host's own
       * arithmetic — the number in the confirmation is the number that gets written —
       * and a failed bump reports why without dispatching anything.
       */
      const onBump = React.useCallback(
        async (data) => {
          const key = `bump:${data.repo}`
          setBusy(key)
          setNotice(null)
          setError(null)
          const bumped = await postJson('/version-bump', { repo: data.repo, release: 'patch' }, ACTION_TIMEOUT_MS)
          if (!bumped.ok) {
            setBusy('')
            setError('timeout')
            return
          }
          if (!bumped.response.ok || bumped.payload?.ok !== true) {
            setBusy('')
            setError(t('state.actionFailed', { reason: releaseFailure(t, bumped.payload, bumped.response) }))
            await loadOverview({ force: true })
            return
          }
          const value = bumped.payload.value ?? {}
          const dispatched = await postJson('/dispatch', {
            repo: data.repo,
            workflow: status?.config?.releaseWorkflow ?? 'release.yml',
            inputs: { draft: 'true' },
          }, ACTION_TIMEOUT_MS)
          setBusy('')
          if (!dispatched.ok || !dispatched.response.ok || dispatched.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: releaseFailure(t, dispatched.payload, dispatched.response) }))
            await loadOverview({ force: true })
            return
          }
          setNotice(t('state.releaseBumped', {
            from: String(value.from ?? '?'),
            tag: String(value.tag ?? ''),
            branch: String(value.branch ?? ''),
          }))
          await loadOverview({ force: true })
        },
        [loadOverview, setError, status, t],
      )

      /**
       * Install the release into this profile, then ask about the restart.
       *
       * Deliberately not routed through `run`: that helper reports success with one
       * sentence and refreshes, and this action's result is a question. The Host is
       * the one that says whether a restart is needed (`restartRequired`), so the
       * prompt follows the answer instead of assuming it.
       */
      const onUpdate = React.useCallback(
        async (data) => {
          const key = `update:${data.repo}`
          const tag = String(data?.install?.latestTag ?? '')
          setBusy(key)
          setNotice(null)
          setError(null)
          setRestartPrompt(null)
          const result = await postJson('/update', { repo: data.repo }, UPDATE_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? 'timeout' : 'host')
            return
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            await loadOverview({ force: true })
            return
          }
          const value = result.payload.value ?? {}
          const builds = Array.isArray(value.pendingBuilds) ? value.pendingBuilds.length : 0
          /*
           * `changed: false` is the honest answer when the profile already pointed at
           * exactly this tarball: nothing was written, so nothing needs restarting,
           * and saying "已从 X 换成 Y" would describe a write that did not happen.
           */
          setNotice(value.changed === false
            ? t('state.updatedSame', { package: String(value.packageName ?? data.repo), tag: String(value.tag ?? tag) })
            : t('state.updated', {
                package: String(value.packageName ?? data.repo),
                from: value.from === null || value.from === undefined ? '—' : `v${String(value.from)}`,
                tag: String(value.tag ?? tag),
              }) + (builds > 0 ? ` ${t('state.updatedBuilds', { count: String(builds) })}` : ''))
          if (value.restartRequired === true) {
            setRestartPrompt({ package: String(value.packageName ?? data.repo), tag: String(value.tag ?? tag) })
          }
          await loadOverview({ force: true })
        },
        [loadOverview, setError, t],
      )

      /**
       * Ask the one-click restart plugin to restart DSH.
       *
       * The Host forwards this to `/api/dsh-restart/restart` on its own authority, so
       * a missing restart plugin comes back as a named 501 rather than a bare
       * failure — and this page never talks to another plugin directly.
       */
      const onRestart = React.useCallback(async () => {
        setBusy('restart')
        setError(null)
        const result = await postJson('/restart', {}, ACTION_TIMEOUT_MS)
        setBusy('')
        if (!result.ok) {
          setError(result.aborted ? 'timeout' : 'host')
          return
        }
        if (!result.response.ok || result.payload?.ok !== true) {
          setError(t('restart.unavailable', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
          return
        }
        setRestartPrompt(null)
        setNotice(t('restart.scheduled'))
      }, [setError, t])

      /**
       * Push one package to npm.
       *
       * The one-time password is passed through and then thrown away, and every
       * refusal comes back as the Host's own sentence — `private-package`,
       * `dirty-tree` and `already-published` are three different fixes and the panel
       * does not try to paraphrase them.
       */
      const onNpmPublish = React.useCallback(
        async (data, otp) => {
          const key = `npm:${data.repo}`
          setBusy(key)
          setNotice(null)
          setError(null)
          const result = await postJson('/npm-publish', { repo: data.repo, otp: String(otp ?? '') }, UPDATE_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? 'timeout' : 'host')
            return
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            /* The named outcome is what turns npm's own words into a next step. */
            setNpmFailure(String(result.payload?.code ?? 'unknown'))
            await loadNpm({ force: true })
            return
          }
          setNpmFailure(null)
          const value = result.payload.value ?? {}
          setNotice(t(value.wasUnregistered === true ? 'state.npmFirstPublish' : 'state.npmPublished', {
            package: String(value.packageName ?? data.repo),
            version: String(value.version ?? ''),
            registry: String(value.registry ?? ''),
          }))
          await loadNpm({ force: true })
        },
        [loadNpm, setError, t],
      )

      /**
       * Write an npm token where npm itself reads it, and prove it works.
       *
       * The promise the panel makes about credentials is the one it already keeps for
       * `gh`: it stores none. The token goes into the user-level `.npmrc` — the same
       * file `npm login` writes — and is cleared from the field as soon as the Host
       * answers, so it is not left sitting in a page that stays open for hours.
       */
      const onNpmLogin = React.useCallback(async () => {
        setBusy('npm-login')
        setNotice(null)
        setError(null)
        const result = await postJson('/npm-login', { token: npmToken }, ACTION_TIMEOUT_MS)
        setBusy('')
        setNpmToken('')
        if (!result.ok) {
          setError(result.aborted ? 'timeout' : 'host')
          return
        }
        if (!result.response.ok || result.payload?.ok !== true) {
          setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
          setNpmTokenRejected(result.payload?.code === 'token-rejected')
          await loadNpm({ force: true })
          return
        }
        setNpmTokenRejected(false)
        const value = result.payload.value ?? {}
        setNotice(t('npm.tokenWritten', { npmrc: String(value.npmrcPath ?? ''), account: String(value.account ?? '') }))
        await loadNpm({ force: true })
      }, [loadNpm, npmToken, setError, t])

      const onLogs = React.useCallback(async (data, entry) => {
        if (logs !== null && logs.repo === data.repo && logs.runId === entry.id) {
          setLogs(null)
          return
        }
        const result = await postJson('/logs', { repo: data.repo, runId: entry.id }, ACTION_TIMEOUT_MS)
        if (!result.ok || !result.response.ok || result.payload?.ok !== true) {
          setError(t('state.actionFailed', { reason: result.payload?.message ?? 'logs unavailable' }))
          return
        }
        setLogs({ repo: data.repo, runId: entry.id, lines: result.payload.value?.lines ?? [], truncated: result.payload.value?.truncated === true })
      }, [logs, setError, t])

      /**
       * Bind or unbind a repository's video.
       *
       * `auto` is carried through on every save so that toggling the switch does not
       * silently re-enable a binding someone deliberately made manual — the Host
       * takes the whole binding on each write, and the panel sends the whole binding.
       */
      const onBiliBind = React.useCallback(
        async (data, bvid, auto) => {
          const key = `bili-bind:${data.repo}`
          setBusy(key)
          setNotice(null)
          setError(null)
          const result = await postJson('/bilibili-bind', { repo: data.repo, bvid: String(bvid ?? ''), auto: auto !== false }, ACTION_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? 'timeout' : 'host')
            return
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            await loadBili({ force: true })
            return
          }
          const value = result.payload.value ?? {}
          if (String(value.bvid ?? '') === '') {
            setNotice(t('bili.unbound.done', { repo: data.repo }))
          } else {
            const baseline = value.baseline
              ? t('bili.bind.baseline', { tag: String(value.baseline) })
              : (value.note ? t('bili.bind.baselineUnknown') : '')
            setNotice(t('bili.bind.done', { bvid: String(value.bvid), baseline }))
          }
          await loadBili({ force: true })
          await loadOverview({ force: true })
        },
        [loadBili, loadOverview, setError, t],
      )

      /**
       * Ask the Host what the comment would say, without sending it.
       *
       * A dry run rather than a client-side composition: the template and the
       * summary are the Host's, and a page that assembled its own preview could
       * show one sentence and post another.
       */
      const onBiliPreview = React.useCallback(
        async (data, tag) => {
          const key = `bili-preview:${data.repo}`
          setBusy(key)
          setError(null)
          const result = await postJson('/bilibili-announce', { repo: data.repo, tag: String(tag ?? ''), dryRun: true }, ACTION_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? 'timeout' : 'host')
            return null
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            return null
          }
          return result.payload.value ?? null
        },
        [setError, t],
      )

      /** Send the previewed comment, exactly as previewed unless it was edited. */
      const onBiliAnnounce = React.useCallback(
        async (data, preview, text, force) => {
          const key = `bili-announce:${data.repo}`
          setBusy(key)
          setNotice(null)
          setError(null)
          const result = await postJson('/bilibili-announce', {
            repo: data.repo,
            tag: String(preview?.tag ?? ''),
            text: String(text ?? ''),
            force: force === true,
          }, ACTION_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? 'timeout' : 'host')
            return null
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            await loadBili({ force: true })
            return null
          }
          const value = result.payload.value ?? {}
          setNotice(t('bili.announce.sent', { bvid: String(value.bvid ?? ''), tag: String(value.tag ?? '') }))
          await loadBili({ force: true })
          return value
        },
        [loadBili, setError, t],
      )

      /**
       * The configured list comes from `/status`, the loaded detail from
       * `/overview`.
       *
       * They are not interchangeable. `/status` is cheap and knows the
       * configuration; `/overview` fans out three GitHub calls per repository and
       * takes a moment. Deciding "is anything registered?" from the expensive one
       * meant that any moment before it landed — or any failure — made the panel
       * announce 还没有登记仓库 to someone who had just registered five, and it hid
       * the reason at the same time.
       */
      const configured = status?.repos ?? []
      const repos = overview?.repos ?? []
      const gh = status?.gh ?? {}
      /**
       * npm's answers, keyed by the configured repository string.
       *
       * The overview and the npm status arrive independently, so a row renders
       * without its npm chip until the second answer lands — and renders without one
       * forever if that answer never comes, which is the point.
       */
      const npmByRepo = new Map((npm?.repos ?? []).map((entry) => [entry.repo, entry]))
      const npmAuth = npm?.auth ?? null
      /**
       * Bilibili's answers, keyed the same way and arriving independently.
       *
       * A row renders without its binding block until this lands, which is the
       * honest state: the panel has not been told which video this repository
       * speaks to yet.
       */
      const biliByRepo = new Map((bili?.repos ?? []).map((entry) => [entry.repo, entry]))
      /**
       * Whether the Bilibili side is blocked on a credential.
       *
       * Shown in the panel only when a video is actually bound and the credential
       * cannot post: a repository nobody bound must not be nagged about a feature
       * that is not in use, and a bound one that cannot post is exactly the state
       * where a silent sweep would fail forever.
       */
      const biliBlocked = bili !== null
        && (bili.repos ?? []).some((entry) => entry.binding !== null)
        && bili.credential?.state !== 'ready'
      /**
       * Three states, not a boolean — the Host's `npmAuthState`.
       *
       * A granular token is scoped to packages, so `whoami` (a user-level endpoint)
       * can refuse it while `publish` accepts it. Collapsing that into "not signed in"
       * would show the four-step guide to someone who just finished step 3.
       */
      const npmCredential = npmAuth === null
        // No answer is not "no credential": rendering the four-step guide here would
        // claim the machine has nothing to authenticate with, which nobody has said.
        ? 'unknown'
        : String(npmAuth.state ?? (npmAuth.loggedIn === true ? 'signed-in' : 'none'))
      const npmHintText = (() => {
        if (npmFailure === null) return null
        const text = t(`npm.hint.${npmFailure}`)
        return text === `npm.hint.${npmFailure}` ? null : text
      })()
      const missing = Array.isArray(gh.missingScopes) ? gh.missingScopes : []
      const setupNeeded = status !== null && (needsAccountSetup(gh) || configured.length === 0)
      const draftCount = repos.filter((entry) => entry.draftTag !== null && entry.draftTag !== undefined).length
      /** Configured repositories whose detail has not arrived yet, shown as placeholders. */
      const pendingRows = configured.length > repos.length
        ? configured
            .filter((entry) => !repos.some((loaded) => loaded.repo === entry.repo))
            .map((entry) => ({
              repo: entry.repo,
              label: entry.label,
              localPath: entry.localPath,
              pending: true,
              version: null,
              versionKnown: false,
              expectedTag: null,
              published: false,
              publishedTag: null,
              draftTag: null,
              latestRun: null,
              runs: [],
              releases: [],
              workflows: [],
              hasBuildWorkflow: false,
              hasReleaseWorkflow: false,
              problems: [],
              local: { available: false },
            }))
        : []
      // The page and the Host half load independently, so they can disagree.
      const stale = status !== null && status.protocol !== PROTOCOL

      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'div',
          { className: 'dsc-bar' },
          h(
            'div',
            { className: 'dsc-heading' },
            h('span', { className: 'dsc-title' }, t('title')),
            h('span', { className: 'dsc-subtitle' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'dsc-meta' },
            gh.account !== null && gh.account !== undefined ? h(Chip, { state: 'idle' }, `${t('meta.account')} ${gh.account}`) : null,
            npmAuth !== null && npmAuth.loggedIn === true
              ? h(Chip, { state: 'idle', title: String(npm.registry ?? '') }, t('npm.account', { account: String(npmAuth.account ?? '') }))
              : null,
            overview !== null && typeof overview.fetchedAt === 'string'
              ? h('span', null, t('meta.updated', { time: stamp(overview.fetchedAt) }), overview.cached === true ? ` (${t('meta.cached')})` : '')
              : null,
            h(Btn, { onClick: () => { void loadStatus(); void loadOverview({ force: true }) } }, t('action.refresh')),
            h(Btn, { kind: managing ? 'primary' : undefined, onClick: () => setManaging((value) => !value) }, managing ? t('action.close') : t('action.manage')),
          ),
        ),

        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, errorText(t, error)) : null,
        /* The next step for a named npm failure. Rendered only when a hint exists for
           that code, so an unmapped name can never print a dictionary key on screen. */
        npmHintText !== null ? h('div', { className: 'dsc-warn', role: 'status' }, npmHintText) : null,
        notice !== null ? h('div', { className: 'dsc-notice', role: 'status' }, notice) : null,
        /* The question an update leaves behind. It sits above the list rather than
           inside the row, because the row is about a repository and this is about
           the application the user is looking at. */
        restartPrompt !== null
          ? h(
              'div',
              { className: 'dsc-setup', role: 'status' },
              h('span', { className: 'dsc-setup-strong' }, t('restart.ask', { package: restartPrompt.package, tag: restartPrompt.tag })),
              h(
                'div',
                { className: 'dsc-setup-line' },
                h(Btn, { kind: 'primary', disabled: busy !== '', onClick: () => { void onRestart() } }, busy === 'restart' ? '…' : t('action.restartNow')),
                h(Btn, { kind: 'quiet', onClick: () => setRestartPrompt(null) }, t('action.restartLater')),
              ),
            )
          : null,
        /*
         * The npm credential, in the operational view.
         *
         * The four steps live on their own settings page, because that is where
         * configuration belongs and where every package's npm state is listed. Here the
         * panel says which of the two states this machine is in, offers the one control
         * that resolves it, and points at the guide — so a first-time publisher who
         * lands on the push button still has a way forward without a terminal, without
         * four steps of onboarding sitting above a live repository list.
         */
        npmCredential === 'none' || npmCredential === 'credential-present'
          ? h(
              'div',
              { className: 'dsc-setup', role: 'status' },
              h('span', { className: 'dsc-setup-strong' }, npmCredential === 'none'
                ? t('npm.notLoggedIn', {
                    command: String(npm?.packageManager?.command ?? 'pnpm'),
                    registry: String(npm?.registry ?? ''),
                  })
                : t('npm.credentialPresentTitle')),
              npmCredential === 'none'
                ? null
                : h('span', null, t('npm.credentialPresentShort', { registry: String(npm?.registry ?? '') })),
              /* What `whoami` actually said, because "not signed in" and "this token was
                 revoked" look identical and need different fixes. */
              npmAuth?.message !== null && npmAuth?.message !== undefined
                ? h('span', { className: 'dsc-mono' }, String(npmAuth.message))
                : null,
              h(
                'div',
                { className: 'dsc-setup-line' },
                h('input', {
                  className: 'dsc-input',
                  type: 'password',
                  autoComplete: 'off',
                  spellCheck: 'false',
                  placeholder: t('npm.tokenPlaceholder'),
                  'aria-label': t('npm.tokenPlaceholder'),
                  value: npmToken,
                  onChange: (event) => setNpmToken(String(event?.target?.value ?? '')),
                }),
                h(Btn, {
                  kind: 'primary',
                  disabled: busy !== '' || npmToken.trim() === '',
                  onClick: () => { void onNpmLogin() },
                }, busy === 'npm-login' ? '…' : t('npm.writeToken')),
                h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => { void loadNpm({ force: true }) } }, t('npm.recheck')),
              ),
              npmTokenRejected
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'dsc-warn' }, t('npm.rejectedTitle')),
                    h('span', null, t('npm.rejectedCauses')),
                  )
                : null,
              h('span', { className: 'dsc-quiet' }, t('npm.moreInSettings')),
            )
          : null,
        stale
          ? h('div', { className: 'dsc-warn', role: 'alert' }, h('strong', null, t('stale.title')), ' — ', t('stale.how'))
          : null,
        /*
         * A bound video with no usable credential is the one Bilibili state the
         * panel has to raise on its own: every subsequent release would silently
         * fail to announce, and a failure nobody sees is the shape this project
         * keeps writing tests against.
         */
        biliBlocked && !stale
          ? h(
              'div',
              { className: 'dsc-setup', role: 'status' },
              h('span', { className: 'dsc-setup-strong' }, t('bili.needCredential')),
              h('span', { className: 'dsc-quiet' }, t('bili.openSettings')),
              h(BilibiliSignIn, {
                t,
                bili,
                busy,
                setBusy,
                setNotice,
                setError,
                onChanged: () => loadBili({ force: true }),
              }),
            )
          : null,
        /* The one outcome the panel could report as "nothing happened". Say it, and
           say what to press, instead of leaving it inside a collapsed row. */
        draftCount > 0
          ? h(
              'div',
              { className: 'dsc-warn', role: 'status' },
              h('strong', null, t('drafts.title', { count: String(draftCount) })),
              ' — ',
              t('drafts.text'),
            )
          : null,

        setupNeeded && !stale
          ? h(
              'div',
              { className: 'dsc-setup' },
              h('span', { className: 'dsc-setup-strong' }, gh.available !== true
                ? t('setup.needGh')
                : gh.authenticated !== true
                  ? t('setup.needSignIn')
                  : missing.length > 0
                    ? t('setup.needScopes', { scopes: missing.join(', ') })
                    : t('setup.needRepos')),
              missing.length > 0 ? h('span', null, t('setup.scopeHint')) : null,
              h(SignIn, { t, status, onChanged: () => { void loadStatus(); void loadOverview({ force: true }) } }),
              h(
                'details',
                null,
                h('summary', null, t('setup.advanced')),
                h(
                  'div',
                  { className: 'dsc-sub' },
                  h('span', null, t('setup.ghInstall')),
                  h(CopyLine, { t, command: 'winget install --id GitHub.cli' }),
                  h(CopyLine, { t, command: `node "${status?.helper?.configureScript ?? 'scripts/configure.mjs'}" list` }),
                ),
              ),
            )
          : null,

        managing && !stale ? h(RepoPicker, { t, onChanged: () => { void loadStatus(); void loadOverview({ force: true }) } }) : null,

        repos.length > 0 || pendingRows.length > 0
          ? h(
              'div',
              { className: 'dsc-list' },
              repos.map((data) => h(RepoRow, {
                key: data.repo,
                t,
                data,
                busy,
                onAction,
                onBump: () => onBump(data),
                onPublish: (tag) => onPublish(data.repo, tag),
                onUpdate: () => { void onUpdate(data) },
                npm: npmByRepo.get(data.repo) ?? null,
                onNpmPublish,
                bili: biliByRepo.get(data.repo) ?? null,
                onBiliBind,
                onBiliPreview,
                onBiliAnnounce,
                logs,
                onLogs,
              })),
              // Registered but not read yet: show the row with an honest "reading"
              // state instead of rendering nothing and implying an empty list.
              pendingRows.map((data) => h(RepoRow, {
                key: data.repo,
                t,
                data,
                busy,
                onAction,
                onBump: () => {},
                onPublish: () => {},
                logs: null,
                onLogs: async () => {},
              })),
            )
          : null,
      )
    }

    /**
     * The npm credential control, shared by the panel and the settings page.
     *
     * One implementation because the two surfaces must not drift: the panel shows the
     * short state and the settings page shows the four steps, but both write the same
     * file through the same route and have to report the same outcome. The token lives
     * here only until the request that writes it answers, and is cleared then.
     */
    function useNpmCredential(t, loadNpm, setError, setNotice) {
      const [token, setToken] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [rejected, setRejected] = React.useState(false)
      const login = React.useCallback(async () => {
        setBusy(true)
        setRejected(false)
        setError(null)
        const result = await postJson('/npm-login', { token }, ACTION_TIMEOUT_MS)
        setBusy(false)
        setToken('')
        if (!result.ok) {
          setError(result.aborted ? 'timeout' : 'host')
          return
        }
        if (!result.response.ok || result.payload?.ok !== true) {
          setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
          setRejected(result.payload?.code === 'token-rejected')
          await loadNpm({ force: true })
          return
        }
        setRejected(false)
        const value = result.payload.value ?? {}
        setNotice(t('npm.tokenWritten', { npmrc: String(value.npmrcPath ?? ''), account: String(value.account ?? '') }))
        await loadNpm({ force: true })
      }, [loadNpm, setError, setNotice, t, token])
      return { token, setToken, busy, rejected, login }
    }

    /** The token field and its two buttons — the control step ③ is about. */
    function NpmTokenLine(props) {
      const { t, credential, busy } = props
      return h(
        'div',
        { className: 'dsc-setup-line' },
        h('input', {
          className: 'dsc-input',
          type: 'password',
          autoComplete: 'off',
          spellCheck: 'false',
          placeholder: t('npm.tokenPlaceholder'),
          'aria-label': t('npm.tokenPlaceholder'),
          value: credential.token,
          onChange: (event) => credential.setToken(String(event?.target?.value ?? '')),
        }),
        h(Btn, {
          kind: 'primary',
          disabled: busy !== '' || credential.token.trim() === '',
          onClick: () => { void credential.login() },
        }, credential.busy ? '…' : t('npm.writeToken')),
      )
    }

    /** The checklist a refused token needs, shown exactly when it is refused. */
    function NpmRejectedNote(props) {
      if (props.rejected !== true) return null
      return h(
        React.Fragment,
        null,
        h('span', { className: 'dsc-warn' }, props.t('npm.rejectedTitle')),
        h('span', null, props.t('npm.rejectedCauses')),
      )
    }

    /**
     * The four steps, as a configuration guide rather than a paragraph.
     *
     * A step gets a status only where the Host can actually know one. It can see a
     * token line in `.npmrc`, and it can see an account once `whoami` answers — it
     * cannot see whether an account was registered or a token was generated, and a
     * guide that ticked those off would be inventing progress. So ① and ② carry a
     * tick only after a credential proves they happened, and say "cannot be detected"
     * until then; ③ is the one step with a live state of its own.
     */
    function NpmCredentialGuide(props) {
      const { t, npm, credential } = props
      const account = npm?.auth?.account ?? null
      const registry = String(npm?.registry ?? '')
      const npmrcPath = String(npm?.auth?.npmrcPath ?? '')
      const hasToken = npm?.auth?.npmrcHasToken === true
      const proven = account !== null
      const status = (kind, text) => h(Chip, { state: kind === 'done' ? 'success' : kind === 'todo' ? 'warn' : 'idle' }, text)
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dsc-setup-line' },
          h('span', { className: 'dsc-setup-strong' }, t('npm.guide.step1')),
          proven
            ? status('done', t('npm.stepAccountDone', { account: String(account) }))
            : status('unknown', t('npm.stepUnknown')),
        ),
        h(
          'div',
          { className: 'dsc-setup-line' },
          h(Btn, { onClick: () => globalThis.open(NPM_SIGNUP_URL, '_blank', 'noopener,noreferrer') }, t('npm.guide.signup')),
        ),
        h('span', null, t('npm.guide.emailNote')),

        h(
          'div',
          { className: 'dsc-setup-line' },
          h('span', { className: 'dsc-setup-strong' }, t('npm.guide.step2')),
          proven ? status('done', t('npm.stepTokenDone')) : status('unknown', t('npm.stepUnknown')),
        ),
        h(
          'div',
          { className: 'dsc-setup-line' },
          h(Btn, { onClick: () => globalThis.open(NPM_TOKENS_URL, '_blank', 'noopener,noreferrer') }, t('npm.guide.tokens')),
          h(Btn, { kind: 'quiet', onClick: () => globalThis.open(NPM_TOKEN_DOCS_URL, '_blank', 'noopener,noreferrer') }, t('npm.guide.docs')),
        ),
        h('span', null, t('npm.guide.tokenType')),
        h('span', null, t('npm.guide.tokenScope')),
        h('span', null, t('npm.guide.tokenExpiry')),
        h('span', null, t('npm.guide.token2fa')),
        /* The step that is not on this machine: npmjs.com sits behind a bot challenge
           that answers whole-site 403s to some networks, and the token does not care
           where it was minted. Saying so here is the difference between a five-minute
           workaround and an afternoon spent on the wrong problem. */
        h('span', { className: 'dsc-quiet' }, t('npm.guide.blocked')),

        h(
          'div',
          { className: 'dsc-setup-line' },
          h('span', { className: 'dsc-setup-strong' }, t('npm.guide.step3')),
          hasToken ? status('done', t('npm.stepWrittenDone', { npmrc: npmrcPath })) : status('todo', t('npm.stepTodo')),
        ),
        h(NpmTokenLine, { t, credential, busy: props.busy }),
        h('span', null, t('npm.guide.step3Note', { npmrc: npmrcPath })),
        h(NpmRejectedNote, { t, rejected: credential.rejected }),

        h(
          'div',
          { className: 'dsc-setup-line' },
          h('span', { className: 'dsc-setup-strong' }, t('npm.guide.step4')),
          status('unknown', t('npm.stepUnknown')),
        ),
        h('span', null, t('npm.guide.step4Note')),

        /* What the package manager said, verbatim: "not signed in" and "that token was
           revoked" are the same blank state and different problems. */
        npm?.auth?.message !== null && npm?.auth?.message !== undefined
          ? h('span', { className: 'dsc-mono' }, String(npm.auth.message))
          : null,
        h('span', { className: 'dsc-quiet' }, t('npm.ciHint')),
      )
    }

    /**
     * The Settings page for npm credentials: the guide, and every package's state.
     *
     * The panel answers "which repository needs attention"; this page answers "can
     * this machine publish at all, and which of my packages are already up there" —
     * which is configuration, not operation, and belongs where the GitHub account
     * page already lives.
     */
    function NpmCredentialsPage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { npm, error, setError, loadNpm } = useConsoleState()
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const credential = useNpmCredential(t, loadNpm, setError, setNotice)

      React.useEffect(() => {
        void loadNpm({ force: true })
      }, [loadNpm])

      const auth = npm?.auth ?? null
      const state = auth === null ? 'unknown' : String(auth.state ?? (auth.loggedIn === true ? 'signed-in' : 'none'))

      const recheck = React.useCallback(async () => {
        setBusy('recheck')
        await loadNpm({ force: true })
        setBusy('')
      }, [loadNpm])

      const packageState = (entry) => {
        if (entry.state === 'published') return { kind: 'success', text: t('npm.package.published') }
        if (entry.state === 'unregistered') return { kind: 'warn', text: t('npm.package.unregistered') }
        if (entry.state === 'unpublished') return { kind: 'warn', text: t('npm.package.unpublished') }
        return { kind: 'idle', text: t('npm.package.unknown') }
      }
      const blockerText = (entry) => {
        const first = Array.isArray(entry.blockers) ? entry.blockers[0] : null
        if (first === null) return null
        const key = `npm.blocked.${first}`
        const text = t(key)
        return text === key ? null : text
      }

      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'div',
          { className: 'dsc-bar' },
          h(
            'div',
            { className: 'dsc-heading' },
            h('span', { className: 'dsc-title' }, t('settings.npmTitle')),
            h('span', { className: 'dsc-subtitle' }, t('settings.npmSubtitle')),
          ),
          h(Btn, { disabled: busy !== '', onClick: () => { void recheck() } }, busy === 'recheck' ? '…' : t('npm.packages.recheck')),
        ),

        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, errorText(t, error)) : null,
        notice !== null ? h('div', { className: 'dsc-notice', role: 'status' }, notice) : null,

        npm === null
          ? h('div', { className: 'dsc-setup' }, h('span', { className: 'dsc-setup-strong' }, t('npm.status.unknown')), h('span', null, t('npm.status.unknownHint')))
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dsc-setup-line' },
                h('span', { className: 'dsc-setup-strong' }, t('npm.status.title')),
                state === 'signed-in'
                  ? h(Chip, { state: 'success' }, t('npm.status.signedIn', { account: String(auth.account ?? '?') }))
                  : state === 'credential-present'
                    ? h(Chip, { state: 'idle' }, t('npm.status.credentialPresent'))
                    : h(Chip, { state: 'warn' }, t('npm.status.none')),
                h('span', { className: 'dsc-mono' }, t('npm.registry', { registry: String(npm.registry ?? '') })),
              ),
              /* "Signed in" and "a credential that whoami will not confirm" are the same
                 blank state on screen and different situations, so this page spells the
                 second one out instead of collapsing it into the first. */
              state === 'credential-present'
                ? h('span', null, t('npm.credentialPresent', { registry: String(npm.registry ?? ''), npmrc: String(auth.npmrcPath ?? '') }))
                : null,
              /* The guide is the page's reason to exist, so it is always here — the
                 panel is where it would be in the way. */
              h(
                'div',
                { className: 'dsc-setup' },
                h('span', { className: 'dsc-setup-strong' }, t('settings.npmGuideTitle')),
                h(NpmCredentialGuide, { t, npm, credential, busy }),
              ),
              h(
                'div',
                { className: 'dsc-sub' },
                h('span', { className: 'dsc-setup-strong' }, t('npm.packages.title')),
                (npm.repos ?? []).length === 0
                  ? h('span', null, t('npm.packages.empty'))
                  : (npm.repos ?? []).map((entry) =>
                      h(
                        'div',
                        { className: 'dsc-line', key: entry.repo },
                        h('span', { className: 'dsc-name', style: { minWidth: '0', fontWeight: '500' } }, String(entry.packageName ?? entry.repo)),
                        h(Chip, { state: packageState(entry).kind }, packageState(entry).text),
                        h('span', { className: 'dsc-grow' }, `${t('npm.package.local', { version: String(entry.version ?? '?') })}${entry.latest === null || entry.latest === undefined ? '' : ` · ${t('npm.package.latest', { latest: String(entry.latest) })}`}`),
                        blockerText(entry) === null ? null : h('span', { className: 'dsc-quiet' }, blockerText(entry)),
                        entry.pageUrl ? h(Btn, { kind: 'quiet', onClick: () => globalThis.open(String(entry.pageUrl), '_blank', 'noopener,noreferrer') }, t('action.open')) : null,
                      ),
                    ),
              ),
            ),
      )
    }

    /**
     * The Bilibili credential, in one component used in two places.
     *
     * The panel shows it only when it is the obstacle (a video is bound and the
     * credential cannot post); the settings page shows it always, because that is
     * where a credential is configured. One component, so the two cannot drift
     * into two different explanations of the same `-101`.
     */
    function BilibiliSignIn(props) {
      const { t, bili, busy, setBusy, setNotice, setError, onChanged } = props
      const credential = bili?.credential ?? null
      const login = bili?.login ?? { state: 'idle' }
      const [sessdata, setSessdata] = React.useState('')
      const [csrf, setCsrf] = React.useState('')
      const [confirmingSignOut, setConfirmingSignOut] = React.useState(false)

      /** One request, with the two failures this page has to tell apart. */
      const post = React.useCallback(async (key, path, body) => {
        setBusy(key)
        setError(null)
        const result = await postJson(path, body, ACTION_TIMEOUT_MS)
        setBusy('')
        if (!result.ok) {
          setError(result.aborted ? 'timeout' : 'host')
          return null
        }
        if (!result.response.ok || result.payload?.ok !== true) {
          setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
          await onChanged()
          return null
        }
        return result.payload.value ?? {}
      }, [onChanged, setBusy, setError, t])

      const start = React.useCallback(async () => {
        const value = await post('bili-login', '/bilibili-login-start', {})
        if (value !== null) await onChanged()
      }, [onChanged, post])

      const cancel = React.useCallback(async () => {
        await post('bili-cancel', '/bilibili-login-cancel', {})
        await onChanged()
      }, [onChanged, post])

      const save = React.useCallback(async () => {
        const value = await post('bili-paste', '/bilibili-credential', { sessdata, bili_jct: csrf })
        setSessdata('')
        setCsrf('')
        if (value === null) return
        setNotice(t('bili.paste.saved', { uname: String(value.account?.uname ?? '') }))
        await onChanged()
      }, [csrf, onChanged, post, sessdata, setNotice, t])

      const signOut = React.useCallback(async () => {
        if (confirmingSignOut !== true) {
          setConfirmingSignOut(true)
          return
        }
        setConfirmingSignOut(false)
        const value = await post('bili-signout', '/bilibili-logout', {})
        if (value === null) return
        /* An external credential keeps working after this one is deleted, and
           reporting a sign-out that did not happen would be a lie the next sweep
           exposes anyway. */
        setNotice(value.stillAvailable ? t('bili.signOut.fallback', { path: String(value.stillAvailable.path ?? '') }) : t('bili.signOut.done'))
        await onChanged()
      }, [confirmingSignOut, onChanged, post, setNotice, t])

      const running = login.state === 'waiting' || login.state === 'scanned'
      React.useEffect(() => {
        if (!running) return undefined
        let cancelled = false
        const tick = async () => {
          const result = await postJson('/bilibili-login-poll', {}, STATUS_TIMEOUT_MS)
          if (cancelled) return
          const value = result.payload?.value ?? {}
          if (result.ok && result.response.ok && result.payload?.ok === true) {
            if (value.state === 'succeeded') {
              setNotice(value.account?.uname
                ? t('bili.signIn.done', { uname: String(value.account.uname) })
                : t('bili.signIn.doneNoName'))
            }
            if (value.state === 'expired') setError(t('bili.signIn.expired'))
          } else if (result.ok && !result.aborted) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
          }
          await onChanged()
        }
        const timer = globalThis.setInterval(() => { void tick() }, AUTH_POLL_MS)
        return () => {
          cancelled = true
          globalThis.clearInterval(timer)
        }
      }, [onChanged, running, setError, setNotice, t])

      if (credential === null) return null
      const state = String(credential.state ?? 'none')
      const stateText = (() => {
        if (state === 'ready') {
          return credential.account?.uname
            ? t('bili.credential.ready', { uname: String(credential.account.uname) })
            : t('bili.credential.ready', { uname: '?' })
        }
        const key = `bili.credential.${state}`
        const text = t(key)
        return text === key ? t('bili.credential.unverified') : text
      })()

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dsc-setup', role: 'status' },
          h(
            'div',
            { className: 'dsc-setup-line' },
            h('span', { className: 'dsc-setup-strong' }, t('bili.credential.title')),
            h(Chip, { state: state === 'ready' ? 'success' : state === 'none' ? 'warn' : 'idle' }, stateText),
            credential.path
              ? h('span', { className: 'dsc-mono', title: String(credential.path) }, t('bili.credential.source', { path: String(credential.path) }))
              : null,
          ),
          /* Why it cannot be used, in Bilibili's own terms. A bare "-101" sends the
             reader to re-login in the wrong place when the credential is an APP one. */
          state !== 'ready' && credential.message ? h('span', { className: 'dsc-warn' }, String(credential.message)) : null,
          state !== 'ready' ? h('span', null, t('bili.credential.none.hint')) : null,
          credential.source === 'configured'
            ? h('span', { className: 'dsc-quiet' }, t('bili.credential.external', { path: String(credential.configuredPath ?? '') }))
            : null,

          running
            ? h(
                'div',
                { className: 'dsc-setup-line' },
                h('span', { className: 'dsc-grow' }, login.state === 'scanned' ? t('bili.waitingScanned') : t('bili.waiting')),
                login.url
                  ? h(Btn, { disabled: busy !== '', onClick: () => globalThis.open(String(login.url), '_blank', 'noopener,noreferrer') }, t('bili.openLogin'))
                  : null,
                h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => { void cancel() } }, t('bili.cancelSignIn')),
              )
            : h(
                'div',
                { className: 'dsc-setup-line' },
                h(Btn, { kind: 'primary', disabled: busy !== '', onClick: () => { void start() } }, busy === 'bili-login' ? '…' : t('bili.signIn')),
                h('span', { className: 'dsc-quiet' }, t('bili.signIn.hint')),
              ),
          state === 'ready'
            ? h(
                'div',
                { className: 'dsc-setup-line' },
                h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => { void signOut() } }, confirmingSignOut ? t('bili.signOut.confirm') : t('bili.signOut')),
              )
            : null,

          h('span', { className: 'dsc-setup-strong' }, t('bili.paste.title')),
          h('span', { className: 'dsc-quiet' }, t('bili.paste.hint')),
          h(
            'div',
            { className: 'dsc-setup-line' },
            h('input', {
              className: 'dsc-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: 'false',
              placeholder: t('bili.paste.sessdata'),
              'aria-label': t('bili.paste.sessdata'),
              value: sessdata,
              onChange: (event) => setSessdata(String(event?.target?.value ?? '')),
            }),
            h('input', {
              className: 'dsc-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: 'false',
              placeholder: t('bili.paste.csrf'),
              'aria-label': t('bili.paste.csrf'),
              value: csrf,
              onChange: (event) => setCsrf(String(event?.target?.value ?? '')),
            }),
            h(Btn, {
              kind: 'primary',
              disabled: busy !== '' || sessdata.trim() === '' || csrf.trim() === '',
              onClick: () => { void save() },
            }, busy === 'bili-paste' ? '…' : t('bili.paste.save')),
          ),
        ),
      )
    }

    /**
     * One repository's video binding, inside its row.
     *
     * The binding is edited here because this is where the question is asked: the
     * row already knows what was released and whether the profile has it, and "who
     * reads about it" is the same repository's business. The announcement itself is
     * always previewed first — the comment is public, and the sentence shown is the
     * sentence the Host would send, composed on the Host.
     */
    function BiliBinding(props) {
      const { t, data, bili, busy, onBind, onPreview, onAnnounce } = props
      const binding = bili?.binding ?? null
      const [draft, setDraft] = React.useState(binding === null ? '' : String(binding.bvid))
      const [preview, setPreview] = React.useState(null)

      /* The Host is the source of truth for the binding: after a save the field
         shows what was actually stored, not what was typed. */
      React.useEffect(() => {
        setDraft(binding === null ? '' : String(binding.bvid))
      }, [binding === null ? '' : String(binding.bvid)])

      const announced = Array.isArray(bili?.announced) ? bili.announced : []
      const last = announced.length > 0 ? announced[announced.length - 1] : null
      const failures = Array.isArray(bili?.failures) ? bili.failures : []
      const failure = failures.length > 0 ? failures[failures.length - 1] : null
      /**
       * Why the Host would not post this one, in the reader's language where the
       * dictionary knows the state, and in the Host's own words otherwise. The Host
       * composes its refusals in one language; a known state deserves the other.
       */
      const previewReason = (value) => {
        const key = `bili.state.${String(value?.state ?? '')}`
        const text = t(key, { count: String(value?.attempts ?? '') })
        return text === key ? String(value?.message ?? '') : text
      }
      /**
       * What would be announced if the sweep ran now, as far as the panel can tell.
       * The decision itself is the Host's; this is a chip, and it stays silent when
       * the baseline is unknown rather than guessing at the one case that matters.
       */
      const pendingTag = (() => {
        if (binding === null) return null
        const tag = typeof data.publishedTag === 'string' && data.publishedTag !== '' ? data.publishedTag : null
        if (tag === null) return null
        if (announced.some((entry) => entry.tag === tag)) return null
        if (bili?.baseline === null || bili?.baseline === undefined) return null
        if (bili.baseline.tag === null) return null
        if (bili.baseline.tag === tag) return null
        return tag
      })()

      return h(
        'div',
        { className: 'dsc-sub' },
        h('span', null, t('bili.bind.title')),
        h(
          'div',
          { className: 'dsc-line' },
          h('input', {
            className: 'dsc-input',
            type: 'text',
            spellCheck: 'false',
            placeholder: t('bili.bind.placeholder'),
            'aria-label': t('bili.bind.placeholder'),
            value: draft,
            onChange: (event) => setDraft(String(event?.target?.value ?? '').trim()),
          }),
          h(Btn, {
            kind: binding === null ? 'primary' : undefined,
            disabled: busy !== '' || draft.trim() === '',
            onClick: () => { void onBind(data, draft.trim(), binding === null ? true : binding.auto !== false) },
          }, busy === `bili-bind:${data.repo}` ? '…' : t('bili.bind.save')),
          binding === null
            ? null
            : h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => { void onBind(data, '', true) } }, t('bili.bind.unbind')),
          h('span', { className: 'dsc-grow' }, binding === null
            ? t('bili.repo.none')
            : bili?.video?.ok === true
              ? `${String(bili.video.title ?? '')}${bili.video.owner ? ` · ${String(bili.video.owner)}` : ''}`
              : t('bili.video.failed', { reason: String(bili?.video?.message ?? '?') })),
        ),
        binding !== null
          ? h(
              'div',
              { className: 'dsc-line' },
              h(Chip, { state: binding.auto === false ? 'idle' : 'success' }, binding.auto === false ? t('bili.auto.off') : t('bili.auto.on')),
              h(Btn, { kind: 'quiet', disabled: busy !== '', onClick: () => { void onBind(data, binding.bvid, binding.auto === false) } }, t('bili.auto.toggle')),
              h('span', { className: 'dsc-grow' }, last === null
                ? t('bili.announced.none')
                : `${t('bili.chip.announced', { tag: String(last.tag) })}${last.url ? '' : ''}`),
              pendingTag !== null ? h(Chip, { state: 'warn' }, t('bili.chip.pending', { tag: pendingTag })) : null,
              last !== null && typeof last.url === 'string' && last.url !== ''
                ? h(Btn, { kind: 'quiet', onClick: () => globalThis.open(String(last.url), '_blank', 'noopener,noreferrer') }, t('action.open'))
                : null,
            )
          : null,
        failure !== null
          ? h('span', { className: 'dsc-warn' }, t('bili.failure.last', { message: String(failure.message ?? failure.failure ?? '') }))
          : null,
        binding !== null
          ? h(
              'div',
              { className: 'dsc-line' },
              h(Btn, {
                kind: 'primary',
                disabled: busy !== '',
                onClick: () => {
                  void (async () => {
                    const value = await onPreview(data)
                    if (value !== null) setPreview(value)
                  })()
                },
              }, busy === `bili-preview:${data.repo}` ? '…' : (announced.length > 0 ? t('bili.announce.again') : t('bili.announce'))),
            )
          : null,
        preview !== null
          ? h(
              React.Fragment,
              null,
              h('span', { className: 'dsc-setup-strong' }, t('bili.announce.preview')),
              preview.state !== 'ready'
                ? h('span', { className: 'dsc-warn' }, previewReason(preview))
                : null,
              h('pre', { className: 'dsc-logs' }, String(preview.text ?? '')),
              Array.isArray(preview.unknown) && preview.unknown.length > 0
                ? h('span', { className: 'dsc-warn' }, t('bili.unknownPlaceholder', { names: preview.unknown.join(', ') }))
                : null,
              h(
                'div',
                { className: 'dsc-line' },
                preview.state === 'ready'
                  ? h(Btn, {
                      kind: 'danger',
                      disabled: busy !== '',
                      onClick: () => {
                        setPreview(null)
                        void onAnnounce(data, preview, String(preview.text ?? ''), false)
                      },
                    }, t('bili.announce.confirm'))
                  : h(Btn, {
                      kind: 'danger',
                      disabled: busy !== '',
                      onClick: () => {
                        setPreview(null)
                        void onAnnounce(data, preview, String(preview.text ?? ''), true)
                      },
                    }, t('bili.announce.force')),
                h(Btn, { kind: 'quiet', onClick: () => setPreview(null) }, t('bili.announce.cancel')),
              ),
            )
          : null,
      )
    }

    /**
     * The Settings page for Bilibili update notes.
     *
     * The panel answers "what would be posted, and to which video"; this page
     * answers "can this machine post at all, and what has it already said" — which
     * is configuration plus a public record, and belongs beside the two credential
     * pages that already live here.
     */
    function BilibiliPage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { bili, error, setError, loadBili } = useConsoleState()
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        void loadBili({ force: true })
      }, [loadBili])

      const reload = React.useCallback(() => loadBili({ force: true }), [loadBili])
      const repositories = Array.isArray(bili?.repos) ? bili.repos : []
      const lastSweep = bili?.lastSweep ?? null
      const sweepText = (() => {
        if (bili === null) return null
        if (lastSweep === null || lastSweep === undefined) return t('bili.neverSwept')
        const results = Array.isArray(lastSweep.results) ? lastSweep.results : []
        const announced = results.filter((entry) => entry.state === 'announced')
        const failed = results.filter((entry) => entry.state === 'failed')
        const summary = announced.length > 0
          ? announced.map((entry) => t('bili.sweep.announced', { repo: String(entry.repo ?? ''), tag: String(entry.tag ?? '') })).join('，')
          : failed.length > 0
            ? failed.map((entry) => t('bili.sweep.failed', { repo: String(entry.repo ?? ''), tag: String(entry.tag ?? '') })).join('，')
            : t('bili.sweep.none')
        return t('bili.lastSweep', { time: stamp(String(lastSweep.at ?? '')), summary })
      })()

      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'div',
          { className: 'dsc-bar' },
          h(
            'div',
            { className: 'dsc-heading' },
            h('span', { className: 'dsc-title' }, t('bili.settings.title')),
            h('span', { className: 'dsc-subtitle' }, t('bili.settings.subtitle')),
          ),
          h(Btn, { disabled: busy !== '', onClick: () => { void reload() } }, t('action.recheck')),
        ),

        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, errorText(t, error)) : null,
        notice !== null ? h('div', { className: 'dsc-notice', role: 'status' }, notice) : null,

        bili === null
          ? h('div', { className: 'dsc-empty' }, t('state.loading'))
          : h(
              React.Fragment,
              null,
              bili.enabled === false
                ? h('div', { className: 'dsc-warn' }, 'bilibiliEnabled: false')
                : null,
              bili.watchSeconds === 0 ? h('div', { className: 'dsc-warn' }, t('bili.watch.off')) : null,
              bili.ledger?.problem
                ? h('div', { className: 'dsc-error', role: 'alert' }, t('bili.ledger.problem', { problem: String(bili.ledger.problem) }))
                : null,
              h(BilibiliSignIn, {
                t,
                bili,
                busy,
                setBusy,
                setNotice,
                setError,
                onChanged: () => loadBili({ force: true }),
              }),
              h(
                'div',
                { className: 'dsc-setup' },
                h('span', { className: 'dsc-setup-strong' }, t('bili.template')),
                h('span', { className: 'dsc-mono' }, String(bili.template === '' ? '【更新 {tag}】{summary}' : bili.template)),
                h('span', { className: 'dsc-quiet' }, t('bili.template.hint')),
                sweepText === null ? null : h('span', { className: 'dsc-quiet' }, sweepText),
              ),
              h(
                'div',
                { className: 'dsc-sub' },
                h('span', { className: 'dsc-setup-strong' }, t('bili.repos.title')),
                repositories.length === 0
                  ? h('span', null, t('bili.repos.empty'))
                  : repositories.map((entry) =>
                      h(
                        'div',
                        { className: 'dsc-line', key: entry.repo },
                        h('span', { className: 'dsc-name', style: { minWidth: '0', fontWeight: '500' } }, String(entry.label ?? entry.repo)),
                        entry.binding === null
                          ? h(Chip, { state: 'idle' }, t('bili.repo.none'))
                          : h(Chip, { state: 'success' }, String(entry.binding.bvid)),
                        h('span', { className: 'dsc-grow' }, entry.video?.ok === true
                          ? String(entry.video.title ?? '')
                          : (Array.isArray(entry.announced) && entry.announced.length > 0
                              ? t('bili.chip.announced', { tag: String(entry.announced[entry.announced.length - 1].tag) })
                              : t('bili.announced.none'))),
                        Array.isArray(entry.failures) && entry.failures.length > 0
                          ? h('span', { className: 'dsc-warn' }, t('bili.failure.last', { message: String(entry.failures[entry.failures.length - 1].message ?? '') }))
                          : null,
                        entry.commentUrl
                          ? h(Btn, { kind: 'quiet', onClick: () => globalThis.open(String(entry.commentUrl), '_blank', 'noopener,noreferrer') }, t('action.open'))
                          : null,
                      ),
                    ),
              ),
            ),
      )
    }

    /** The Settings page: account, scopes, and the repository list. */
    function AccountPage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { status, error, setError, loadStatus } = useConsoleState()
      const [managing, setManaging] = React.useState(false)
      const [confirmingSignOut, setConfirmingSignOut] = React.useState(false)
      const [signOutBusy, setSignOutBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        void loadStatus()
      }, [loadStatus])

      const gh = status?.gh ?? {}
      const config = status?.config ?? {}
      const missing = Array.isArray(gh.missingScopes) ? gh.missingScopes : []
      const scopes = Array.isArray(gh.scopes) ? gh.scopes : []
      const registered = Array.isArray(status?.repos) ? status.repos.length : 0
      const stale = status !== null && status.protocol !== PROTOCOL

      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'div',
          { className: 'dsc-bar' },
          h(
            'div',
            { className: 'dsc-heading' },
            h('span', { className: 'dsc-title' }, t('settings.title')),
            h('span', { className: 'dsc-subtitle' }, t('settings.subtitle')),
          ),
          h(Btn, { onClick: () => void loadStatus() }, t('action.recheck')),
          /* Signing out is destructive and easy to hit by accident, so it takes two
             clicks — the same shape as publishing a draft. */
          gh.authenticated === true
            ? h(Btn, {
                kind: 'quiet',
                disabled: signOutBusy,
                title: t('state.signedOut'),
                onClick: () => {
                  if (!confirmingSignOut) {
                    setConfirmingSignOut(true)
                    return
                  }
                  void (async () => {
                    setSignOutBusy(true)
                    const result = await postJson('/auth-logout', {}, ACTION_TIMEOUT_MS)
                    setSignOutBusy(false)
                    setConfirmingSignOut(false)
                    if (!result.ok || result.payload?.ok !== true) {
                      setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
                      return
                    }
                    setNotice(t('state.signedOut'))
                    void loadStatus()
                  })()
                },
              }, signOutBusy ? '…' : confirmingSignOut ? t('action.signOutConfirm') : t('action.signOut'))
            : null,
        ),

        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, errorText(t, error)) : null,
        notice !== null ? h('div', { className: 'dsc-notice', role: 'status' }, notice) : null,
        stale
          ? h('div', { className: 'dsc-warn', role: 'alert' }, h('strong', null, t('stale.title')), ' — ', t('stale.how'))
          : null,

        status === null
          ? h('div', { className: 'dsc-empty' }, t('state.loading'))
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dsc-list' },
                h(
                  'div',
                  { className: 'dsc-item' },
                  h(
                    'div',
                    { className: 'dsc-row' },
                    h('span', { className: 'dsc-dot', 'data-state': gh.available !== true ? 'error' : gh.authenticated !== true ? 'warn' : 'success' }),
                    h('span', { className: 'dsc-name' }, t('meta.gh')),
                    h('span', { className: 'dsc-grow' }, gh.available !== true ? (gh.message ?? 'not found') : (gh.version ?? 'present')),
                    gh.authenticated === true && typeof gh.account === 'string' && gh.account !== ''
                      ? h(Chip, { state: 'success' }, gh.account)
                      : h(Chip, { state: 'warn' }, t('setup.needSignIn')),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsc-item' },
                  h(
                    'div',
                    { className: 'dsc-row' },
                    h('span', { className: 'dsc-dot', 'data-state': missing.length > 0 ? 'warn' : 'success' }),
                    h('span', { className: 'dsc-name' }, t('meta.scopes')),
                    h('span', { className: 'dsc-grow' }, gh.authenticated !== true ? '—' : scopes.length > 0 ? scopes.join(', ') : t('meta.noScopes')),
                    missing.length > 0 ? h(Chip, { state: 'warn' }, missing.join(', ')) : null,
                  ),
                ),
                h(
                  'div',
                  { className: 'dsc-item' },
                  h(
                    'div',
                    { className: 'dsc-row' },
                    h('span', { className: 'dsc-dot', 'data-state': 'idle' }),
                    h('span', { className: 'dsc-name' }, t('meta.configFrom')),
                    h('span', { className: 'dsc-grow dsc-mono' }, `${status.configSource ?? '—'} · ${status.configFile ?? ''}`),
                    h('span', null, String(registered)),
                  ),
                ),
              ),

              needsAccountSetup(gh) && !stale
                ? h(
                    'div',
                    { className: 'dsc-setup' },
                    h('span', { className: 'dsc-setup-strong' }, gh.available !== true
                      ? t('setup.needGh')
                      : gh.authenticated !== true
                        ? t('setup.needSignIn')
                        : t('setup.needScopes', { scopes: missing.join(', ') })),
                    missing.length > 0 ? h('span', null, t('setup.scopeHint')) : null,
                    h(SignIn, { t, status, onChanged: () => void loadStatus() }),
                  )
                : null,

              h(
                'div',
                { className: 'dsc-bar' },
                h('span', { className: 'dsc-subtitle' }, `${t('meta.projectsRoot')}: ${typeof config.projectsRoot === 'string' && config.projectsRoot !== '' ? config.projectsRoot : t('meta.projectsRootUnset')}`),
                h(Btn, { kind: managing ? 'primary' : undefined, onClick: () => setManaging((value) => !value) }, managing ? t('action.close') : t('action.manage')),
              ),
              managing && !stale ? h(RepoPicker, { t, onChanged: () => void loadStatus() }) : null,
            ),
      )
    }

    return {
      name: 'dsh-cicd-client',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dsh-plugin-cicd: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        const disposers = [
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID, locale: NS },
              ConsolePage,
            ),
          ),
          // `order: 16` sits the entry after the knowledge console (15) and before
          // whatever a later plugin adds; the sidebar owns the button itself.
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 16, label: () => t('panel'), locale: NS },
              ConsoleIcon,
            ),
          ),
          // The shipped `account` section belongs to another plugin, and reusing its
          // id would REPLACE DSH's own account page. A sibling section is the
          // additive seat, and `order: -9` puts it directly under Account.
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: SETTINGS_ID, order: -9, label: () => t('settings.label'), locale: NS },
              AccountPage,
            ),
          ),
          // The npm credential is its own section rather than a block on the GitHub
          // page: they are two credential systems with two failures and two fixes, and
          // `-8` sits it directly under the one above. A fresh id is required — reusing
          // a shipped id would replace that page instead of adding one.
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: NPM_SETTINGS_ID, order: -8, label: () => t('settings.npmLabel'), locale: NS },
              NpmCredentialsPage,
            ),
          ),
          // And the third credential system: Bilibili's. `-7` continues the stack,
          // and the id is fresh for the same reason both of the others are.
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: BILIBILI_SETTINGS_ID, order: -7, label: () => t('bili.settings.label'), locale: NS },
              BilibiliPage,
            ),
          ),
        ]
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            for (const dispose of disposers) {
              if (typeof dispose === 'function') dispose()
            }
          }, 'dsh-plugin-cicd: panel registrations')
        }
      },
    }
  },
})
