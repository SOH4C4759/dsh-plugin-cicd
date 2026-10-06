/**
 * Browser half of the `dsh-plugin-cicd` bundle — 发布台 (Release Console).
 *
 * Two registrations, the same shape the shipped Plugin Manager panel uses:
 *   ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, … }, ConsolePage))
 *   ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, … }, ConsoleIcon))
 *
 * The sidebar owns the button and the selection: clicking the icon addresses the
 * `main` panel with the same id, so the panel is a full column of the layout
 * rather than a floating card. Nothing here is positioned absolutely, and every
 * colour comes from `--dsw-alias-*`, so the panel follows the active theme
 * instead of shipping a palette of its own.
 *
 * Deliberate choices:
 *   - No Harness Client package is required; only `react`, which is a platform
 *     seed word in the client module table.
 *   - The stylesheet is tagged `data-plugin`/`data-plugin-css` so the loader's
 *     claimStyles/removeOwnedStyles cannot take it over or delete it.
 *   - A failed BACKGROUND poll never clears the last known state and never raises
 *     a banner: it only stops updating, so a sleeping laptop does not produce an
 *     error the user did not cause.
 *   - Publishing a draft is public and one-way, so it takes two clicks and says
 *     so in between.
 *   - Every request is bounded by a timeout, so a dead Host never hangs the panel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-cicd',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-cicd'
    /** Sidebar entry id and `main` slot key — the same value links the two. */
    const PANEL_ID = 'dsh-cicd'
    const STYLE_ID = 'dsh-plugin-cicd-styles'

    const STATUS_URL = '/api/dsh-cicd/status'
    const OVERVIEW_URL = '/api/dsh-cicd/overview'
    const RUNS_URL = '/api/dsh-cicd/runs'
    const DISPATCH_URL = '/api/dsh-cicd/dispatch'
    const RUN_ACTION_URL = '/api/dsh-cicd/run-action'
    const RELEASE_ACTION_URL = '/api/dsh-cicd/release-action'
    const LOGS_URL = '/api/dsh-cicd/logs'

    /** Overview fans out three `gh` calls per repository, so it gets a longer deadline. */
    const STATUS_TIMEOUT_MS = 20_000
    const OVERVIEW_TIMEOUT_MS = 60_000
    const ACTION_TIMEOUT_MS = 45_000
    const NOTICE_TTL_MS = 5_000

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'panel': '发布台',
      'title': '发布台',
      'subtitle': 'GitHub Actions 的构建与发布',
      'action.refresh': '刷新',
      'action.build': '构建',
      'action.release': '发布',
      'action.publishDraft': '公开发布草稿',
      'action.confirmPublish': '确认公开？',
      'action.open': '打开',
      'action.runs': '全部运行',
      'action.logs': '失败日志',
      'action.hideLogs': '收起日志',
      'action.rerun': '重跑',
      'action.cancel': '取消',
      'action.busy': '进行中…',
      'badge.published': '已发布',
      'badge.unpublished': '未发布',
      'badge.draft': '草稿',
      'badge.dirty': '未提交 {count}',
      'badge.ahead': '领先 {count}',
      'badge.behind': '落后 {count}',
      'badge.clean': '干净',
      'state.loading': '正在读取…',
      'state.unconfigured': '还没有配置仓库：在 profile 的 cordis.patch.yml 里给 dsh-plugin-cicd 这一行写 repos。',
      'state.ghMissing': '找不到 gh CLI，面板无法读取 GitHub：{message}',
      'state.ghAnonymous': 'gh 已安装但未登录，私有仓库会读不到。',
      'state.hostGone': '无法连接 Host；面板会保留上一次的数据，稍后自动重试。',
      'state.timeout': '请求超时，Host 没有在时限内回答。',
      'state.noRuns': '还没有运行记录。',
      'state.noReleases': '还没有 Release。',
      'state.dispatched': '已触发 {workflow}（{repo}）。',
      'state.releaseDispatched': '已触发发布流程（{repo}）。运行结束后草稿会出现在这里。',
      'state.published': '{tag} 已公开。',
      'state.rerun': '已请求重跑。',
      'state.cancelled': '已请求取消。',
      'state.actionFailed': '操作失败：{reason}',
      'state.statusFailed': '读取 Host 状态失败：{reason}',
      'state.truncated': '（只显示最后 {lines} 行）',
      'meta.account': '账号',
      'meta.updated': '更新于 {time}',
      'meta.cached': '缓存',
      'meta.version': '本地版本 {version}',
      'meta.expectedTag': '期望 tag {tag}',
      'meta.noLocal': '未配置本地路径',
      'meta.localUnavailable': '本地状态不可用：{reason}',
      'meta.assets': '{count} 个资产',
      'run.unknown': '未知',
      'run.event': '触发：{event}',
      'confirm.publish': '公开发布 {tag}？发布后任何人可见，无法收回。',
      'confirm.cancel': '再想想',
      'setup.title': '先完成设置',
      'setup.ghMissing': '没有找到 gh CLI。发布台通过它访问 GitHub，所以这一步必须先做。',
      'setup.ghMissingStep': '安装 GitHub CLI：',
      'setup.authNeeded': 'gh 已安装，但还没有登录 GitHub。',
      'setup.authStep1': '在终端里运行：',
      'setup.authStep2': '按提示选择 GitHub.com → HTTPS → 用浏览器登录。',
      'setup.authStep3': '完成后回到这里点「重新检测」。',
      'setup.scopesNeeded': '当前凭据缺少权限：{scopes}。缺 repo 读不到私有仓库，缺 workflow 无法触发构建。',
      'setup.scopesStep': '补授权（保留现有登录）：',
      'setup.reposNeeded': '还没有登记任何仓库。用仓库自带的脚本登记，不必手改 profile 的 YAML：',
      'setup.reposFile': '登记结果写在这里：',
      'setup.recheck': '重新检测',
      'setup.copy': '复制',
      'setup.copied': '已复制',
      'setup.configProblem': '配置文件读不了，面板按「没有仓库」处理：{reason}',
      'setup.dropped': '有 {count} 条登记被忽略（名字不合法或重复）。',
      'setup.help': '完整说明见插件仓库的 README。',
    }

    /** English dictionary, same key set. */
    const en = {
      'panel': 'Release Console',
      'title': 'Release Console',
      'subtitle': 'Builds and releases from GitHub Actions',
      'action.refresh': 'Refresh',
      'action.build': 'Build',
      'action.release': 'Release',
      'action.publishDraft': 'Publish draft',
      'action.confirmPublish': 'Publish publicly?',
      'action.open': 'Open',
      'action.runs': 'All runs',
      'action.logs': 'Failed logs',
      'action.hideLogs': 'Hide logs',
      'action.rerun': 'Re-run',
      'action.cancel': 'Cancel',
      'action.busy': 'Working…',
      'badge.published': 'Released',
      'badge.unpublished': 'Unreleased',
      'badge.draft': 'Draft',
      'badge.dirty': '{count} uncommitted',
      'badge.ahead': '{count} ahead',
      'badge.behind': '{count} behind',
      'badge.clean': 'Clean',
      'state.loading': 'Loading…',
      'state.unconfigured': 'No repositories configured yet: set `repos` on the dsh-plugin-cicd row in the profile cordis.patch.yml.',
      'state.ghMissing': 'The gh CLI was not found, so the panel cannot read GitHub: {message}',
      'state.ghAnonymous': 'gh is installed but not signed in; private repositories will not be readable.',
      'state.hostGone': 'Cannot reach the Host; the panel keeps the last known data and retries on its own.',
      'state.timeout': 'The request timed out without an answer from the Host.',
      'state.noRuns': 'No runs yet.',
      'state.noReleases': 'No releases yet.',
      'state.dispatched': 'Triggered {workflow} on {repo}.',
      'state.releaseDispatched': 'Release workflow triggered for {repo}; the draft appears here when it finishes.',
      'state.published': '{tag} is public now.',
      'state.rerun': 'Re-run requested.',
      'state.cancelled': 'Cancellation requested.',
      'state.actionFailed': 'The action failed: {reason}',
      'state.statusFailed': 'Reading the Host status failed: {reason}',
      'state.truncated': '(showing the last {lines} lines)',
      'meta.account': 'Account',
      'meta.updated': 'Updated {time}',
      'meta.cached': 'cached',
      'meta.version': 'local version {version}',
      'meta.expectedTag': 'expected tag {tag}',
      'meta.noLocal': 'no local path configured',
      'meta.localUnavailable': 'local state unavailable: {reason}',
      'meta.assets': '{count} assets',
      'run.unknown': 'unknown',
      'run.event': 'event: {event}',
      'confirm.publish': 'Publish {tag} publicly? Once published, anyone can see it.',
      'confirm.cancel': 'Not yet',
      'setup.title': 'Finish setup first',
      'setup.ghMissing': 'The gh CLI was not found. The console reaches GitHub through it, so this comes first.',
      'setup.ghMissingStep': 'Install GitHub CLI:',
      'setup.authNeeded': 'gh is installed but not signed in to GitHub.',
      'setup.authStep1': 'Run this in a terminal:',
      'setup.authStep2': 'Choose GitHub.com → HTTPS, then sign in through the browser.',
      'setup.authStep3': 'Come back here and press Re-check.',
      'setup.scopesNeeded': 'The current credential is missing: {scopes}. Without repo, private repositories cannot be read; without workflow, a build cannot be triggered.',
      'setup.scopesStep': 'Grant the missing scopes (this keeps the existing login):',
      'setup.reposNeeded': 'No repository is registered yet. Register them with the script that ships with the plugin instead of editing the profile YAML by hand:',
      'setup.reposFile': 'The list is written here:',
      'setup.recheck': 'Re-check',
      'setup.copy': 'Copy',
      'setup.copied': 'Copied',
      'setup.configProblem': 'The config file cannot be read, so the panel treats this as "no repositories": {reason}',
      'setup.dropped': '{count} entry/entries were ignored (unusable or duplicate name).',
      'setup.help': 'The full instructions are in the plugin repository README.',
    }

    const CSS = `
.dsc-root { display: flex; flex-direction: column; gap: 14px; padding: 18px 20px 28px; height: 100%; overflow: auto; }
.dsc-bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsc-heading { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dsc-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsc-subtitle { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsc-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.dsc-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
}
.dsc-btn:hover:not([disabled]) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dsc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsc-btn[disabled] { opacity: .55; cursor: default; }
.dsc-btn[data-kind="primary"] { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.dsc-btn[data-kind="danger"] { border-color: transparent; background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-btn[data-kind="quiet"] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dsc-btn[data-kind="quiet"]:hover:not([disabled]) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.dsc-card {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 11px;
}
.dsc-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsc-repo { display: flex; align-items: center; gap: 9px; min-width: 0; }
.dsc-repo-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsc-path { font-size: 11px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsc-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }

.dsc-badge {
  display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary); background: transparent; white-space: nowrap;
}
.dsc-badge[data-state="success"] { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dsc-badge[data-state="error"] { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dsc-badge[data-state="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dsc-badge[data-state="busy"] { color: var(--dsw-alias-brand-primary); border-color: currentColor; }
.dsc-badge[data-state="idle"] { color: var(--dsw-alias-state-idle-primary); border-color: currentColor; }

.dsc-list { display: flex; flex-direction: column; gap: 6px; }
.dsc-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 7px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  font-size: 12px; color: var(--dsw-alias-label-primary);
}
.dsc-item-main { display: flex; align-items: center; gap: 9px; min-width: 0; }
.dsc-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
.dsc-dim { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsc-empty { padding: 10px 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.dsc-notice, .dsc-error, .dsc-warn {
  padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 1.6;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
}
.dsc-error { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dsc-warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dsc-notice code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  background: var(--dsw-alias-bg-layer-2); padding: 1px 5px; border-radius: 4px;
}
.dsc-logs {
  margin: 0; padding: 10px 12px; max-height: 260px; overflow: auto; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap;
}
.dsc-confirm {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 12px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary);
}

/* First-run guidance. Bordered with the brand accent rather than an error colour:
   "you have not set this up yet" is a normal state, not a failure. */
.dsc-setup {
  border: 1px solid var(--dsw-alias-brand-primary); border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1); padding: 14px 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.dsc-setup-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsc-setup-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsc-step { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsc-step-title { color: var(--dsw-alias-label-primary); }
.dsc-ordered { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.dsc-cmd {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  color: var(--dsw-alias-label-primary);
}
.dsc-cmd code { flex: 1 1 320px; min-width: 0; overflow-wrap: anywhere; }
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
    async function postJson(url, body, timeoutMs) {
      const controller = new AbortController()
      const timer = globalThis.setTimeout(() => {
        controller.abort()
      }, timeoutMs)
      try {
        const response = await fetch(url, {
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
        return {
          ok: false,
          aborted: controller.signal.aborted,
          error: error instanceof Error ? error.message : String(error),
        }
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
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    }

    /** Map a run's state onto the badge vocabulary. */
    function runState(run) {
      if (run === null) return 'idle'
      if (run.status !== 'completed') return 'busy'
      if (run.conclusion === 'success') return 'success'
      if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'startup_failure') return 'error'
      if (run.conclusion === 'cancelled' || run.conclusion === 'skipped' || run.conclusion === 'neutral') return 'idle'
      return 'idle'
    }

    /** A compact GitHub glyph for the sidebar entry, drawn with `currentColor`. */
    function ConsoleIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false', style: { display: 'block' } },
        h('path', {
          d: 'M8 1.6 2.4 4.5v7L8 14.4l5.6-2.9v-7L8 1.6Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M2.6 4.6 8 7.3l5.4-2.7M8 7.3v6.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
      )
    }

    /** One pill. */
    function Badge(props) {
      return h('span', { className: 'dsc-badge', 'data-state': props.state ?? 'idle', title: props.title }, props.children)
    }

    /** One key/value line inside a card. */
    function Metric(props) {
      return h('span', { className: 'dsc-dim' }, `${props.label} `, h('strong', null, props.value))
    }

    /** The release list of one repository, with the draft-publishing affordance. */
    function Releases(props) {
      const { t, data, busy, onPublish, confirming, setConfirming } = props
      if (data.releases.length === 0) return h('div', { className: 'dsc-empty' }, t('state.noReleases'))
      return h(
        'div',
        { className: 'dsc-list' },
        data.releases.map((release) =>
          h(
            'div',
            { className: 'dsc-item', key: release.tag },
            h(
              'div',
              { className: 'dsc-item-main' },
              h('span', { className: 'dsc-ellipsis' }, release.tag),
              release.draft
                ? h(Badge, { state: 'warn' }, t('badge.draft'))
                : h(Badge, { state: 'success' }, t('badge.published')),
              h('span', { className: 'dsc-dim' }, stamp(release.createdAt)),
              h('span', { className: 'dsc-dim' }, t('meta.assets', { count: String(release.assets.length) })),
            ),
            h(
              'div',
              { className: 'dsc-actions' },
              release.url !== ''
                ? h('a', { className: 'dsc-btn', 'data-kind': 'quiet', href: release.url, target: '_blank', rel: 'noreferrer' }, t('action.open'))
                : null,
              release.draft
                ? confirming === release.tag
                  ? h(
                      'span',
                      { className: 'dsc-actions' },
                      h('button', { type: 'button', className: 'dsc-btn', 'data-kind': 'danger', disabled: busy !== '', onClick: () => onPublish(release.tag) }, t('action.confirmPublish')),
                      h('button', { type: 'button', className: 'dsc-btn', 'data-kind': 'quiet', onClick: () => setConfirming(null) }, t('confirm.cancel')),
                    )
                  : h(
                      'button',
                      { type: 'button', className: 'dsc-btn', disabled: busy !== '', onClick: () => setConfirming(release.tag) },
                      t('action.publishDraft'),
                    )
                : null,
            ),
          ),
        ),
      )
    }

    /** One repository card: local truth, latest run, actions, releases. */
    function RepoCard(props) {
      const { t, data, busy, onAction, onPublish, logs, onLogs } = props
      const [confirming, setConfirming] = React.useState(null)
      const run = data.latestRun
      const local = data.local ?? { available: false }
      const problem = data.problems.length > 0 ? data.problems[0] : null

      const localBadges = []
      if (local.available === true) {
        if (Number.isFinite(local.dirty) && local.dirty > 0) localBadges.push(h(Badge, { key: 'dirty', state: 'warn' }, t('badge.dirty', { count: String(local.dirty) })))
        else localBadges.push(h(Badge, { key: 'clean', state: 'success' }, t('badge.clean')))
        if (Number.isFinite(local.ahead) && local.ahead > 0) localBadges.push(h(Badge, { key: 'ahead', state: 'warn' }, t('badge.ahead', { count: String(local.ahead) })))
        if (Number.isFinite(local.behind) && local.behind > 0) localBadges.push(h(Badge, { key: 'behind', state: 'idle' }, t('badge.behind', { count: String(local.behind) })))
      }

      return h(
        'div',
        { className: 'dsc-card' },
        h(
          'div',
          { className: 'dsc-card-head' },
          h(
            'div',
            { className: 'dsc-repo' },
            h('span', { className: 'dsc-repo-name' }, data.label),
            data.version !== null ? h(Badge, { state: 'idle' }, t('meta.version', { version: data.version })) : null,
            data.published ? h(Badge, { state: 'success' }, t('badge.published')) : h(Badge, { state: 'warn' }, t('badge.unpublished')),
            localBadges,
          ),
          h(
            'div',
            { className: 'dsc-actions' },
            data.hasBuildWorkflow
              ? h('button', { type: 'button', className: 'dsc-btn', disabled: busy !== '', onClick: () => onAction('build', data) }, busy === `build:${data.repo}` ? t('action.busy') : t('action.build'))
              : null,
            data.hasReleaseWorkflow
              ? h('button', { type: 'button', className: 'dsc-btn', 'data-kind': 'primary', disabled: busy !== '', onClick: () => onAction('release', data) }, busy === `release:${data.repo}` ? t('action.busy') : t('action.release'))
              : null,
            run !== null && run.url !== ''
              ? h('a', { className: 'dsc-btn', 'data-kind': 'quiet', href: run.url, target: '_blank', rel: 'noreferrer' }, t('action.runs'))
              : null,
          ),
        ),

        problem !== null ? h('div', { className: 'dsc-warn' }, problem) : null,
        data.localPath === '' ? h('div', { className: 'dsc-dim' }, t('meta.noLocal')) : h('div', { className: 'dsc-path' }, data.localPath),

        h(
          'div',
          { className: 'dsc-row' },
          h('span', { className: 'dsc-label' }, 'run'),
          run === null
            ? h('span', { className: 'dsc-dim' }, t('state.noRuns'))
            : h(
                React.Fragment,
                null,
                h(Badge, { state: runState(run), title: run.conclusion || run.status }, `${run.workflow || 'workflow'} · ${run.conclusion || run.status || t('run.unknown')}`),
                h('span', { className: 'dsc-ellipsis' }, run.title),
                h('span', { className: 'dsc-dim' }, duration(run)),
                h('span', { className: 'dsc-dim' }, stamp(run.createdAt)),
                run.event !== '' ? h('span', { className: 'dsc-dim' }, t('run.event', { event: run.event })) : null,
                run.status !== 'completed' && run.id !== null
                  ? h('button', { type: 'button', className: 'dsc-btn', 'data-kind': 'quiet', disabled: busy !== '', onClick: () => onAction('cancel', data, { runId: run.id }) }, t('action.cancel'))
                  : null,
                run.status === 'completed' && run.id !== null
                  ? h('button', { type: 'button', className: 'dsc-btn', 'data-kind': 'quiet', disabled: busy !== '', onClick: () => onAction('rerun-failed', data, { runId: run.id }) }, t('action.rerun'))
                  : null,
                run.status === 'completed' && run.id !== null
                  ? h(
                      'button',
                      { type: 'button', className: 'dsc-btn', 'data-kind': 'quiet', disabled: busy !== '', onClick: () => onLogs(data, run) },
                      logs !== null && logs.repo === data.repo && logs.runId === run.id ? t('action.hideLogs') : t('action.logs'),
                    )
                  : null,
              ),
        ),

        logs !== null && logs.repo === data.repo
          ? h(
              'div',
              null,
              h('pre', { className: 'dsc-logs' }, logs.lines.join('\n')),
              logs.truncated ? h('div', { className: 'dsc-dim' }, t('state.truncated', { lines: String(logs.lines.length) })) : null,
            )
          : null,

        h(Releases, { t, data, busy, onPublish, confirming, setConfirming }),
      )
    }

    /** A command with a copy button, so the panel never asks anyone to retype one. */
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
          'button',
          {
            type: 'button',
            className: 'dsc-btn',
            'data-kind': 'quiet',
            onClick: () => {
              // Clipboard access needs a secure context; the loopback GUI is one, but a
              // refusal must not be reported as a successful copy.
              const write = globalThis.navigator?.clipboard?.writeText
              if (typeof write !== 'function') {
                setCopied(false)
                return
              }
              void write
                .call(globalThis.navigator.clipboard, command)
                .then(() => {
                  setCopied(true)
                })
                .catch(() => {
                  setCopied(false)
                })
            },
          },
          copied ? t('setup.copied') : t('setup.copy'),
        ),
      )
    }

    /**
     * First-run guidance.
     *
     * The panel's whole value depends on a credential it does not own, so the one
     * state it must never leave unexplained is "there is nothing to show yet".
     * Each missing piece is named, ordered, and paired with the exact command that
     * fixes it — quoted from where this copy of the plugin is actually installed,
     * because `node scripts/configure.mjs` is only correct from inside the source
     * checkout.
     */
    function Setup(props) {
      const { t, status, onRecheck } = props
      const gh = status.gh ?? {}
      const helper = status.helper ?? {}
      const configure = typeof helper.configureScript === 'string' ? helper.configureScript : 'scripts/configure.mjs'
      const configFile = typeof helper.configFile === 'string' ? helper.configFile : (typeof status.configFile === 'string' ? status.configFile : '')
      const missing = Array.isArray(gh.missingScopes) ? gh.missingScopes : []
      const steps = []

      if (gh.available !== true) {
        steps.push(
          h(
            'div',
            { className: 'dsc-step', key: 'install' },
            h('span', { className: 'dsc-step-title' }, t('setup.ghMissing')),
            h('span', null, t('setup.ghMissingStep')),
            h(CopyLine, { t, command: 'winget install --id GitHub.cli' }),
            h('span', null, h('a', { className: 'dsc-btn', 'data-kind': 'quiet', href: 'https://cli.github.com/', target: '_blank', rel: 'noreferrer' }, 'cli.github.com')),
          ),
        )
      } else if (gh.authenticated !== true) {
        steps.push(
          h(
            'div',
            { className: 'dsc-step', key: 'login' },
            h('span', { className: 'dsc-step-title' }, t('setup.authNeeded')),
            h('ol', { className: 'dsc-ordered' },
              h('li', null, t('setup.authStep1')),
              h('li', null, t('setup.authStep2')),
              h('li', null, t('setup.authStep3')),
            ),
            h(CopyLine, { t, command: 'gh auth login' }),
          ),
        )
      } else if (missing.length > 0) {
        steps.push(
          h(
            'div',
            { className: 'dsc-step', key: 'scopes' },
            h('span', { className: 'dsc-step-title' }, t('setup.scopesNeeded', { scopes: missing.join(', ') })),
            h('span', null, t('setup.scopesStep')),
            h(CopyLine, { t, command: `gh auth refresh -h github.com -s ${missing.join(',')}` }),
          ),
        )
      }

      const repos = Array.isArray(status.repos) ? status.repos : []
      if (repos.length === 0) {
        steps.push(
          h(
            'div',
            { className: 'dsc-step', key: 'repos' },
            h('span', { className: 'dsc-step-title' }, t('setup.reposNeeded')),
            h(CopyLine, { t, command: `node "${configure}" add owner/repo --path "F:\\CodeProj\\repo"` }),
            h(CopyLine, { t, command: `node "${configure}" list` }),
            configFile !== '' ? h('span', null, `${t('setup.reposFile')} ${configFile}`) : null,
            h('span', null, t('setup.help')),
          ),
        )
      }

      if (steps.length === 0 && status.configProblem === null) return null

      return h(
        'div',
        { className: 'dsc-setup' },
        h(
          'div',
          { className: 'dsc-setup-head' },
          h('span', { className: 'dsc-setup-title' }, t('setup.title')),
          h('button', { type: 'button', className: 'dsc-btn', onClick: onRecheck }, t('setup.recheck')),
        ),
        status.configProblem !== null && status.configProblem !== undefined
          ? h('div', { className: 'dsc-warn' }, t('setup.configProblem', { reason: String(status.configProblem) }))
          : null,
        Number(status.configDropped) > 0
          ? h('div', { className: 'dsc-warn' }, t('setup.dropped', { count: String(status.configDropped) }))
          : null,
        ...steps,
      )
    }

    /** The console panel: header, one card per repository, and the notices. */
    function ConsolePage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const [status, setStatus] = React.useState(null)
      const [overview, setOverview] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [logs, setLogs] = React.useState(null)

      const loadStatus = React.useCallback(async () => {
        const result = await postJson(STATUS_URL, {}, STATUS_TIMEOUT_MS)
        if (!result.ok) {
          setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
          return
        }
        if (result.response.ok && result.payload?.ok === true) {
          setStatus(result.payload.value ?? null)
          setError(null)
          return
        }
        setError(t('state.statusFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
      }, [t])

      /**
       * Load the overview.
       *
       * `silent` is what the poll uses: a failed BACKGROUND request must never
       * clear the last known state nor raise a banner the user did not ask for.
       */
      const loadOverview = React.useCallback(async (options) => {
        const silent = options?.silent === true
        const result = await postJson(OVERVIEW_URL, { force: options?.force === true }, OVERVIEW_TIMEOUT_MS)
        if (!result.ok) {
          if (!silent) setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
          return
        }
        if (result.response.ok && result.payload?.ok === true) {
          setOverview(result.payload.value ?? null)
          if (!silent) setError(null)
          return
        }
        if (!silent) setError(result.payload?.message ?? `HTTP ${String(result.response.status)}`)
      }, [t])

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
      const runAction = React.useCallback(
        async (key, url, body, successKey, params) => {
          setBusy(key)
          setNotice(null)
          setError(null)
          const result = await postJson(url, body, ACTION_TIMEOUT_MS)
          setBusy('')
          if (!result.ok) {
            setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
            return
          }
          if (!result.response.ok || result.payload?.ok !== true) {
            setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
            return
          }
          setNotice(t(successKey, params))
          await loadOverview({ force: true })
        },
        [loadOverview, t],
      )

      const onAction = React.useCallback(
        (kind, data, extra) => {
          if (kind === 'build') {
            void runAction(`build:${data.repo}`, DISPATCH_URL, { repo: data.repo, workflow: status?.config?.buildWorkflow ?? 'ci.yml' }, 'state.dispatched', { workflow: status?.config?.buildWorkflow ?? 'ci.yml', repo: data.repo })
            return
          }
          if (kind === 'release') {
            void runAction(`release:${data.repo}`, DISPATCH_URL, { repo: data.repo, workflow: status?.config?.releaseWorkflow ?? 'release.yml', inputs: { draft: 'true' } }, 'state.releaseDispatched', { repo: data.repo })
            return
          }
          if (kind === 'cancel' || kind === 'rerun-failed') {
            void runAction(`${kind}:${data.repo}`, RUN_ACTION_URL, { repo: data.repo, runId: extra?.runId, action: kind }, kind === 'cancel' ? 'state.cancelled' : 'state.rerun', {})
          }
        },
        [runAction, status],
      )

      const onPublish = React.useCallback(
        (repo, tag) => {
          void runAction(`publish:${repo}`, RELEASE_ACTION_URL, { repo, tag, action: 'publish' }, 'state.published', { tag })
        },
        [runAction],
      )

      const onLogs = React.useCallback(async (data, run) => {
        if (logs !== null && logs.repo === data.repo && logs.runId === run.id) {
          setLogs(null)
          return
        }
        setError(null)
        const result = await postJson(LOGS_URL, { repo: data.repo, runId: run.id }, ACTION_TIMEOUT_MS)
        if (!result.ok) {
          setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
          return
        }
        if (!result.response.ok || result.payload?.ok !== true) {
          setError(t('state.actionFailed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
          return
        }
        setLogs({ repo: data.repo, runId: run.id, lines: result.payload.value?.lines ?? [], truncated: result.payload.value?.truncated === true })
      }, [logs, t])

      const repos = overview?.repos ?? []
      const gh = status?.gh ?? null

      const header = h(
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
          gh !== null && gh.account !== null ? h(Badge, { state: 'idle' }, `${t('meta.account')} ${gh.account}`) : null,
          overview !== null && typeof overview.fetchedAt === 'string'
            ? h('span', null, t('meta.updated', { time: stamp(overview.fetchedAt) }), overview.cached === true ? ` (${t('meta.cached')})` : '')
            : null,
          h('button', { type: 'button', className: 'dsc-btn', disabled: busy !== '', onClick: () => { void loadStatus(); void loadOverview({ force: true }) } }, t('action.refresh')),
        ),
      )

      const body = []
      if (status === null) {
        body.push(h('div', { className: 'dsc-empty', key: 'loading' }, t('state.loading')))
      } else {
        // The setup block is shown for every reason the panel has nothing useful
        // to render — and hidden once it does, so it never becomes furniture.
        const needsSetup = status.gh?.available !== true
          || status.gh?.authenticated !== true
          || (Array.isArray(status.gh?.missingScopes) && status.gh.missingScopes.length > 0)
          || (Array.isArray(status.repos) && status.repos.length === 0)
          || (status.configProblem !== null && status.configProblem !== undefined)
        if (needsSetup) {
          body.push(h(Setup, { key: 'setup', t, status, onRecheck: () => { void loadStatus(); void loadOverview({ force: true }) } }))
        }
        if (overview?.configProblem) {
          body.push(h('div', { className: 'dsc-warn', key: 'config' }, t('setup.configProblem', { reason: String(overview.configProblem) })))
        }
        for (const data of repos) {
          body.push(h(RepoCard, { key: data.repo, t, data, busy, onAction, onPublish: (tag) => onPublish(data.repo, tag), logs, onLogs }))
        }
      }

      return h(
        'div',
        { className: 'dsc-root' },
        header,
        error !== null ? h('div', { className: 'dsc-error', role: 'alert' }, error) : null,
        notice !== null ? h('div', { className: 'dsc-notice', role: 'status' }, notice) : null,
        ...body,
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
