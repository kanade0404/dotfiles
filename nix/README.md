# Nix リファレンスガイド

## ファイル構成

```
nix/
├── flake.nix            # エントリポイント。inputs (nixpkgs, nix-darwin, home-manager) を定義
├── flake.lock           # 依存バージョンのロックファイル (自動生成)
├── configuration.nix    # システムレベル設定 (CLI パッケージ、ロケール、ユーザー)
├── home.nix             # ユーザーレベル設定 (zsh, git, starship, tmux 等の dotfiles)
└── modules/
    ├── homebrew.nix     # Homebrew cask/formula の宣言管理
    └── services.nix     # launchd サービス定義
```

| ファイル | 何を変更するときに編集するか |
|---|---|
| `configuration.nix` | CLI ツールの追加/削除、システム設定の変更 |
| `home.nix` | zsh, git, starship 等の設定変更、シェルエイリアス追加 |
| `modules/homebrew.nix` | GUI アプリ (cask) や Homebrew 限定パッケージの追加/削除 |
| `flake.nix` | 新しい flake input の追加 (通常は触らない) |

---

## よく使うコマンド

### 設定の適用

```bash
# 設定を変更した後に実行 (sudo 必要)
sudo darwin-rebuild switch --flake ~/work/dotfiles/nix
```

### パッケージ検索

```bash
# nixpkgs からパッケージを検索
nix search nixpkgs <キーワード>

# 例: ripgrep を検索
nix search nixpkgs ripgrep
```

### 一時的にパッケージを使う (インストールせずに)

```bash
# nix shell: 一時的にパッケージを PATH に追加
nix shell nixpkgs#cowsay
cowsay "Hello"
# シェルを抜けると消える

# nix run: コマンドを1回だけ実行
nix run nixpkgs#cowsay -- "Hello"
```

### Nix ストアの管理

```bash
# ガベージコレクション (古いバージョンを削除)
nix-collect-garbage -d

# 特定日数より古いものだけ削除
nix-collect-garbage --delete-older-than 30d

# ストアの使用量を確認
du -sh /nix/store
```

### 世代管理

```bash
# 現在の世代一覧
darwin-rebuild --list-generations

# 前の世代にロールバック (問題が起きたとき)
sudo darwin-rebuild switch --rollback
```

---

## パッケージ管理

### CLI ツールの追加

1. `nix search nixpkgs <名前>` でパッケージ名を確認
2. `configuration.nix` の `environment.systemPackages` に追加
3. `sudo darwin-rebuild switch --flake ~/work/dotfiles/nix`

```nix
# configuration.nix
environment.systemPackages = with pkgs; [
  # 既存のパッケージ...
  neofetch  # ← 追加
];
```

### CLI ツールの削除

1. `configuration.nix` から該当行を削除
2. `sudo darwin-rebuild switch --flake ~/work/dotfiles/nix`

### ユーザーレベルのパッケージ追加

`home.nix` の `home.packages` に追加:

```nix
# home.nix
home.packages = with pkgs; [
  rustup
  neofetch  # ← 追加
];
```

> **systemPackages vs home.packages**: どちらでも動作するが、開発ツールは `systemPackages`、個人用ツールは `home.packages` に入れるのが慣習。

---

## Homebrew 管理

GUI アプリと nixpkgs に無いパッケージは `modules/homebrew.nix` で管理。

### cask の追加

```nix
# modules/homebrew.nix
casks = [
  # 既存の cask...
  "figma"  # ← 追加
];
```

### brew formula の追加

```nix
brews = [
  # 既存の formula...
  "新しいパッケージ"  # ← 追加
];
```

### tap の追加

```nix
taps = [
  "ariga/tap"
  "新しい/tap"  # ← 追加
];
```

> `homebrew.onActivation.cleanup = "zap"` により、**リストに無いパッケージは自動削除**される。手動で `brew install` したものも次の `darwin-rebuild switch` で消える。

---

## mise との使い分け

| 管理ツール | 対象 | 理由 |
|---|---|---|
| **Nix** | bat, fd, jq, git, ansible 等の CLI ツール全般 | バージョン固定不要、システム全体で共通 |
| **mise** | Node.js, Neovim, claude-code, qwen-code | プロジェクト毎のバージョン切替が必要 |
| **Homebrew** | GUI アプリ (cask), php, rbenv, atlas, squid | nixpkgs で macOS 非対応 or cask のみ |

mise の設定: `~/.config/mise/config.toml`

```toml
[tools]
node = "latest"
neovim = "latest"
"npm:@anthropic-ai/claude-code" = "latest"
"npm:@qwen-code/qwen-code" = "latest"
```

---

## home-manager 設定変更

### zsh エイリアスの追加

```nix
# home.nix → programs.zsh.shellAliases
shellAliases = {
  gs = "git status";
  # 新しいエイリアス ← 追加
  ll = "ls -la";
};
```

