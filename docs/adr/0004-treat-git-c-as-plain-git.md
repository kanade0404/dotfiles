# 4. `git -C <dir> <sub>` を `git <sub>` と同じ扱いにし、対象ディレクトリ・クォートした変数参照・git だけの複合コマンドを理由に止めない

Date: 2026-11-01

## Status

Accepted

Supersedes [3. git -C の許可判定を hook の正規化に一本化し、Claude Code でのみ hook が allow を返す](0003-normalize-git-c-in-hook.md)

ADR 0003 の決定のうち、本 ADR の Decision で変えたもの以外はそのまま引き継ぐ。

## Context

- ユーザの要望は「`git -C` は止めなくていい」である。`-C` があることだけを理由に、hook の ask や本体の確認を出さないようにしたい。正規化後の `git <sub>` に対する deny / ask (危険な git フラグ・機密パスを含む) は従来どおり効かせる。
- 実際に止まった例は、別リポジトリへの `R=...; git -C $R diff --stat` を含む複合コマンドだった。
- ADR 0003 では、`-C` だけが原因で確認の出る経路が 3 つあった。`-C` の引数に `$` があると一律に ask にしていたこと、hook allow を cwd と同じリポジトリに限っていたこと、hook allow を単一のコマンドに限っていたことである。
- ユーザ設定の `defaultMode` は `auto` で、hook が allow を返すのは `default` / `acceptEdits` のときだけである。auto mode で効くのは ask の扱いだけになる。
- settings.json に `Bash(git -C *)` を置く案は、ADR 0003 と同じ理由で採らない。プレフィックス一致はサブコマンド位置に anchor されず、hook の動かない環境では `-C` 版の deny がすべて外れる。
- シェルの変数展開の性質 (zsh 5.9 で確かめた)
  - クォートしない参照は、値が空なら語ごと消える。bash は値を IFS で単語分割し、zsh は配列の参照を要素ごとに別の語にする。zsh の修飾子 (`$R:e`) は値を変える。
  - ダブルクォートした参照 (`"$R"`) は、値がどうであれ 1 語のままである。
- `git -C <dir>` は `<dir>` のリポジトリの `.git/config` と `.git/hooks` を読み込む。

## Decision

- `-C` の対象ディレクトリは判定に使わない。同一リポジトリに限る条件は削除する。
- `-C` の引数がダブルクォートした変数参照 1 個 (`"$R"` / `"${R}"`) なら、リテラルの dir と同じく正規化する。
- クォートしない変数参照 (`$R`) は、代入の有無を問わず ask にする。ask の前に、正規化した形と値が空で語が消えた形で deny を照合する。展開後の語数を文字列から静的に決められないためである。条件付きで正規化する規則を 3 回作り直したが、そのたびに抜け道が見つかり収束しなかった (Option D)。修飾子・添字・連結・既定値付きなど、ほかの展開を含む形も ask にする。
- hook が allow を返すのは、コマンド全体が `git -C` を含み、`git -C` と `-C` の無い git だけを `;` / `&&` / `||` / `|` で繋いだ単純な正の文法と一致する場合だけである。全セグメントが deny / ask に当たらず、ユーザ設定のサブコマンドを固定した allow に一致する必要がある。
  - git 以外のセグメントは hook allow の対象にしない。`uniq` や `sort -o` のように、ファイルを書けるコマンドを確認無しに通さないためである。
  - 代入とクォートしない変数参照は文法外にする。代入は export 済みの変数を書き換え、後のセグメントや git 自身の動作を変えうる。
  - deny と機密パスの照合はクォートの中を見ないので、クォートを外した形でも照合する。
- 付け替え時だけ危険とする git の操作 (`clean`、`worktree`、`config` など) は、付け替え先のリポジトリへの破壊的な操作や設定の書き込みを防ぐためのもので、読み取り系も含めて従来どおり deny にする。
- `nix/home.nix` で `safe.bareRepository = "explicit"` を設定する。
- ADR 0003 の決定のうち、上で変えたもの以外は維持する。settings.json に `-C` 版ルールを置かないこと、Claude Code の `default` / `acceptEdits` でだけ allow を返すこと、allow の根拠をユーザ設定に限ることなどである。

## Consequences

### Positive

- `git -C <dir> <sub>` と `git -C "$R" <sub>` は、`-C` を理由に止まらない。`default` / `acceptEdits` では、別リポジトリへの `git -C` や git だけの複合コマンドも確認無しに通る。
- 正規化後の deny / ask は従来どおり効く。

### Negative

- 別リポジトリの `.git/config` と `.git/hooks` が確認無しに実行されうる。経路は、エージェントが書いたリポジトリ、clone した作業ツリーに埋め込まれた bare リポジトリ、アーカイブを展開したディレクトリの 3 つである。`safe.bareRepository` で塞げるのは 2 つ目だけで、home-manager を適用したホストでしか効かない。対象リポジトリの config を検査する案は、このトレードオフを受け入れたので採らない。
- `acceptEdits` で `.git/config` を書いてから git を実行させる経路は、`-C` が無くても成り立つので、本 ADR の対象外とする。
- クォートしない `-C $R` は、代入があっても ask になる。ask を避けるには `"$R"` とクォートする。
- 付け替え時に deny とする git の操作には、`worktree list` や `config --get` のような読み取りも含まれる。
- 複合コマンドの文法は、zsh と bash で実際に実行する検証をしていない。
- `safe.bareRepository = "explicit"` の下では、bare リポジトリの中で直接 git を実行できない (`--git-dir` の指定が要る)。git 2.54.0 と nix 2.34.9 で、bare clone と worktree の運用と nix の fetch を確かめた。Go の VCS キャッシュ (`GOPROXY=direct`) と cargo の `git-fetch-with-cli` は確かめていない。壊れる場合は、そのディレクトリだけ `includeIf` で `safe.bareRepository = all` にする。

## Alternatives Considered

### Option A: settings.json に `Bash(git -C *)` の allow を置く

- 却下理由: hook が動かない環境で `-C` 版の deny がすべて外れ、未知のサブコマンドも本体が自動許可する。

### Option B: shell-parser で分解したセグメントが全て allow なら hook allow する

- 却下理由: 部分的なシェルのモデルで危険な形を除く方式は、ADR 0003 のとおり漏れが続いた。

### Option C: 同一リポジトリの制限を残す

- 却下理由: ユーザの要望は別リポジトリへの `git -C` も止めないことである。

### Option D: クォートしない `$R` を条件付きで正規化する

- 却下理由: 同じコマンド内の代入、配列を作る構文の列挙、閉じた文法と、条件を 3 回作り直したが、そのたびに抜け道 (zsh の配列や修飾子、glob で組み立てる名前、`printf -vIFS` による語分割など) が見つかった。語数はシェルの状態で変わり、文字列だけでは決められない。

### Option E: git 以外のセグメントも、ユーザ設定の allow があれば hook allow する

- 却下理由: ファイルを書けるコマンド (`uniq`、`sort -o`、`mkdir` など) が、本体の検査を経ずに通る。
