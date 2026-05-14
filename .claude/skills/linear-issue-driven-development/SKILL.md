---
name: linear-issue-driven-development
description: |
  Linear で "claude:ready" ラベルが付いた issue 1 件を、対象リポジトリの worktree
  作成から実装・コミット・PR 作成・CI all-green・レビュー (人間 / CodeRabbit) コメント
  解消まで、ヘッドレスで完遂するためのワークフロー。`linear-issue-runner` が 1 時間
  毎に各 issue を別 Claude セッションでこの skill を呼び出す。手動で 1 件だけ流す
  ときは `/linear-issue <IDENTIFIER>` slash command を使う。

  use when:
    - the runner injects "Run the skill `linear-issue-driven-development`" with an Issue JSON
    - the user invokes /linear-issue
---

# linear-issue-driven-development

Linear issue を 1 件受け取り、PR がマージ可能な状態 (CI 緑 + 未解消レビューコメント 0)
になるまで自走するスキル。

## 入力契約

セッション冒頭のユーザーメッセージに以下のキーを含む issue JSON が渡される。

```json
{
  "id": "uuid",
  "identifier": "ENG-123",
  "title": "...",
  "description": "...",
  "url": "https://linear.app/...",
  "branchName": "kanade0404/eng-123-...",
  "team": { "key": "ENG" },
  "labels": { "nodes": [{ "id": "...", "name": "claude:ready" }, ...] }
}
```

`identifier` と `branchName` は Linear 側で生成済み。`branchName` をそのまま git
ブランチ名として使うこと (Linear の自動連携が ID を拾えるようにするため)。

## 対象リポジトリの解決

issue の description / title から対象リポジトリを推測する。判断材料の優先順:

1. description 本文の `repo: owner/name` 行
2. description 内の GitHub URL
3. labels に `repo:<owner-name>` がある場合はそれ
4. どれも無ければ `claude:failed` でフェイルする (推測でリポジトリを変更しない)

リポジトリのローカルクローンが `~/work/<repo-name>` または ghq 管理下にあるか確認し、
無ければ `gh repo clone owner/name ~/work/<repo-name>` で取得する。

## 主要ステップ

### 1. worktree 作成

```bash
cd <repo-root>
gw add "<issue.branchName>" origin/main   # main の名前はリポジトリに合わせる
cd .worktrees/<issue.branchName>
```

`gw` は dotfiles 同梱の git worktree ヘルパ (`~/.local/bin/gw`)。base ブランチは
`gh repo view --json defaultBranchRef -q .defaultBranchRef.name` で取得。

### 2. 実装方針の立案

- リポジトリの `CLAUDE.md` / `AGENTS.md` / `README.md` を読み、コミット規約・テスト
  コマンド・lint コマンドを確認。
- issue.description の Acceptance Criteria を満たす最小変更を設計。**機能を勝手に
  広げない**。設計が曖昧な場合は description の引用と前提を整理して PR description
  に書く (issue に質問コメントは投げない。runner はヘッドレスなので返答を待てない)。

### 3. 実装 + テスト

- 変更は意図したファイルにだけ加える。
- リポジトリにテストがある場合は必ずローカルで実行する。passing を確認できない
  状態で commit しない。
- リポジトリにテストが無い場合は最低限の手動検証 (ビルド・型チェック・lint) を
  通す。

### 4. commit

dotfiles 規約 (`.gitmessage`) の絵文字 prefix を踏襲する。issue identifier を
コミット末尾に含めると Linear と自動連携できる。

```
:sparkles: <Subject>

<Body explaining the why>

Refs: ENG-123
```

`git add -A` は使わない (settings.json で禁止)。変更ファイルを明示する。

### 5. push + PR 作成

```bash
git push -u origin "<branch>"
gh pr create \
  --title ":sparkles: <Subject> (ENG-123)" \
  --body "$(cat <<'EOF'
## Summary
- ...

## Linear
ENG-123 https://linear.app/...

## Test plan
- [x] unit tests
- [ ] manual verification

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

draft で出すかは issue label に従う:
- `claude:draft` があれば `--draft`
- 無ければ通常 PR

### 6. CI all-green まで監視

```bash
gh pr checks --watch --interval 30
```

失敗したチェックがあれば:
1. `gh pr checks --json name,conclusion,detailsUrl` で失敗ジョブを特定
2. `gh run view <run-id> --log-failed` でログを取得
3. 原因を直して追加 commit → push → 再度 watch

連続 3 回失敗したら `claude:failed` ラベルを付けて停止 (無限ループ防止)。

### 7. レビューコメント解消

人間のレビューと CodeRabbit (`coderabbit:autofix` skill が使える場合は活用) の
両方を対象に、unresolved な review thread が 0 になるまで対応する。

```bash
# 未解消スレッドを取得 (resolved=false)
gh api graphql -f query='
  query($owner:String!,$repo:String!,$pr:Int!) {
    repository(owner:$owner,name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:50) {
          nodes { id isResolved comments(first:5) { nodes { body path line } } }
        }
      }
    }
  }' -F owner=... -F repo=... -F pr=...
```

各スレッドに対して:
1. コメント本文を要約 → 同意できる指摘か判断
2. 同意 → 修正 commit → push
3. 不要/誤解 → スレッドに返信し、なぜそう書いたかを簡潔に説明
4. すべて対応したら GraphQL `resolveReviewThread` で resolve

CI が再度走るので 6 → 7 をループ。すべて resolved + CI green になったら抜ける。

### 8. 完了処理

- Linear の issue state を "In Review" (PR open の場合) もしくは GitHub merge が
  終わるまで `claude:done` だけ付ける形にする。
- 最後に `gh pr view <pr> --json url,state` を log に出す。

runner がこの skill の exit 状態を見て `claude:done` / `claude:failed` を張り替える
ので、skill 内で明示的に Linear ラベルを操作する必要はない (例外: 自発的に fail を
記録したい場合のみ `claude:failed` を立てる)。

## ガードレール

- **destructive な git 操作はしない**: `git reset --hard`, `git push --force*`,
  `git rebase` は settings.json deny で止まる。代わりに revert commit を積む。
- **他人のブランチに触らない**: 自分の worktree (`.worktrees/<branchName>`) の
  外側を編集しない。
- **secrets を出さない**: `.env*`, `*.tfvars`, 鍵類は読まない/書かない (settings
  でも deny)。
- **無限ループしない**: CI 失敗 3 連 / レビュー対応 5 周で打ち切り `claude:failed`。
- **対象が判別できないときは作業しない**: リポジトリ不明・branchName 衝突などは
  即フェイル。

## デバッグ手掛かり

セッション全体のログは `~/.local/state/linear-issue-runner/logs/<identifier>-*.log`
に残る。runner 側のメタログは同ディレクトリ直下、`launchd` の stdout は
`~/Library/Logs/linear-issue-runner.{out,err}.log`。
