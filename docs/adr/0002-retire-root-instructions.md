# 2. CLAUDE.md を廃止し、root instructions を持たない

Date: 2026-09-23

## Status

Accepted

## Context

- このリポジトリには `CLAUDE.md` (596 行) と `AGENTS.md` (117 行) が併存していた。`AGENTS.md` は `CLAUDE.md` から機械的にコピーされて drift した派生コピーで、冒頭が `guidance to Codex (Codex.ai/code)` という存在しない URL になっており、`##` 見出し単位で **6 節が丸ごと欠落**していた (Claude Code テレメトリ / 危険 git コマンドのガード (rule-matcher) / Codex テレメトリ / herdr hook スクリプト / Orca による hook 自動注入と実体生成方式 / Linear → Claude Code 自走パイプライン)。
- drift は双方向で、`AGENTS.md` にしか無い記述も **少なくとも 6 点**あった (`diff <(git show 5eae1a2:CLAUDE.md) <(git show 5eae1a2:AGENTS.md)` で実測。`5eae1a2` は両ファイルが揃っていた削除直前のコミットで、本 ADR の実測値はすべてこの時点のもの)。`install.sh` のブロック単位で列挙すると:
  - `.codex/rules/` — Codex execpolicy rules。`install.sh` の `# rules: Codex execpolicy command permissions` ブロックに対応する記述が `CLAUDE.md` に 0 件。ただし repo 全体では未文書化ではない — `README.md` に `.codex/` の一行説明 (`Codex user settings, rules, hooks, commands`)、管理方針表の `Codex settings/rules/hooks/commands` 行、`.codex/rules/default.rules` の `prefix_rule()` の説明がある。
  - `.codex/hooks/` — `CLAUDE.md` には配布**先**の `~/.codex/hooks/` しか出てこない。リポジトリ側の `.codex/hooks/` と対応する symlink ブロックは `AGENTS.md` だけが持っていた (ただし `.codex/hooks/lib/` はどちらのファイルにも記載が無く、`install.sh` の symlink ブロックにしか現れない)。
  - `.codex/commands/` — `install.sh` の `$DOTFILES/.codex/commands` symlink ブロックに対応する記述が `CLAUDE.md` に 0 件。これも `README.md` の上記 2 箇所で被覆されている。
  - `.opencode/skills/` — OpenCode 対応全体 (`install.sh` の `~/.config/opencode/skills` への symlink ブロック)。`CLAUDE.md` に 0 件で、`README.md` にも記載が無い (`git grep -i opencode` で確認) — 上記 3 つと違い README では被覆されない唯一のもの。ただし repo 内で未文書化というわけではなく、用途 (opencode が `~/.config/opencode/` を global config として読む)・探索パス・symlink 方針は `install.sh:427-431` のインラインコメントにある。
  - 管理方針表の Codex 行 3 つ — `Codex設定` (rationale: 「Codex のローカル状態書き戻しを repo に入れない」)、`Codex skills`、`OpenCode skills`。`CLAUDE.md` の管理方針表には Codex 行自体が無い。
  - Where to Edit 表の `Codex設定/rules/hooks/commands` 行と `OpenCode skills` 行。
