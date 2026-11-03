{ ... }: {
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap"; # Remove formulae/casks not listed here
      upgrade = true;
      # Homebrew 5.1.15+ では `brew bundle install --cleanup` の cleanup 実行に
      # --force-cleanup / --force / $HOMEBREW_ASK のいずれかが必須 ($HOMEBREW_ASK は
      # install/upgrade にも確認プロンプトを挟むため activation 用途に向かない)。--force は
      # install/upgrade 側も --overwrite 動作になり危険なため、cleanup の確認回避
      # だけを目的に --force-cleanup を使う。
      # 新しい nix-darwin は cleanup = "uninstall" / "zap" で同じフラグを自動付与するが、
      # 付与条件が将来変わっても darwin-rebuild の cleanup が失敗しないよう、明示指定を
      # 残している (boolean switch なので重複しても無害)。逆に Homebrew 側がこのフラグを
      # 廃止すると `brew bundle` が invalid option で失敗する。その場合は nix-darwin 側の
      # 自動付与も同じく失敗するため、ここを外すだけでは直らず nix-darwin の更新が必要。
      # 実際に付与されるコマンドラインは `darwin-rebuild build` 後に
      # `grep -n 'brew bundle' result/activate` で確認できる。nix-darwin の自動付与が
      # 生きているかは `grep -o -- '--force-cleanup' result/activate | wc -l` が
      # 2 (自動 + 明示) かで判別する。
      extraFlags = [ "--force-cleanup" ];
    };

    taps = [
      { name = "ariga/tap"; trusted = true; }
      # Herdr UI (herdr-gpui) の作者 Fabien Penso の個人 tap。herdr 本体 (herdrdev) とは
      # 無関係の第三者なので、tap 全体は信頼せず、casks 側で herdr-gpui だけを trusted に
      # する (Homebrew は trust.json に cask 単位で記録するので、アプリ内 updater の
      # `brew upgrade --cask herdr-gpui` もこの trust で通る)。
      "penso/tap"
    ];

    # Formulae that stay in Homebrew (not available or problematic in nixpkgs)
    brews = [
      "ariga/tap/atlas"
      "herdr" # Agent multiplexer for the terminal (not in nixpkgs)
      "php"
      "rbenv"
      "ruby-build"
      "squid" # not available on aarch64-darwin in nixpkgs
    ];

    # All GUI applications (casks)
    casks = [
      "1password"
      "discord"
      "dropbox"
      "firefox"
      "font-fira-code"
      "font-fira-code-nerd-font"
      "google-chrome"
      "gyazo"
      "karabiner-elements"
      "mactex-no-gui"
      "notion"
      "obsidian"
      "orbstack"
      # herdr daemon のネイティブ GUI クライアント (Herdr UI)。
      # 信頼: trusted はこの cask だけ。ただし autoUpdate で tap の HEAD (commit 固定なし) の
      # Ruby コードを評価するので、署名・公証済み DMG を手動で入れる場合と違い、tap への
      # push 権限が奪われると次の rebuild でコードが実行されうる。nix-homebrew の
      # mutableTaps = false で tap を flake.lock に固定すればこれは防げるが、Homebrew の
      # 管理方式ごと移行することになるので、今回は採らずにこのリスクを受け入れる。
      # 更新: daemon (brews の "herdr", homebrew-core) とは配布元もリリース周期も別で、
      # cask に daemon のバージョン制約 (depends_on) は無い。2026-11 時点の cask は
      # auto_updates を宣言していないので upgrade = true で GUI も上がる (宣言されると
      # --greedy なしでは上がらなくなる。確認は
      # `brew info --cask --json=v2 penso/tap/herdr-gpui | jq '.casks[0].auto_updates'`)。
      # GUI が daemon に繋がらなくなったら、まず `herdr --version` と GUI のバージョンの
      # 組み合わせを疑う。アプリ内 updater も `brew upgrade --cask` を実行するが、ここでは
      # cask 名だけを宣言してバージョンを pin していないので、darwin-rebuild の宣言とは
      # 食い違わない。
      { name = "penso/tap/herdr-gpui"; trusted = true; }
      "postman"
      "raycast"
      "secretive"
      "slack"
      "spotify"
      "temurin@21"
      "the-unarchiver"
      "utm"
      "visual-studio-code"
      "warp"
      "zoom"
    ];
  };
}
