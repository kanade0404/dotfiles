{ pkgs, ... }: {
  # Nix settings (nix.enable / experimental-features) は host 固有のため
  # flake.nix の mkDarwin が per-host に注入する。Determinate Nix 入りの
  # マシン (kanade0404-air) では nix.enable = false になる。詳細は flake.nix を参照。

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

    # LSP servers (Claude Code typescript-lsp plugin / Neovim で利用)
    typescript-language-server
    typescript # tsc CLI 用 (LSP は同梱 typescript を fallback 利用するため plugin 動作には必須でない)

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
    flyctl # Fly.io デプロイ CLI
    pandoc
    plantuml
    shellcheck
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
    mysql84
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
    codex
    opencode
    nodejs # Codex MCP servers (context7, playwright) の npx 用

    # Other tools
    ghq
    gifsicle
    mas
    mise # Node.js など複数ランタイムのバージョン管理
    scrcpy
    direnv
  ];

  # Locale
  environment.variables = {
    LANG = "ja_JP.UTF-8";
    LC_ALL = "ja_JP.UTF-8";
  };

  # Hostname (macOS HostName / LocalHostName / ComputerName) は host 固有のため
  # flake.nix の mkDarwin が per-host に注入する (kanade0404 / kanade0404-air)。

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
  ];

  # Used for backwards compatibility
  system.stateVersion = 5;
}
