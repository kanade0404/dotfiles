{ ... }: {
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap"; # Remove formulae/casks not listed here
      upgrade = true;
      # Homebrew 5.1+ requires --force (or --force-cleanup / $HOMEBREW_ASK) for
      # `brew bundle install --cleanup`. nix-darwin (現在の pin) はこのフラグを
      # 付与しないため、非対話で zap させるために明示的に渡す。
      extraFlags = [ "--force" ];
    };

    taps = [
      "ariga/tap"
      "microsoft/apm"
    ];

    # Formulae that stay in Homebrew (not available or problematic in nixpkgs)
    brews = [
      "ariga/tap/atlas"
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
      "docker-desktop" # renamed from "docker"
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
      "vagrant"
      "visual-studio-code"
      "warp"
      "zoom"
    ];
  };
}