### zsh の初期化スクリプト変更

```nix
# home.nix → programs.zsh.initContent
initContent = ''
  # ここにシェル初期化コードを記述
  export MY_VAR="value"
'';
```

### git 設定の変更

```nix
# home.nix → programs.git.settings
settings = {
  user = {
    name = "kanade0404";
    email = "melty0404@gmail.com";
  };
  # 新しい設定を追加
  rerere.enabled = true;
};
```

### starship / tmux の設定

```nix
# home.nix
programs.starship = {
  enable = true;
  settings = {
    # starship.toml の内容を Nix attrset で記述
    character.success_symbol = "[>](bold green)";
  };
};

programs.tmux = {
  enable = true;
  keyMode = "vi";
  baseIndex = 1;
};
```

---

## アップデート

### 全 flake inputs を最新に更新

```bash
cd ~/work/dotfiles/nix
nix flake update
sudo darwin-rebuild switch --flake .
```

### 特定の input だけ更新

```bash
# nixpkgs だけ更新
nix flake update nixpkgs

# home-manager だけ更新
nix flake update home-manager
```

### 更新を元に戻す

```bash
# flake.lock を git で戻す
git -C ~/work/dotfiles checkout nix/flake.lock
sudo darwin-rebuild switch --flake ~/work/dotfiles/nix
```

---

## トラブルシューティング

### `darwin-rebuild switch` がエラー

```bash
# 詳細なスタックトレースを表示
sudo darwin-rebuild switch --flake ~/work/dotfiles/nix --show-trace
```

### パッケージが見つからない

```bash
# 正確なパッケージ名を検索
nix search nixpkgs <名前>

# パッケージの詳細情報
nix eval nixpkgs#<パッケージ名>.meta.description
```

### aarch64-darwin 非対応エラー

`Package 'xxx' is not available on aarch64-darwin` → nixpkgs でそのパッケージは macOS 非対応。`modules/homebrew.nix` の `brews` に追加して Homebrew で管理する。

### `/etc/xxx` のファイル衝突

```
Unexpected files in /etc, aborting activation
```

→ 指示通りリネームする:

```bash
sudo mv /etc/<ファイル名> /etc/<ファイル名>.before-nix-darwin
```

### home-manager のファイル衝突

```
Existing file '/Users/kanade0404/.xxx' would be clobbered
```

→ 既存ファイルを手動で削除またはリネームしてから再実行。`flake.nix` の `home-manager.backupFileExtension` で自動バックアップも可能 (現在 `"backup"` に設定済)。

### ロールバック

```bash
# 前の世代に戻す
sudo darwin-rebuild switch --rollback

# 特定の世代に戻す
darwin-rebuild --list-generations
sudo darwin-rebuild switch --switch-generation <番号>
```

---

## Nix 言語チートシート

### 基本型

```nix
# 文字列
"hello"
''
  複数行文字列
''

# 数値
42

# 真偽値
true
false

# null
null

# リスト
[ "a" "b" "c" ]

# Attribute Set (辞書 / オブジェクト)
{ key = "value"; nested.key = "value2"; }
```

### with 式

```nix
# with を使うと prefix を省略できる
environment.systemPackages = with pkgs; [
  bat    # pkgs.bat と同じ
  fd     # pkgs.fd と同じ
];
```

### let-in 式

```nix
# ローカル変数を定義
let
  myName = "kanade0404";
  myHome = "/Users/${myName}";
in {
  home.homeDirectory = myHome;
}
```

### import

```nix
# 別ファイルを読み込む
imports = [
  ./modules/homebrew.nix
  ./modules/services.nix
];
```

### 関数

```nix
# Nix のファイルは基本的に関数
# { pkgs, ... }: はこのファイルが pkgs を引数に取る関数であることを示す
{ pkgs, ... }: {
  environment.systemPackages = [ pkgs.bat ];
}
```

### 条件分岐

```nix
# if-then-else
environment.systemPackages = with pkgs; [
  bat
] ++ (if pkgs.stdenv.isDarwin then [ mas ] else []);
```

### 文字列補間

```nix
# ${} で変数を展開
let version = "14"; in
"postgresql_${version}"  # → "postgresql_14"
```

---

## プロジェクト毎の開発環境 (将来)

mise の代わりに Nix flake でプロジェクト固有のツールチェーンを定義可能:

```nix
# プロジェクトの flake.nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { nixpkgs, ... }:
    let pkgs = nixpkgs.legacyPackages.aarch64-darwin; in {
      devShells.aarch64-darwin.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_20 pkgs.pnpm ];
      };
    };
}
```

```bash
# プロジェクトの .envrc
use flake
```

`direnv` + `nix-direnv` (home-manager で設定済) により、ディレクトリに入ると自動で環境が有効になる。