- `.codex/environments/environment.toml` は実在して git 管理下にあるが、`CLAUDE.md` / `AGENTS.md` の**どちらにも記載が無かった**。どちらを残しても文書化されない対象だったので、本 ADR の得失には影響しない。
- Claude Code は v2.1.277 (2026-09-18) から `AGENTS.md` を読むが、`CLAUDE.md` が存在しない場合のフォールバックとしてのみで、両者をマージはしない (出典: <https://code.claude.com/docs/en/changelog> — changelog のインデックス URL であり、該当エントリへの安定した直リンクは存在しない)。ただし下記 Decision により `AGENTS.md` は指示を持たないまま保たれるため、**この挙動の正確さに本 ADR の結論は依存しない** — 読まれても読まれなくても注入される指示が無い。
- 配布元リポジトリ `kanade0404/skills` の **ADR 0018「rule を廃止し、指示は skill か決定論的ハーネスに限定する」** (PR #143、2026-09-20 merge) が、常時ロードされる助言的指示の廃止を決定している。論拠は (1) rule は助言であって強制ではない (2) rules feature は Claude Code にしか届かず Codex には対応機構が無い (3) path-scoped rule の注入は読み取り tool の種類に依存する、の 3 点。
- 同リポジトリ issue #56 の実測 — 67 セッション・24,131 行の走査で **33 skill 中 21 (63.6%) がゼロ起動**。`tdd` / `tidy-first` / `test-review` のように `CLAUDE.md` に「必ず起動」と明記した中核 skill がゼロ起動だった。ただし issue #56 本文は「呼び出しがそもそも発生していないのか、Skill tool / `<command-name>` 以外の経路 (説明文の直接遂行など) で計測から漏れているのかは本実験の範囲では切り分け不能」と明記して留保している。したがってこの実測が支持するのは「**Skill tool 経由の起動が 0 だった**」ことであり、「root instructions に書いても行動が変わらない」ことではない。本 ADR はこれを「root instructions に『必ず起動』と書けば skill が起動する、という想定の反証」としてのみ扱い、指示が行動全般に与える影響については主張しない。
- `CLAUDE.md` 596 行の内容は「エージェントへの指示」(日本語で応答する指示、コミット規約 — `.gitmessage` と重複) と「設計記録・rationale」が混在していた。

## Decision

- `CLAUDE.md` を削除する。
- `AGENTS.md` は**指示を持たない追跡ファイルとして残す**。project instructions を意図的に持たないことの意思表示であり、それ以上の機能的役割は主張しない。内容は本 ADR を指す HTML コメント 1 行のみとし、エージェントへの指示は一切書かない。
- 596 行の内容は `README.md` や `docs/` へ移さず**破棄する**。git 履歴が唯一の記録となる。

## Consequences

### Positive

- 毎セッションの context 消費が消える。
- 双方向 drift していた二重管理が構造的に消える。
- 配布元の ADR 0018 の方針と整合する。
- ADR 0018 の「指示と rationale はコード近傍へ」は、主要部分について**既に達成済み**であることが本 ADR の作成時に確認できた。`install_managed_file` / `backup_local_settings` / `retain_codex_config_backup` / signal trap の規律は `install.sh` のインラインコメントに、`rule-matcher` の `alwaysDangerous` と `dangerousWhenRedirected` の区別・`commit` を意図的に対象外にした理由・denylist が網羅でない旨は `.claude/hooks/lib/rule-matcher.ts` のコメントに、herdr の版数別ゲート条件表 (Claude v10 / Codex v8) は本 PR 自身が `scripts/codex-otel.test.ts` の pin 直上コメントに、それぞれ存在する。つまり削除される 596 行のうち、これらは重複であって喪失ではない。
- Claude Code のバージョン依存 (v2.1.277 未満で無言に読まれない問題) と Bedrock / Vertex / Foundry 非対応の制約が moot になる — 読むべき内容が無いため。

### Negative

- **設計記録が失われる。** 以下は `git show 5eae1a2:CLAUDE.md` でのみ参照可能になるものの**代表例であり、網羅ではない**。上記 Positive のとおりコード近傍に複製が存在するものは意図的に除いてあり、ここに挙げるのは**コード側に対応するコメントが無いことを確認したもの**に限る:
  - OTEL helper (`otelHeadersHelper`) の trust boundary 議論 — origin URL 照合が能動的な攻撃者を止めないという残余リスクの説明。ラッパー式が書かれている `.claude/settings.json` は JSON なので同一ファイルにはコメントを置けない。helper 実体の `.claude/hooks/otel-headers.sh` はシェルスクリプトなので置く経路自体はあるが、本 PR では採らなかった (Option 3 を再検討する際、この 1 点は `docs/` ではなく `otel-headers.sh` へ置く方が ADR 0018 と整合する)
  - rule-matcher の既知の穴 — `sh -c` / `zsh -c` ラッパー経由ではガードが一切効かない点 (#177) と、対象リポジトリ側の repo-local config (`core.pager` / `core.fsmonitor` / `core.hooksPath`) が静的解析の射程外である点。どちらも `rule-matcher.ts` のコメントには無い (同ファイルにある他の設計意図とは対照的)
  - Codex OTEL の token rotation 手順 (`--write-config-only` の再実行)。Keychain service 名の解決順は `.local/bin/codex-otel:400` の `for service in codex-otel claude-code-otel` 自体が解決順なので喪失に数えない
  - Linear → Claude Code 自走パイプラインの **`/schedule` 登録手順の要約**のみ。routine secrets・ラベル状態遷移・ループ上限は `.claude/skills/linear-issue-driven-development/SKILL.md` と `.claude/commands/linear-issue.md` に本体として存続する
  - Orca の hook 注入とレース条件 (`model` 脱落) の説明 — `install.sh` に対応する説明が無い
  - flake の `darwinConfigurations` attribute をホスト名と揃えてあるので適用時に attribute 指定が不要である旨 (`nix/README.md` に `darwinConfigurations` / `hostName` の言及が無い)。他の Nix-specific Notes と Architecture / Where to Edit の地図は喪失に数えない — `nix.enable` と Determinate Nix の注記は `nix/configuration.nix:3`、`cleanup = "zap"` は `nix/modules/homebrew.nix:6` と `nix/README.md:150`、構成の地図と適用コマンドは `README.md` の構成ツリーと管理方針表がそれぞれ担う
  - herdr の `CURSOR_VERSION` 誤爆 (#242) と Codex 側 `transcript_path` の常在性が未検証である旨 — ゲート条件表そのものはテストへ移設済みだが、この 2 つの未解決の懸念は移設先に書いていない
  - 上記の `AGENTS.md` 固有 6 点は、いずれも**喪失には数えない**。`.codex/rules/` / `.codex/hooks/` / `.codex/commands/` / 管理方針表の Codex 行 / Where to Edit 表の Codex 行は `README.md` に相当する記述があり、`.opencode/skills/` は `README.md` にこそ無いが `install.sh:427-431` のインラインコメントが用途・探索パス・symlink 方針を持つ
- **観測可能な挙動変化が 1 つある**: 旧 `CLAUDE.md:5` / 旧 `AGENTS.md:5` の「日本語で必ず応答してください。」が repo から消え、既定の応答言語がモデル任せになる (repo 内に代替は無いことを `git grep` で確認済み)。受容する。必要なら user-level (`~/.claude/CLAUDE.md` 等、repo 外) で供給する。
- 実務上のリスクは「**理由を知らない将来の読み手に冗長と見えて削られやすいコード**」が残ること。ただし `install_managed_file` 内の `install ... || return 1`・dest=directory ガード・`retain_codex_config_backup` の errexit 抑止のように、理由を知らなければ不要に見える代表例は `install.sh` のインラインコメントで理由が保持されているため、このリスクは本 ADR では**残余リスクに留まる**。実際に危険なのは、上記 Negative のとおりコード近傍に説明が無い箇所 (rule-matcher の既知の穴、`.claude/settings.json` の `otelHeadersHelper` ラッパー式) の方である。
- `.gitignore` が global な `core.excludesFile` であるという運用禁則 (「dotfiles 固有のファイルを ignore する目的でここにパターンを足さない」) は、本 ADR と同時に **`.gitignore` 冒頭のコメントと `nix/home.nix` の相互参照コメントへ移設した**ため喪失しない。`install.sh` が `~/.gitignore` へ symlink し `home.nix` が `core.excludesFile` に設定する以上、この禁則はコード近傍に置くべきもの (ADR 0018 の趣旨) だったため、破棄ではなく移設を選んだ。
- 人間向けの入口ドキュメントが `README.md` のみになる (内容の十分性は未検証)。

## Alternatives Considered (rejected)

### Option 1: 596 行を AGENTS.md へ移す

二重管理は解消できるが、ADR 0018 が廃止しようとしている「常時ロードされる助言」をそのまま温存する。却下。

### Option 2: symlink で併存 (`AGENTS.md` ↔ `CLAUDE.md`)

どちらの向きでもファイルは減らず、Option 1 と同じ問題を残す。却下。

### Option 3: `README.md` + `docs/` へ移設する

知識を保ちながら context 消費を消せる、最も情報損失の少ない案。**却下理由は移設作業と以後の保守コストを払わない判断**であり、設計記録の喪失を明示的に受容した。

### Option 4: 現状維持 (両方を手で保守)

双方向に drift した実績があるため却下。

## 再考トリガ

設計記録の喪失が実害をもたらした場合 — 同じ罠を踏み直した、`install.sh` のガードが理由不明のまま削られた、`rule-matcher` の既知の穴を再発見し直した等 — は Option 3 (`docs/` への移設) を再検討する。
