# compact-prep ハーネス

Claude Code の `/compact`（手動 / 自動）で失われやすい「判断構造」「セッション状態」を
圧縮前に固定パスの state file へ退避し、圧縮直後のターンで自動的に読み戻すための
skill + hooks 一式。context 60% で `/compact-prep` を促し、自動 compact に先を越される
前にユーザーが手動 `/compact-prep` → `/compact` を打てる状態を作る。

## 構成

| 種別 | 実体 | 役割 |
|------|------|------|
| skill | `.claude/skills/compact-prep/SKILL.md` | `/compact-prep`。圧縮前に state file を保存 |
| script | `.claude/scripts/get-session-id.sh` | 現セッションの session_id を推定（statusline のポインタを参照） |
| hook (PostCompact) | `.claude/hooks/compaction-recovery.sh` | 圧縮発生を marker で記録 |
| hook (UserPromptSubmit) | `.claude/hooks/userpromptsubmit-compaction-recovery.sh` | marker 検出 → 復旧指示を注入（one-shot） |
| hook (UserPromptSubmit) | `.claude/hooks/userpromptsubmit-compact-prep-reminder.sh` | warn marker 検出 → `/compact-prep` 提案を注入（one-shot） |
| statusline | `.claude/statusline.py` | 毎ターン session_id ポインタを書き、ctx≥60% で warn marker を書く |
| 登録断片 | `.claude/compact-prep/settings.json` | hooks 登録の project scope 用テンプレート |

## marker file（`${TMPDIR:-/tmp}` 配下）

| ディレクトリ | 書き手 → 読み手 | 意味 |
|---|---|---|
| `claude-session-id/<sid>` | statusline → get-session-id.sh | session_id ↔ cwd ポインタ |
| `claude-compact-state/<sid>.md` | compact-prep skill → recovery hook | 圧縮前に退避した作業状態 |
| `claude-compact-warn/<sid>` | statusline → reminder hook | 「これから通知したい」warn |
| `claude-compact-warned/<sid>` | reminder hook → PostCompact hook | 「通知済み」cooldown（二重通知防止） |
| `claude-compacted/<sid>` | PostCompact hook → recovery hook | 「圧縮直後」marker |

## 有効化（project scope）

hooks は **global (`~/.claude/settings.json`) には登録しない**。毎プロンプト発火する
UserPromptSubmit hook を全プロジェクトへ広げないため、有効化したいプロジェクトごとに
`<project>/.claude/settings.json` へ `settings.json` の `hooks` ブロックをマージする。

```bash
# 1) スクリプト実体を ~/.claude 配下へ symlink（初回のみ / 冪等）
DOTFILES=/path/to/dotfiles bash "$DOTFILES/install.sh"

# 2) 有効化したいプロジェクトで、.claude/compact-prep/settings.json の
#    hooks ブロックを <project>/.claude/settings.json にマージする
```

`get-session-id.sh` / 各 hook / statusline の実体は `install.sh` が
`~/.claude/scripts` ・ `~/.claude/hooks` へ symlink するため、上記の hooks 登録だけで
そのプロジェクトで機能する（登録が無いプロジェクトでは hook は発火しない）。

## 閾値（60%）の前提

自動 compact は概ね 90〜95% で発火する。その手前で通知するため閾値を 60% にしている。
60% 時点で十分な作業余力を残すには 1M context が前提で、200K context のままだと
`.claude/statusline.py` の `COMPACT_WARN_THRESHOLD` を 80% 台へ上げる方が実用的。

## 注意: skill の永続化

`.claude/skills/` は `bun run rulesync:skills:claude` で再生成される領域で、生成元は
`kanade0404/skills` と `planetscale/database-skills`。`compact-prep` skill を rulesync
再生成後も残すには、`kanade0404/skills` の `skills/compact-prep/SKILL.md` として
push すること（このリポジトリ直下の `.claude/skills/compact-prep/` は再生成で消える
可能性がある）。hooks / scripts / statusline / settings 断片は本リポジトリが正。
