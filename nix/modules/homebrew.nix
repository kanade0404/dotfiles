{ ... }: {
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap"; # Remove formulae/casks not listed here
      upgrade = true;
    };

    taps = [
      "ariga/tap"
    ];

    # Formulae that stay in Homebrew (not available or problematic in nixpkgs)
    brews = [
      "ariga/tap/atlas"
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
      "docker"
      "dropbox"
      "firefox"
      "font-fira-code"
      "font-fira-code-nerd-font"
      "gimp"
      "google-chrome"
      "gyazo"
      "handbrake"
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
      "testcontainers-desktop"
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
