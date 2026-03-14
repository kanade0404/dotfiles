{ pkgs, ... }: {
  # Nix settings (Determinate Nix manages the daemon, so disable nix-darwin's management)
  nix.enable = false;

  # System-level packages (migrated from Homebrew + mise)
  environment.systemPackages = with pkgs; [
    # Core CLI tools
    fd
    ripgrep-all
    jq
    sd
    tree
    wget
    htop
    pv
    nmap

    # Editor
    neovim

    # Fuzzy finder & TUI tools
    fzf
    lazygit
    eza

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
    # squid - not available on aarch64-darwin, kept in Homebrew

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

    # AI
    bun

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

  # User
  system.primaryUser = "kanade0404";
  users.users.kanade0404 = {
    name = "kanade0404";
    home = "/Users/kanade0404";
  };

  # Shell
  programs.zsh.enable = true;

  # Nix GC is managed by Determinate Nix daemon

  # Import sub-modules
  imports = [
    ./modules/homebrew.nix
    ./modules/services.nix
  ];

  # Used for backwards compatibility
  system.stateVersion = 5;
}
