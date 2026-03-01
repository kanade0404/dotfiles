{ pkgs, ... }: {
  # Nix settings
  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
    };
  };

  # System-level packages (migrated from Homebrew + mise)
  environment.systemPackages = with pkgs; [
    # Core CLI tools
    bat
    fd
    ripgrep-all
    jq
    sd
    tree
    wget
    htop
    pv
    nmap

    # Git ecosystem
    git
    gitui
    delta
    gh
    lefthook

    # Development tools
    ansible
    automake
    awscli2
    bison
    doxygen
    dprint
    pandoc
    plantuml
    sqlc

    # Networking
    cloudflared
    httpie
    iperf3
    inetutils # telnet
    tcptraceroute
    wrk
    squid

    # Database
    mysql80
    postgresql_14

    # Python ecosystem
    uv
    poetry
    python3Packages.virtualenv
    python3Packages.docutils

    # Shell & terminal
    starship
    tmux
    zoxide
    zsh-history-substring-search

    # Security & crypto
    gnupg
    oath-toolkit

    # Other tools
    ghq
    gifsicle
    mas
    scrcpy
    direnv
  ];

  # Locale
  environment.variables = {
    LANG = "ja_JP.UTF-8";
    LC_ALL = "ja_JP.UTF-8";
  };

  # Shell
  programs.zsh.enable = true;

  # Nix GC
  nix.gc = {
    automatic = true;
    interval = { Weekday = 0; Hour = 3; Minute = 15; };
    options = "--delete-older-than 30d";
  };

  # Import sub-modules
  imports = [
    ./modules/homebrew.nix
    ./modules/services.nix
  ];

  # Used for backwards compatibility
  system.stateVersion = 5;
}
