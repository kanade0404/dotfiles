# 3. skill の生成・配布パイプラインを廃止する (CI の pin 取得のみ残す)

Date: 2026-09-27

## Status

Accepted

Amends [2. CLAUDE.md を廃止し、root instructions を持たない](0002-retire-root-instructions.md)

## Drivers

保守性 > エージェント能力の広さ。「二度と更新されないスナップショットを再生成し続ける
ビルドパイプライン」の維持コストを、グローバル skill 配布で得ていた能力の広さより上に置く。

本 ADR の数値はすべて末尾「## 数値の導出」のコマンドで再導出できる。

## Context

- 配布元リポジトリ `kanade0404/skills` が **harness (skills / subagents / commands / hooks / rules) を全削除した** (upstream PR #145、commit `4b17fc4` "remove all harness" + `380ffbb` "remove remaining rulesync distribution remnants")。`master` HEAD に残るのは `.envrc` / `.github` / `.gitignore` / `.python-version` / `README.md` / `flake.lock` / `flake.nix` のみ。
- タグは `v0.1.0` 〜 `v0.10.0` と `v1.0.0` の 12 本。12 本すべての tree 直下を確認したところ、**harness (`skills/`) を含むのは `v0.1.0` 〜 `v0.10.0` の 11 本**で、**最新の `v1.0.0` (`fac1a609`) だけ `skills/` が無い** (PR #145 の merge commit)。harness を含む最後のタグは `v0.10.0` (`20a0a4cb433031d1d758d290f2333a2ce1f03b5e`)。本リポジトリは `ref: "v0.9.0"` でタグ固定していたため取得は壊れていなかった。つまり upstream の削除で何かが動かなくなったのではなく、パイプラインが「**二度と更新されないスナップショット**を毎回再生成し続ける」状態になった。
- `v0.9.0` の `skills/` は **168 files (33 skill ディレクトリ)**。`planetscale/database-skills` は tag が無いため `resolvedRef` (commit SHA) で lock に固定されているだけだった。
- upstream issue #56 の実測 — 67 セッション・24,131 行の走査で **33 skill 中 21 (63.6%) がゼロ起動**。`tdd` / `tidy-first` / `test-review` のように「必ず起動」と明記された中核 skill すらゼロ起動だった。集計対象は assistant の `tool_use.name=="Skill"` の `input.skill` **と** user メッセージ中の `<command-name>` の両方なので、本 ADR はこれを「**Skill tool または `<command-name>` 経由の起動が 0 だった**」という事実としてのみ扱う。留保は 2 つある:
  - issue #56 本文の留保 — 「呼び出しがそもそも発生していないのか、Skill tool / `<command-name>` 以外の経路 (説明文の直接遂行など) で計測から漏れているのかは切り分け不能」。
  - **走査対象が top-level session ログ 67 ファイルに限られ、subagent の sidechain ログ 431 ファイル (113MB) が除外されている**。subagent 内で起動された skill は構造的に不可視になる。ゼロ起動 21 skill のうち 8 本 (`design` / `design-review` / `empirical-prompt-tuning` / `handoff` / `pr-monitor` / `tdd` / `test-review` / `tidy-first`) は、他の SKILL.md 側に subagent dispatch される記述があるため、その 8 本については「起動されていない」と「除外されたログでだけ起動した」を区別できない。
  - ただし**これが 63.6% を系統的に過小評価させると断定はできない**。同じ導出で非ゼロ起動 12 skill の側も 9 本 (75.0%) が subagent dispatch 経路を持ち、割合はゼロ起動側 (38.1%) より**高い**。したがってこの除外は「向きの分からない未定量の計測漏れ」であって、「63.6% が過小評価である」ことの根拠にはならない。
- 維持コストの内訳: rulesync config 2 本 (`rulesync.jsonc` / `rulesync-claude/rulesync.jsonc`)、lock 2 本、補助スクリプト 5 本 (`patch-rulesync-skill-frontmatter.ts` / `rewrite-codex-skill-dir.ts` + test / `update-skills-ref.ts` + test)、daily cron 1 本、CI ガード 1 job (`codex-skill-dir-guard`)、生成物を lint / review 対象外にするための除外設定 3 箇所 (`.markdownlint-cli2.jsonc` / `.coderabbit.yaml` / `test.yml` の shellcheck prune)。
- `planetscale/database-skills` 由来の 4 skill (`postgres` / `vitess` / `mysql` / `neki`) だけは upstream が生きているため、取得を続けること自体は可能だった。
- skill listing が context budget を圧迫していた。**ただし「68 skills / 26,478 chars > budget 16,000 chars」という数値は本 ADR の初版が唯一の出典で、測定方法が記録されておらず再導出できない。** 本 ADR ではこの数値を根拠に使わない。代わりに再導出可能な事実として、削除した `.claude/skills/` 37 skill の frontmatter が listing に寄与していた分量は **22,698 chars** (`- <name>: <description>` 形式で合算) である。これは「削除で listing が小さくなる」ことは示すが、「budget 超過が解消される」ことは示さない (削除後の実測は未取得)。
- 本リポジトリの ADR 0002 で root instructions (`CLAUDE.md`) を廃止した流れの続きにあたる。

## Decision

- skills 生成物 3 ディレクトリ (`.claude/skills/` / `.agents/skills/` / `.opencode/skills/`、**654 files** = 218 files × 3) を削除する。各ディレクトリの skill 数は 37 (upstream 33 + planetscale 4)。
- rulesync パイプライン一式 (config 2 本 / lock 2 本 / 補助スクリプト 5 本 / `package.json` の `rulesync:skills*` 4 script / devDependency `rulesync` と `jsonc-parser` / daily cron / CI ガード job) を削除する。
- **`planetscale/database-skills` 由来の 4 skill も削除する。** upstream が生きているので取り直し可能であり、4 skill のために config 2 本・lock 2 本・script 5 本・生成 3 ディレクトリを維持するのは不均衡と判断した。
- `.coderabbit.yaml` は**ファイルごと削除する**。このファイルの内容は `reviews.path_filters` の 3 エントリ (`!.claude/skills/**` / `!.agents/skills/**` / `!.opencode/skills/**`) だけで、他の設定を持っていなかったため、生成物が消えた時点で全内容が死に設定になる。CodeRabbit は設定ファイル不在なら既定値で動く。
- `install.sh` は skill の symlink **生成**をやめ、既に貼られた symlink の**剪定だけ**を残す。skills 4 ディレクトリの剪定は「リンク先が存在しなければ削除」ではなく「`$DOTFILES` 配下を指す symlink を、リンク先の存在を問わず削除してから `rmdir`」型 (`mode=retired`) にする。**この「無条件削除」が安全なのは `case` で削除対象を `$DOTFILES/<subdir>/` で始まる絶対パスに限定しているから**であり、他ツールが置いた実体や別 checkout を指すリンクには触れない (実装は `prune_dotfiles_symlinks`。この不変条件はヘルパーのコメントにも書いてあり、`scripts/codex-otel.test.ts` の `describe("prune_dotfiles_symlinks")` が固定している)。
- 上記の対比は **skills に限る**。**配布を続ける `~/.claude/commands` / `~/.codex/commands` には「リンク先が存在しなければ削除」型 (`mode=dangling`、`rmdir` もしない) を新設する**。旧 `install.sh` に commands の剪定は無く、生成ブロックが 2 箇所あっただけなので、これは抽出ではなく**新しい振る舞いの追加**である。mode を分けたのは「配布をやめたディレクトリ (retired)」と「配布を続けており将来また中身が増えうるディレクトリ (dangling)」で、生きたリンクを消してよいかが逆になるため。
- `scan-pr-conflicts.yml` が参照していた `pr-conflict-resolver` skill の手順は、workflow の `prompt` 内へ取り込んで自己完結させる。
- **例外 — 残す upstream 依存**: `.github/workflows/claude-code-review.yml` は `kanade0404/skills` を pin SHA (`363138744442c5f1f2b65a2414a4d8ba7e0ac264`) で checkout し、CI 実行時に `.claude/skills/code-review` をその場で生成する経路を**残す**。これがこのリポジトリに残る唯一の live な upstream skill 依存である。「全廃」ではなく「repo にコミットする生成物と、それを作るローカル向けビルドパイプラインの廃止」が本決定の範囲。
- 合計 **698 files** (削除前の tracked 772 の約 90%) を削除し、残りは 75 files になる (本 ADR を含む)。うち**本決定に直接帰属するのは 667 files**で、残る 31 files は下記「関連するが独立した整理」の `.claude-plugin/` である。

### 関連するが独立した整理: `.claude-plugin/` の削除

`.claude-plugin/` (**31 files**) も同じ PR で削除するが、これは skill 配布パイプラインとは
**独立した整理**であり、1 ADR 1 決定の原則からは別件として読むべきものである。

判定根拠は「`.claude/settings.json` の `enabledPlugins` (20 件、すべて
`@claude-plugins-official`) にも `.codex/config.toml` の `[marketplaces.*]` にも
ローカル `.claude-plugin` は登録されておらず、repo 内でパス `.claude-plugin/` を参照する
箇所が `.markdownlint-cli2.jsonc` の ignore 1 行だけだった」という
**静的な未登録状態からの推論**である。
「実際に一度も読み込まれていなかった」ことを観測したわけではない (ロードされたかどうかの
ログを取っていない)。したがって「死蔵」は断定ではなく、**未登録なので読み込まれる経路が
見当たらない**という所見に留まる。

## Amends ADR 0002

ADR 0002 は「削除する `CLAUDE.md` 596 行のうち、コード近傍や別ファイルに実体があるものは
**喪失に数えない**」という会計で Negative を絞っていた。本決定はその根拠を 2 箇所で無効化する。
下記はいずれも 0003 の Negative として計上する (ADR 0002 本文は書き換えない)。

### (a) OpenCode の skill 探索パス

ADR 0002 は「`.opencode/skills/` の用途・探索パス・symlink 方針は `install.sh:427-431` の
インラインコメントが持つ」として喪失に数えなかったが、**本 PR がそのコメントを置換した**。
これは 0003 の再考トリガ (「`~/.agents/skills/` へ直接インストールする形を先に検討する」) を
実行するのに必要な知識そのものなので、ADR 本文とヘルパーのコメントに**書き残す**:

> OpenCode は `~/.config/opencode/` を global config として読み、skill は
> `~/.config/opencode/skills/<name>/SKILL.md` を探索する。project 側の
> `.opencode/skills/` と `.agents/skills/`、および `~/.claude/skills/` も
> fallback として読む。

### (b) Linear 自走パイプラインの運用パラメータ

ADR 0002 は「routine secrets・ラベル状態遷移・ループ上限は
`.claude/skills/linear-issue-driven-development/SKILL.md` と `.claude/commands/linear-issue.md`
に**本体として存続する**」としていたが、**本 PR が両方を削除した**。
`git grep -n 'claude:ready' -- . ':!docs/adr'` は **0 件** (本 ADR に書き残す前の時点でも
repo 全体で 0 件だった) で、コード側に代替は無い。記録として書き残す:

- routine secrets — `LINEAR_API_KEY` (Linear Personal API key) / `GH_TOKEN` (repo / workflow / write 権限の PAT)
- ラベル状態遷移 — `claude:ready` → `claude:in-progress` → `claude:done` / `claude:failed`
- ループ上限 — CI 失敗 3 連、レビュー対応 5 周で `claude:failed` を付けて停止
- 排他制御 — ラベル張替は「最古検証を先、張替を後」の順で行い、敗者やクラッシュが `claude:ready` を失わないようにする (upstream kanade0404/skills#31 の queue 消失バグ対策)

## Consequences

### Positive

- 二度と更新されないスナップショットの再生成をやめられる。
- lock 2 本・config 2 本・補助スクリプト 5 本・daily cron 1 本・CI ガード 1 job の保守が消える。生成物を lint / review 対象外にするための除外設定 3 箇所も消える。
- **daily cron が `v1.0.0` への bump を提案し、それを merge すると生成物が無言で消えるリスクを断てる** (詳細は Alternatives の Option 1)。
- skill listing が縮む。削除分の寄与は **22,698 chars** (37 skill の `- <name>: <description>` 合算)。これにより **budget 超過幅の縮小を見込み、残る skill (plugin marketplace 経由のもの) の自動起動精度の改善を期待する**。ただし削除後の listing サイズも起動精度も未測定であり、因果を主張できる根拠は無い。**検証は下記「再考トリガ」の skill 起動再計測で行う**。

### Negative

- **`~/.agents/skills/` 経由で OpenCode / Codex にグローバルに効いていた 37 skill が全プロジェクトから消える。** `.claude/skills` は project 限定だったが、`.agents/skills` は `install.sh` が `~/.agents/skills/` へ symlink していたため、どの cwd でもフルセットが使えていた。この喪失が本決定の最大のコストである。
- `install.sh` を再実行するまで `~/.agents/skills/` と `~/.config/opencode/skills/` に dangling symlink が残る。剪定ブロックは残したが、掃除の効き方には 2 つの条件がある:
  - **`$DOTFILES` が symlink を貼った時と同じ checkout パスであれば剪定される。** 実機の既存リンクは main checkout (`/Users/kanade0404/work/dotfiles/...`) を指しているため、worktree から `DOTFILES=<worktree>` で実行すると `case` の接頭辞に一致せず **1 本も剪定されない**。
  - **`rmdir` は他ツール由来の実体が同居していれば恒久的に失敗する** (`|| true` なので無害)。実機の内訳は `~/.agents/skills` が symlink 37 / 実ディレクトリ 17、`~/.config/opencode/skills` が symlink 37 / 実 15、`~/.claude/skills` が symlink 2 / 実 16、`~/.codex/skills` が symlink 0 / 実 17。つまり 4 ディレクトリすべてで `rmdir` は失敗する。なお `~/.claude/skills` の symlink 2 本 (`find-skills` / `orca-cli`) は `../../.agents/skills/...` という**相対パス**なので、剪定の `case` にも一致せず残る (他ツールの設置物なのでこれが正しい挙動)。
    **二次的な dangling は発生しない**ことを実機で確認済み。この 2 本は `~/.agents/skills/find-skills` / `~/.agents/skills/orca-cli` に解決されるが、その解決先は **どちらも実ディレクトリ** (`drwxr-xr-x`) であって dotfiles を指す symlink ではない。つまり剪定される 37 本の symlink には含まれないので、剪定後もリンクは生きたまま残る。加えて `~/.agents/skills` には実ディレクトリが 17 個あるため `rmdir` も失敗し、親ディレクトリごと消える経路も無い。検証コマンドは下記「## 数値の導出」に含めた。
- **可逆性: 本質的には two-way door。** 削除した 698 files は全量が git 履歴 (`origin/master`) にあり、source も upstream タグ `v0.9.0` / `v0.10.0` に全量残っている。`git checkout origin/master -- .claude/skills .agents/skills .opencode/skills` + `install.sh` で原状復帰でき、手数は削除と同程度。非対称なのは**生成物の復元ではなく (1) rulesync パイプラインの再構築と (2) `~/.agents/skills/` 配布経路の再設計**である。**唯一の不可逆リスクは upstream がタグを削除した場合** (`v0.9.0` / `v0.10.0` が消えると source 側の原本が失われる。生成物は git 履歴に残るのでそちらは残る)。
- `linear-issue` slash command (`.claude/commands/linear-issue.md`) が失われる。参照先の `linear-issue-driven-development` skill が消えるため同時に落とした。Linear → Claude Code 自走パイプラインを手動で 1 件流す経路がなくなる。運用パラメータは上記「Amends ADR 0002 (b)」に書き残した。
- `planetscale/database-skills` の 4 skill も失われる。DB 作業時に参照したくなった場合は取り直しが必要。
- **上記「Amends ADR 0002」の (a) OpenCode 探索パス・(b) Linear 運用パラメータは、ADR 0002 が「喪失に数えない」としていた根拠を本決定が消したもの**であり、本 ADR の Negative に計上する。どちらも本 ADR 本文に書き残したので、実質的な喪失は「コード近傍にあったものが ADR に移った」ことに留まる。
- **`pr-conflict-resolver` の能力が劣化する。** 削除した skill は `SKILL.md` + `scripts/*.sh` 5 本 (`pr-context.sh` / `resolve-merge.sh` / `regen-lockfiles.sh` / `verify.sh` / `finalize.sh`) を持ち、SKILL.md 自身が「決定的な多段操作はすべて scripts に閉じ込めてある。**フラグを追加したり、同等のコマンドを手で組み立てて代替したりしない**」と明記していた。`scan-pr-conflicts.yml` の新しい `prompt` は、まさにそれを散文で手組みしたものである。具体的に失われたもの:
  - `regen-lockfiles.sh` の 9 エコシステム分岐 (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock(b)` / `Cargo.lock` / `poetry.lock` / `uv.lock` / `go.sum` / `Gemfile.lock`) と「未知の lockfile は推測せず失敗する」規律。新 prompt は `bun install` 決め打ちで、他エコシステムは agent の即興任せになる。
  - `verify.sh` の exit code 保持保証 (「`|| true` は使わない」)。
  - `finalize.sh` の push 前チェックリスト (`git add` 前の marker 検査 / unmerged パス全量カバー確認 / working tree clean / `MERGE_HEAD` 消滅 / HEAD ブランチ確認) と `git add -A` 禁止。
  - **`needs-human` ラベル + 構造化コメント (`loop-escalation:v1` の JSON) によるエスカレーション契約。** 機械可読な停止シグナルが消えるため、ヘッドレス運用で「人間待ちで止まっている PR」を検知する経路が切れる。新 prompt の撤退手順は自由文コメントのみ。
- **`claude-code-review.yml` の pin が到達不能になると PR レビューが機能停止する (fallback 無し)。** upstream が pin SHA を消す (force push / repo 削除) と checkout / staging step が失敗し、**この 2 step には `continue-on-error` が無いので job ごと red になる** (`continue-on-error` が付いているのは skill 実行・サマリ抽出・コメント投稿の 3 step で、そちらの失敗は緑のまま `::warning::` に留まる)。つまりレビューは投稿されないが、pin の破損は CI に失敗として現れるので外部監視は要らない。かつ master 追随も `v1.0.0` への切り替えもできない (どちらも `skills/` を含まない) ため、復旧には `v0.10.0` 以前の別 ref を選ぶか skill を vendor する判断が必要になる。
- **剪定ブロックには sunset 条件が無い。** 再考トリガに従ってユーザーが `$DOTFILES/.agents/skills/` を自前 vendor して `~/.agents/skills/` へ symlink した場合、`install.sh` の mode=retired 剪定が**無言でそれを消す**。vendor する際は剪定ブロック側も同時に外すこと。

## Alternatives Considered (rejected)

### Option 1: `ref: v0.9.0` のまま凍結して使い続ける

取得は壊れていないので、何もしなければ動き続ける。だが「更新されないスナップショット」のために
config 2 本・lock 2 本・script 5 本・daily cron・CI ガード job の全パイプラインを維持することになる。

さらに悪いことに、**daily cron は空振りしない**。upstream の reusable workflow
(`consumer-update.yml`) は `git ls-remote --tags` の結果を `sort -V | tail -1` で解決するので
最新タグは `v1.0.0` になり、`scripts/update-skills-ref.ts` がそれを `ref` に書き込む bump PR を
提案する。`v1.0.0` には `skills/` が無いので、**その PR を merge すると再生成で
`kanade0404/skills` 由来の生成物 504 files が無言で消える** (`planetscale` 由来の 150 files は
残る)。凍結を維持するには bump PR を恒久的に拒否し続ける運用が必要になる。
払うコストに対して得るものが無い。却下。

### Option 2: `planetscale` の 4 skill だけ vendor して rulesync を畳む

4 skill は project 限定の `.claude/skills/` にしか入らず、このリポジトリで DB 作業はしないため
実質的に起動しない。グローバルに効かせたいなら `~/.agents/skills/` へ直接インストールするのが
正しい形であり、dotfiles に build パイプラインを残す理由にはならない。却下。

### Option 3: 生成物だけ消してパイプラインを残す

配る中身 (upstream の harness) が無いので、パイプラインを残しても生成できるのは凍結
スナップショットだけ。無意味。却下。

### Option 4: `pr-conflict-resolver` の `scripts/` だけ repo 直下に残す

skill としての配布と、決定的スクリプトの保持は独立した選択肢である。`scripts/*.sh` 5 本
(約 5 ファイル) を `.github/scripts/` 等へ移せば、上記 Negative のうち
「9 エコシステム分岐」「exit code 保持」「push 前チェックリスト」「`loop-escalation:v1`
エスカレーション契約」は保てた。却下理由は **`scan-pr-conflicts.yml` は本リポジトリでしか
使わず、このリポジトリの lockfile は `bun.lockb` 1 種だけ**なので 9 分岐のうち 8 つが
このリポジトリでは死にコードになること、および 5 本のシェルスクリプトを CI 専用に保守する
コストを払わない判断。**ただし他リポジトリでも同じ conflict 解決を回したくなった時点で
この却下は無効になる** — その場合は upstream (`kanade0404/skills`) の feature 枠へ戻すのが筋。

## 再考トリガ

skill を再び使いたくなった場合、または `~/.agents/skills/` グローバル配布の喪失が実害を
もたらした場合 (Codex / OpenCode で同じ手順を毎回手で説明し直している、DB 作業で 4 skill を
探し直した等) は、**dotfiles に build パイプラインを戻すのではなく `~/.agents/skills/` へ
直接インストールする形を先に検討する** (探索パスは上記「Amends ADR 0002 (a)」)。
dotfiles が担うべきは「グローバルに効く置き場所への配置」であって「upstream からの生成」では
ない、というのが本 ADR で学んだ区別である。

### 観測指標

定性的な「毎回手で説明し直している」だけでは判断がぶれるので、Positive で立てた
「起動精度の改善を期待する」の検証と同じ計測を使う:

1. upstream issue #56 と同じ手順で skill 起動を再計測する (`~/.claude/projects/**/*.jsonl` の
   `tool_use.name=="Skill"` の `input.skill` と `<command-name>` を集計)。**今回は subagent の
   sidechain ログも対象に含める** (#56 が 431 ファイルを除外していた点が本 ADR の Context の
   留保になっているため)。
2. 削除前 (33 skill 中 12 が非ゼロ起動 / ゼロ起動 63.6%) と、削除後に残った skill での
   同指標を比較する。残る skill のゼロ起動率が下がっていなければ、Positive の
   「起動精度の改善」は成立しなかったと判断する。
3. あわせて実際の skill listing サイズを測る (削除前の寄与分 22,698 chars に対する実測値)。
   budget 超過が解消していなければ、超過の主因は本決定が扱った生成物ではなかったことになる。

## 数値の導出

本 ADR の量化表現はすべて下記で再導出できる (実行時点: 2026-09-27)。

```bash
# 削除 698 files / 内訳 654 + 31 + 13 / 帰属 667 / tracked 772 -> 75
git diff --diff-filter=D --name-only origin/master..HEAD | wc -l                 # 698
git diff --diff-filter=D --name-only origin/master..HEAD \
  -- .claude/skills .agents/skills .opencode/skills | wc -l                      # 654 (218 x 3)
git diff --diff-filter=D --name-only origin/master..HEAD -- .claude-plugin | wc -l  # 31
# 残り 13 (rulesync config/lock/script, daily cron, .coderabbit.yaml, linear-issue.md 等)
git diff --diff-filter=D --name-only origin/master..HEAD \
  -- . ':!.claude/skills' ':!.agents/skills' ':!.opencode/skills' ':!.claude-plugin'  # 13 行
git ls-tree -r --name-only origin/master | wc -l                                 # 772
git ls-files | wc -l                                                             # 75

# 生成ディレクトリの skill 数 37 (= upstream 33 + planetscale 4)
git ls-tree --name-only origin/master -- .claude/skills/ | wc -l                 # 37

# v1.0.0 bump で消える 504 / 残る 150
git ls-tree -r --name-only origin/master \
  -- .claude/skills/postgres .claude/skills/vitess .claude/skills/mysql .claude/skills/neki \
     .agents/skills/postgres .agents/skills/vitess .agents/skills/mysql .agents/skills/neki \
     .opencode/skills/postgres .opencode/skills/vitess .opencode/skills/mysql .opencode/skills/neki \
  | wc -l                                                                        # 150 -> 654 - 150 = 504

# upstream タグ 12 本と harness 有無 (v1.0.0 だけ index が null = skills なし)
gh api repos/kanade0404/skills/tags --jq '.[] | "\(.name) \(.commit.sha)"'
for t in v0.1.0 v0.2.0 v0.3.0 v0.4.0 v0.5.0 v0.6.0 v0.6.1 v0.7.0 v0.8.0 v0.9.0 v0.10.0 v1.0.0; do
  echo "$t $(gh api "repos/kanade0404/skills/contents?ref=$t" --jq '[.[].name]|index("skills")')"
done

# v0.9.0 の skills/ = 168 blob / 33 skill dir (truncated=false を確認)
gh api 'repos/kanade0404/skills/git/trees/v0.9.0?recursive=1' --jq '.truncated'                                       # false
gh api 'repos/kanade0404/skills/git/trees/v0.9.0?recursive=1' \
  --jq '[.tree[]|select(.type=="blob")|select(.path|startswith("skills/"))]|length'                                   # 168
gh api 'repos/kanade0404/skills/git/trees/v0.9.0?recursive=1' \
  --jq '[.tree[]|select(.type=="tree")|select(.path|test("^skills/[^/]+$"))]|length'                                   # 33

# claude-code-review.yml の pin に code-review skill が存在すること
gh api 'repos/kanade0404/skills/contents/skills/code-review?ref=363138744442c5f1f2b65a2414a4d8ba7e0ac264' --jq '.[].name'

# Linear 運用パラメータがコード側に残っていないこと
# (本 ADR 自身が値を書き残しているので docs/adr は除外する)
git grep -n 'claude:ready' -- . ':!docs/adr'   # 0 件 (exit 1)

# .claude-plugin がローカル marketplace として未登録であること
# (`claude-plugins-official` は別文字列なので、パスとしての `.claude-plugin/` を見る)
git grep -n '\.claude-plugin/' origin/master -- . ':!.claude-plugin'  # .markdownlint-cli2.jsonc の 1 行のみ

# 実機の ~/.agents/skills 等の同居状況 (rmdir が失敗する根拠)
ls -la ~/.agents/skills ~/.config/opencode/skills ~/.claude/skills ~/.codex/skills
readlink ~/.agents/skills/adr-writer   # /Users/kanade0404/work/dotfiles/.agents/skills/adr-writer

# ~/.claude/skills の相対 symlink 2 本が剪定後も壊れないこと (二次的 dangling 無し)
for n in find-skills orca-cli; do
  readlink    ~/.claude/skills/$n   # ../../.agents/skills/<n>
  readlink -f ~/.claude/skills/$n   # /Users/kanade0404/.agents/skills/<n>
  ls -ld      ~/.agents/skills/$n   # drwxr-xr-x = 実ディレクトリ (剪定対象の symlink ではない)
done
```

listing 寄与 22,698 chars、および subagent dispatch 経路の 8/21 (38.1%) 対 9/12 (75.0%) は、
`origin/master` の 37 個の `SKILL.md` を対象にした集計で得た:

- listing 寄与 — 各 `SKILL.md` の frontmatter から `name` と `description` を取り出し、
  `- <name>: <description>` (description は空白正規化) の文字数を 37 skill 分合算した値。
- dispatch 経路 — ある skill 名が、**別の** `SKILL.md` の行のうち
  `subagent|Task ツール|Agent ツール|dispatch` を含む行に現れるかで判定した。
  ゼロ起動 21 skill のうち 8 本、非ゼロ起動 12 skill のうち 9 本が該当した。
