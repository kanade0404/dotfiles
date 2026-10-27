{ ... }: {
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap"; # Remove formulae/casks not listed here
      upgrade = true;
      # Homebrew 5.1+ では `brew bundle install --cleanup` の cleanup 実行に
      # --force-cleanup / --force / $HOMEBREW_ASK のいずれかが必須。--force は
      # install/upgrade 側も --overwrite 動作になり危険なため、cleanup の確認回避
      # だけを目的に --force-cleanup を使う。
      # 新しい nix-darwin は cleanup = "zap" で同じフラグを自動付与するが、付与条件が
      # 将来変わっても cleanup が静かに効かなくなるのを防ぐため、明示指定を残している
      # (boolean switch なので重複しても無害)。
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
