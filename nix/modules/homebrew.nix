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
      # 無関係の第三者だが、この tap が macOS 向けの唯一の公式配布経路で、アプリ自身の
      # updater も `brew upgrade --cask` を叩く前提になっている。アプリを入れる時点で
      # 同じ作者のコードを実行するので、tap を trusted にしても信頼する相手は増えない。
      # 作者を信頼できなくなったら tap ごと外す (cask の vendoring では解決しない)。
      { name = "penso/tap"; trusted = true; }
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
      # Native GUI client for the herdr daemon。daemon (brews の "herdr", homebrew-core) とは
      # 配布元もリリース周期も別で、cask に daemon のバージョン制約 (depends_on) は無い。
      # upgrade = true で片方だけ上がりうるので、GUI が daemon に繋がらなくなったら
      # まず `herdr --version` と GUI のバージョンの組み合わせを疑う。
      "penso/tap/herdr-gpui"
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
