# Push local commits to GitHub through the Git Data API.
#
# Why this exists: on this machine `github.com:443` is intermittently blocked
# while `api.github.com:443` stays reachable, so `git push` fails with
# "Connection was reset" / "Could not connect to server". The API can create the
# same objects, and because git objects are content-addressed the reconstructed
# commit carries the *same SHA* as the local one — so updating the ref leaves the
# clone and the remote identical, with no divergence to reconcile later.
#
# Safety: every reconstructed commit SHA is compared against the local commit
# SHA before the ref is touched. A single mismatch aborts without moving the ref.
param(
  [Parameter(Mandatory = $true)][string]$RepoPath,
  [string]$Owner = 'SOH4C4759',
  [string]$Repo
)

$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = Split-Path $RepoPath -Leaf }

function Write-JsonFile([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
}

function Get-BlobBytes([string]$BlobSha, [string]$Scratch) {
  # cmd redirection is byte-exact; PowerShell's native-output capture is not.
  $out = Join-Path $Scratch 'blob.bin'
  cmd /c "git cat-file blob $BlobSha > `"$out`""
  if ($LASTEXITCODE -ne 0) { throw "git cat-file blob $BlobSha failed" }
  return [IO.File]::ReadAllBytes($out)
}

Push-Location $RepoPath
try {
  $head = (git rev-parse HEAD).Trim()
  $remote = (gh api "repos/$Owner/$Repo/git/ref/heads/main" --jq '.object.sha').Trim()
  Write-Host "[$Repo] remote main $($remote.Substring(0,7))  local HEAD $($head.Substring(0,7))"
  if ($remote -eq $head) { Write-Host "[$Repo] already in sync"; return }

  $chain = @()
  $cursor = $head
  while ($cursor -ne $remote) {
    $chain = @($cursor) + $chain
    $cursor = (git rev-parse "$cursor^").Trim()
    if ($chain.Count -gt 20) { throw "[$Repo] remote main is not an ancestor of HEAD — refusing to rewrite history" }
  }
  Write-Host "[$Repo] $($chain.Count) commit(s) to publish"

  $scratch = Join-Path $env:TEMP ("apipush-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  $parent = $remote

  foreach ($commit in $chain) {
    $meta = (git log -1 --format='%H%n%T%n%an%n%ae%n%aI%n%cn%n%ce%n%cI' $commit) -split "`n"
    $expectedTree = $meta[1].Trim()
    $an = $meta[2]; $ae = $meta[3]; $ad = $meta[4].Trim()
    $cn = $meta[5]; $ce = $meta[6]; $cd = $meta[7].Trim()
    $message = ((git log -1 --format='%B' $commit) -join "`n")

    $entries = @()
    foreach ($line in (git show --name-status --format= $commit)) {
      if ($line -match '^\s*$') { continue }
      $parts = $line -split "`t"
      $status = $parts[0]; $path = $parts[1]
      if ($status -notmatch '^(A|M)$') { throw "[$Repo] unsupported change '$status' for $path — refusing" }
      $blobSha = (git rev-parse "${commit}:$path").Trim()
      $bytes = Get-BlobBytes $blobSha $scratch
      $blobBody = Join-Path $scratch 'blob.json'
      Write-JsonFile $blobBody @{ content = [Convert]::ToBase64String($bytes); encoding = 'base64' }
      $uploaded = (gh api --method POST "repos/$Owner/$Repo/git/blobs" --input $blobBody --jq '.sha').Trim()
      if ($uploaded -ne $blobSha) { throw "[$Repo] blob round-trip changed $path ($blobSha -> $uploaded)" }
      $entries += @{ path = $path; mode = '100644'; type = 'blob'; sha = $blobSha }
    }

    $parentTree = (gh api "repos/$Owner/$Repo/git/commits/$parent" --jq '.tree.sha').Trim()
    $treeBody = Join-Path $scratch 'tree.json'
    Write-JsonFile $treeBody @{ base_tree = $parentTree; tree = @($entries) }
    $newTree = (gh api --method POST "repos/$Owner/$Repo/git/trees" --input $treeBody --jq '.sha').Trim()
    if ($newTree -ne $expectedTree) { throw "[$Repo] tree mismatch for $($commit.Substring(0,7)): $newTree != $expectedTree" }

    $commitBody = Join-Path $scratch 'commit.json'
    Write-JsonFile $commitBody @{
      message   = $message
      tree      = $newTree
      parents   = @($parent)
      author    = @{ name = $an; email = $ae; date = $ad }
      committer = @{ name = $cn; email = $ce; date = $cd }
    }
    $created = (gh api --method POST "repos/$Owner/$Repo/git/commits" --input $commitBody --jq '.sha').Trim()
    if ($created -ne $commit) { throw "[$Repo] commit mismatch: $created != $commit — no ref was moved" }
    Write-Host "  + $($commit.Substring(0,7)) $((git log -1 --format='%s' $commit))  [sha identical]"
    $parent = $commit
  }

  $refBody = Join-Path $scratch 'ref.json'
  Write-JsonFile $refBody @{ sha = $parent; force = $false }
  gh api --method PATCH "repos/$Owner/$Repo/git/refs/heads/main" --input $refBody --jq '.object.sha' | Out-Null

  $after = (gh api "repos/$Owner/$Repo/git/ref/heads/main" --jq '.object.sha').Trim()
  if ($after -ne $head) { throw "[$Repo] ref update did not land where expected: $after" }

  # A real `git push` also moves the remote-tracking ref; going through the API does
  # not, and a stale origin/main makes `git status` report a phantom "ahead" — which
  # is exactly what a release panel reading `@{u}...HEAD` would then show.
  & git update-ref "refs/remotes/origin/main" $after
  Write-Host "[$Repo] PUSHED — remote main now $($after.Substring(0,7)), identical to local HEAD (tracking ref updated)"

  Remove-Item -Recurse -Force $scratch
} finally {
  Pop-Location
}
