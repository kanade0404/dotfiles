# 3. skill 配布パイプラインを全廃する

Date: 2026-09-27

## Status

Accepted

## Context

- 配布元リポジトリ `kanade0404/skills` が **harness (skills / subagents / commands / hooks / rules) を全削除した** (upstream PR #145、commit `4b17fc4` "remove all harness" + `380ffbb` "remove remaining rulesync distribution remnants")。`master` HEAD に残るのは `.envrc` / `.github` / `.gitignore` / `.python-version` / `README.md` / `flake.lock` / `flake.nix` のみ。
- ただしタグ `v0.9.0` / `v0.10.0` は harness を含む不変スナップショットとして残っており (skills 245 files)、本リポジトリは `rulesync.jsonc` / `rulesync-claude/rulesync.jsonc` の `ref: "v0.9.0"` でタグ固定していたため、**取得は壊れていなかった**。つまり upstream の削除で何かが動かなくなったのではなく、パイプラインが「**二度と更新されないスナップショット**を毎回再生成し続ける」状態になった。`.github/workflows/skills-update.yml` の daily cron (`35 20 * * *`) は新タグを探し続け、`planetscale/database-skills` は tag が無いため `resolvedRef` (commit SHA) で lock に固定されているだけだった。
- upstream issue #56 の実測 — 67 セッション・24,131 行の走査で **33 skill 中 21 (63.6%) がゼロ起動**。`tdd` / `tidy-first` / `test-review` のように「必ず起動」と明記された中核 skill すらゼロ起動だった。ただし issue #56 本文は「呼び出しがそもそも発生していないのか、Skill tool 以外の経路で計測から漏れているのかは切り分け不能」と留保している。本 ADR はこれを「**Skill tool 経由の起動が 0 だった**」という事実としてのみ扱う。
- 維持コストの内訳: rulesync config 2 本 (`rulesync.jsonc` / `rulesync-claude/rulesync.jsonc`)、lock 2 本、補助スクリプト 5 本 (`patch-rulesync-skill-frontmatter.ts` / `rewrite-codex-skill-dir.ts` + test / `update-skills-ref.ts` + test)、daily cron 1 本、CI ガード 1 job (`codex-skill-dir-guard`)、生成物を lint / review 対象外にするための除外設定 3 箇所 (`.markdownlint-cli2.jsonc` / `.coderabbit.yaml` / `test.yml` の shellcheck prune)。
- `planetscale/database-skills` 由来の 4 skill (`postgres` / `vitess` / `mysql` / `neki`) だけは upstream が生きているため、取得を続けること自体は可能だった。
- skill listing の実測は **68 skills / 26,478 chars** で、budget (16,000 chars) を超過していた。
- 本リポジトリの ADR 0002 で root instructions (`CLAUDE.md`) を廃止した流れの続きにあたる。

## Decision

- skills 生成物 3 ディレクトリ (`.claude/skills/` / `.agents/skills/` / `.opencode/skills/`、**654 files**) を削除する。
- rulesync パイプライン一式 (config 2 本 / lock 2 本 / 補助スクリプト 5 本 / `package.json` の `rulesync:skills*` 4 script / devDependency `rulesync` と `jsonc-parser` / daily cron / CI ガード job) を削除する。
- 死蔵していた `.claude-plugin/` (**31 files**。`enabledPlugins` にも marketplace にも未登録で、唯一の参照は markdownlint の ignore 1 箇所だった) も同時に削除する。
- **`planetscale/database-skills` 由来の 4 skill も削除する。** upstream が生きているので取り直し可能であり、4 skill のために config 2 本・lock 2 本・script 5 本・生成 3 ディレクトリを維持するのは不均衡と判断した。
- `install.sh` は skill の symlink **生成**をやめ、既に貼られた symlink の**剪定だけ**を残す。剪定は「リンク先が存在しなければ削除」ではなく「`$DOTFILES` 配下を指す symlink を無条件削除してから `rmdir`」型に変更する (既存の `~/.codex/skills` legacy 掃除ブロックと同型)。
- `scan-pr-conflicts.yml` が参照していた `pr-conflict-resolver` skill の手順は、workflow の `prompt` 内へ取り込んで自己完結させる。
- 合計 **698 files** (削除前の tracked 772 の約 90%) を削除し、残りは 75 files になる (本 ADR を含む)。

## Consequences

### Positive

- 二度と更新されないスナップショットの再生成をやめられる。
- lock 2 本・config 2 本・補助スクリプト 5 本・daily cron 1 本・CI ガード 1 job の保守が消える。生成物を lint / review 対象外にするための除外設定 3 箇所も消える。
- skill listing budget 超過 (実測 68 skills / 26,478 chars > 16,000) が解消され、**残る skill (plugin marketplace 経由のもの) の自動起動精度が上がる**。
- daily cron が毎朝失敗し続ける未来を避けられる (パイプラインを消すと `bun run rulesync:skills:update` が存在しなくなるため)。

### Negative

- **`~/.agents/skills/` 経由で OpenCode / Codex にグローバルに効いていた 37 skill が全プロジェクトから消える。** `.claude/skills` は project 限定だったが、`.agents/skills` は `install.sh` が `~/.agents/skills/` へ symlink していたため、どの cwd でもフルセットが使えていた。この喪失が本決定の最大のコストである。
- `install.sh` を再実行するまで `~/.agents/skills/` と `~/.config/opencode/skills/` に dangling symlink が残る (剪定ブロックは残したので、再実行すれば掃除されて `rmdir` まで進む)。
- **復旧コストは削除コストと非対称。** 必要になったら `rulesync` の再導入か手動 vendor が必要で、削除は 1 コミットでも復旧は同じ手数では終わらない。
- `linear-issue` slash command (`.claude/commands/linear-issue.md`) が失われる。参照先の `linear-issue-driven-development` skill が消えるため同時に落とした。Linear → Claude Code 自走パイプラインを手動で 1 件流す経路がなくなる。
- `planetscale/database-skills` の 4 skill も失われる。DB 作業時に参照したくなった場合は取り直しが必要。

## Alternatives Considered (rejected)

### Option 1: `ref: v0.9.0` のまま凍結して使い続ける

取得は壊れていないので、何もしなければ動き続ける。だが「更新されないスナップショット」のために config 2 本・lock 2 本・script 5 本・daily cron・CI ガード job の全パイプラインを維持することになる。cron は新タグを探して空振りし続け、CI ガードは生成物の整合性だけを守り続ける。払うコストに対して得るものが無い。却下。

### Option 2: `planetscale` の 4 skill だけ vendor して rulesync を畳む

4 skill は project 限定の `.claude/skills/` にしか入らず、このリポジトリで DB 作業はしないため実質的に起動しない。グローバルに効かせたいなら `~/.agents/skills/` へ直接インストールするのが正しい形であり、dotfiles に build パイプラインを残す理由にはならない。却下。

### Option 3: 生成物だけ消してパイプラインを残す

配る中身 (upstream の harness) が無いので、パイプラインを残しても生成できるのは凍結スナップショットだけ。無意味。却下。

## 再考トリガ

skill を再び使いたくなった場合、または `~/.agents/skills/` グローバル配布の喪失が実害をもたらした場合 (Codex / OpenCode で同じ手順を毎回手で説明し直している、DB 作業で 4 skill を探し直した等) は、**dotfiles に build パイプラインを戻すのではなく `~/.agents/skills/` へ直接インストールする形を先に検討する**。dotfiles が担うべきは「グローバルに効く置き場所への配置」であって「upstream からの生成」ではない、というのが本 ADR で学んだ区別である。
