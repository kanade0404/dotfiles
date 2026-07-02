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
      # だけを目的に --force-cleanup を使う (nix-darwin の現 pin は付与しないため明示)。
      extraFlags = [ "--force-cleanup" ];
    };

    taps = [
      "ariga/tap"
      "microsoft/apm"
    ];

    # Formulae that stay in Homebrew (not available or problematic in nixpkgs)
    brews = [
      "ariga/tap/atlas"
      "herdr" # Agent multiplexer for the terminal (not in nixpkgs)
      "microsoft/apm/apm" # Agent Package Manager (not in nixpkgs)
      "php"
      "rbenv"
      "ruby-build"
      "squid" # not available on aarch64-darwin in nixpkgs
    ];

    # All GUI applications (casks)
    casks = [
      "1password"
      "chromedriver"
      "chromium"
      "discord"
      "dropbox"
      "firefox"
      "font-fira-code"
      "font-fira-code-nerd-font"
      "gimp"
      "google-chrome"
      "gyazo"
      "handbrake-app" # renamed from "handbrake"
      "jetbrains-toolbox"
      "karabiner-elements"
      "licecap"
      "mactex-no-gui"
      "notion"
      "obsidian"
      "orbstack"
      "postman"
      "raycast"
      "secretive"
      "slack"
      "spotify"
      "sublime-text"
      "temurin@21"
      "the-unarchiver"
      "transmit"
      "tunnelblick"
      "utm"
      "visual-studio-code"
      "warp"
      "zoom"
    ];
  };
}
