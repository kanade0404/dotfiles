{ pkgs, ... }: {
  # Nix settings — nix-darwin に /etc/nix/nix.conf を管理させる
  # (Determinate Nix を使う場合はこの Mac では `nix.enable = false` に戻すこと)
  nix.enable = true;
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

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

  # Hostname (declaratively managed — sets macOS HostName / LocalHostName / ComputerName)
  networking.hostName = "kanade0404";
  networking.localHostName = "kanade0404";
  networking.computerName = "kanade0404";

  # User
  system.primaryUser = "kanade0404";
  users.users.kanade0404 = {
    name = "kanade0404";
    home = "/Users/kanade0404";
  };

  # Shell
  programs.zsh.enable = true;

  # Nix GC は nix-darwin 側で管理 (必要に応じて nix.gc.* を追加)

  # Import sub-modules
  imports = [
    ./modules/homebrew.nix
    ./modules/services.nix
  ];

  # Used for backwards compatibility
  system.stateVersion = 5;
}
