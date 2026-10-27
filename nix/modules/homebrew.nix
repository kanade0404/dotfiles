{ ... }: {
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap"; # Remove formulae/casks not listed here
      upgrade = true;
      # Homebrew 5.1.15+ では `brew bundle install --cleanup` の cleanup 実行に
      # --force-cleanup / --force / $HOMEBREW_ASK のいずれかが必須。--force は
      # install/upgrade 側も --overwrite 動作になり危険なため、cleanup の確認回避
      # だけを目的に --force-cleanup を使う。
      # 新しい nix-darwin は cleanup = "uninstall" / "zap" で同じフラグを自動付与するが、
      # 付与条件が将来変わっても cleanup が静かに効かなくなるのを防ぐため、明示指定を
      # 残している (boolean switch なので重複しても無害)。付与状況は `darwin-rebuild build`
      # 後に `grep -o -- '--force-cleanup' result/activate` で確認できる。
      extraFlags = [ "--force-cleanup" ];
    };

    taps = [
      { name = "ariga/tap"; trusted = true; }
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
