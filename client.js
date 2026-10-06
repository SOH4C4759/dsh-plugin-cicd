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
    const STYLE_ID = 'dsh-plugin-cicd-styles'

    const BASE = '/api/dsh-cicd'
    /**
     * The Host protocol this page needs.
     *
     * A page refresh replaces this file but not the Host process, so a route can
     * be missing while the button that calls it is on screen. Comparing this
     * number turns that into one sentence instead of a bare HTTP status.
     */
    const PROTOCOL = 2
    const STATUS_TIMEOUT_MS = 20_000
    const OVERVIEW_TIMEOUT_MS = 60_000
    const ACTION_TIMEOUT_MS = 45_000
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
      'action.publishDraft': '公开草稿',
      'action.confirmPublish': '确认公开？',
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
      'label.runs': '运行记录',
      'chip.published': '已发布',
      'chip.unpublished': '未发布',
      'chip.draft': '草稿',
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
      'state.releaseDispatched': '已触发发布流程（{repo}）；它产出的是草稿——草稿对外不可见，展开该行点【公开草稿】即可公开。',
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
      'confirm.publish': '公开发布 {tag}？发布后任何人可见，无法收回。',
      'confirm.cancel': '再想想',
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
      'action.publishDraft': 'Publish',
      'action.confirmPublish': 'Publish?',
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
      'label.runs': 'Runs',
      'chip.published': 'Released',
      'chip.unpublished': 'Unreleased',
      'chip.draft': 'Draft',
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
      'state.releaseDispatched': 'Release workflow triggered for {repo}. It produces a DRAFT: drafts are invisible to everyone else, so expand that row and press Publish to make it public.',
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
      'confirm.publish': 'Publish {tag} publicly? Once published, anyone can see it.',
      'confirm.cancel': 'Not yet',
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
        h('code', null, command),
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
                code !== null ? h(CopyLine, { t, command: code }) : null,
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
      const { t, data, busy, onAction, onPublish, logs, onLogs } = props
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
      const run = data.latestRun
      const local = data.local ?? { available: false }
      const state = runState(run)

      /* Only non-zero local signals are shown: a column of "clean" chips is noise,
         and the row exists to make the exceptions visible. */
      const chips = []
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
            data.hasReleaseWorkflow ? h(Btn, { kind: 'primary', disabled: busy !== '', title: t('action.release'), onClick: () => onAction('release', data) }, busy === `release:${data.repo}` ? '…' : t('action.release')) : null,
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

      return { status, overview, error, setError, loadStatus, loadOverview }
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
      const { status, overview, error, setError, loadStatus, loadOverview } = useConsoleState()
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [logs, setLogs] = React.useState(null)
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
      }, [loadStatus, loadOverview])

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
            overview !== null && typeof overview.fetchedAt === 'string'
              ? h('span', null, t('meta.updated', { time: stamp(overview.fetchedAt) }), overview.cached === true ? ` (${t('meta.cached')})` : '')
              : null,
            h(Btn, { onClick: () => { void loadStatus(); void loadOverview({ force: true }) } }, t('action.refresh')),
            h(Btn, { kind: managing ? 'primary' : undefined, onClick: () => setManaging((value) => !value) }, managing ? t('action.close') : t('action.manage')),
          ),
        ),

        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, errorText(t, error)) : null,
        notice !== null ? h('div', { className: 'dsc-notice', role: 'status' }, notice) : null,
        stale
          ? h('div', { className: 'dsc-warn', role: 'alert' }, h('strong', null, t('stale.title')), ' — ', t('stale.how'))
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
                onPublish: (tag) => onPublish(data.repo, tag),
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
                onPublish: () => {},
                logs: null,
                onLogs: async () => {},
              })),
            )
          : null,
      )
    }

    /** The Settings page: account, scopes, and the repository list. */
    function AccountPage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { status, error, loadStatus } = useConsoleState()
      const [managing, setManaging] = React.useState(false)

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
        ),

        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, errorText(t, error)) : null,
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
