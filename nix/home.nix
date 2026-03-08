{ pkgs, ... }: {
  home.stateVersion = "24.11";
  home.username = "kanade0404";
  home.homeDirectory = "/Users/kanade0404";

  # Rust toolchain
  home.packages = with pkgs; [
    rustup
  ];

  programs = {
    # direnv + nix-direnv for per-project flake support
    direnv = {
      enable = true;
      nix-direnv.enable = true;
    };

    # Git (migrated from dotfiles/.gitconfig)
    git = {
      enable = true;
      settings = {
        user = {
          name = "kanade0404";
          email = "melty0404@gmail.com";
        };
        core = {
          editor = "nvim";
          excludesfile = "~/.gitignore";
          autocrlf = "input";
        };
        color = {
          branch = "auto";
          diff = "auto";
          interactive = "auto";
          status = "auto";
        };
        init.defaultBranch = "master";
        web.browser = "google-chrome";
        credential.helper = "osxkeychain";
        push.default = "simple";
        merge = {
          tool = "kdiff3";
          conflictstyle = "zdiff3";
        };
        difftool.prompt = false;
        pull.rebase = true;
        commit.template = "/Users/kanade0404/.gitmessage";
        alias = {
          c = "commit";
          ca = "commit -a";
          cm = "commit -m";
          cam = "commit -am";
          d = "diff";
          dc = "diff --cached";
          l = ''log --graph --pretty=format:"%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset" --abbrev-commit'';
          wt = "worktree";
          wta = "worktree add";
          wtl = "worktree list";
          wtr = "worktree remove";
        };
      };
    };

    # Delta (git diff pager)
    delta = {
      enable = true;
      enableGitIntegration = true;
      options = {
        navigate = true;
        side-by-side = true;
        line-numbers = true;
        syntax-theme = "GitHub";
      };
    };

    # bat (moved from configuration.nix for unified config)
    bat = {
      enable = true;
      config = {
        theme = "GitHub";
        style = "numbers,changes,header";
      };
    };

    # Starship prompt
    starship = {
      enable = true;
      settings = {
        format = "$directory$git_branch$git_status$git_state$nodejs$golang$python$rust$terraform$nix_shell$cmd_duration$line_break$character";
        directory.truncation_length = 3;
        git_branch.symbol = " ";
        character = {
          success_symbol = "[>](bold green)";
          error_symbol = "[>](bold red)";
        };
        cmd_duration.min_time = 2000;
        nix_shell.format = "[$symbol$state]($style) ";
      };
    };

    # tmux
    tmux = {
      enable = true;
      prefix = "C-a";
      baseIndex = 1;
      escapeTime = 0;
      keyMode = "vi";
      mouse = true;
      historyLimit = 50000;
      terminal = "tmux-256color";
      sensibleOnTop = true;

      plugins = with pkgs.tmuxPlugins; [
        resurrect
        continuum
        yank
        tmux-fzf
        vim-tmux-navigator
      ];

      extraConfig = ''
        # True color for Ghostty
        set -ag terminal-overrides ",xterm-ghostty:Tc"
        set -g focus-events on
        set -g set-clipboard on
        set -g renumber-windows on

        # Pane splitting (intuitive keys)
        bind | split-window -h -c "#{pane_current_path}"
        bind - split-window -v -c "#{pane_current_path}"
        unbind '"'
        unbind %

        # New window in current path
        bind c new-window -c "#{pane_current_path}"
        bind Tab last-window

        # Pane resize
        bind -r H resize-pane -L 5
        bind -r J resize-pane -D 5
        bind -r K resize-pane -U 5
        bind -r L resize-pane -R 5

        # Copy mode (vi + pbcopy)
        bind -T copy-mode-vi v send -X begin-selection
        bind -T copy-mode-vi y send -X copy-pipe-and-cancel "pbcopy"

        # Appearance (GitHub Light)
        set -g status-style "bg=#f6f8fa,fg=#24292e"
        set -g status-left-length 40
        set -g status-left "#[fg=#0366d6,bold] #S #[default]| "
        set -g status-right "#[fg=#586069]%Y-%m-%d %H:%M "
        set -g window-status-current-style "fg=#0366d6,bold"
        set -g window-status-style "fg=#586069"
        set -g pane-border-style "fg=#e1e4e8"
        set -g pane-active-border-style "fg=#0366d6"

        # Plugin settings
        set -g @resurrect-strategy-nvim 'session'
        set -g @resurrect-capture-pane-contents 'on'
        set -g @continuum-restore 'on'
        set -g @continuum-save-interval '15'
      '';
    };

    # zoxide (cd replacement)
    zoxide = {
      enable = true;
      enableZshIntegration = true;
    };

    # GPG
    gpg = {
      enable = true;
    };

    # Zsh (migrated from ~/.zshrc)
    zsh = {
      enable = true;
      enableCompletion = true;
      autosuggestion.enable = true;
      syntaxHighlighting.enable = true;

      history = {
        size = 10000;
        save = 10000;
      };

      shellAliases = {
        gs = "git status";
        gc = "git commit";
        gp = "git pull --rebase";
        gcam = "git commit -am";
        gl = ''git log --graph --pretty=format:"%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset" --abbrev-commit'';
        tenki = "curl wttr.in/Tokyo";
        python3 = "python";
        # Neovim
        v = "nvim";
        vi = "nvim";
        vim = "nvim";

        # tmux
        t = "tmux";
        ta = "tmux attach -t";
        tn = "tmux new-session -s";
        tl = "tmux list-sessions";

        # Claude Code
        c = "ENABLE_TOOL_SEARCH=true claude";

        # git worktree
        gwl = "git worktree list";
        gwa = "git worktree add";

        # eza
        ls = "eza --icons";
        ll = "eza --icons -la";
        lt = "eza --icons --tree --level=2";
      };

      plugins = [
        {
          name = "zsh-history-substring-search";
          src = pkgs.zsh-history-substring-search;
          file = "share/zsh-history-substring-search/zsh-history-substring-search.zsh";
        }
      ];

      initContent = ''
        # Colors
        unset LSCOLORS
        export CLICOLOR=1
        export CLICOLOR_FORCE=1
        unsetopt nomatch

        # Bash-style time output
        export TIMEFMT=$'\nreal\t%*E\nuser\t%*U\nsys\t%*S'

        # Case insensitive completion
        zstyle ':completion:*' matcher-list \
          'm:{[:lower:][:upper:]}={[:upper:][:lower:]}' \
          'm:{[:lower:][:upper:]}={[:upper:][:lower:]} l:|=* r:|=*' \
          'm:{[:lower:][:upper:]}={[:upper:][:lower:]} l:|=* r:|=*' \
          'm:{[:lower:][:upper:]}={[:upper:][:lower:]} l:|=* r:|=*'

        # History substring search key bindings
        bindkey "^[[A" history-substring-search-up
        bindkey "^[[B" history-substring-search-down

        # fzf integration
        source <(fzf --zsh)
        export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
        export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
        export FZF_ALT_C_COMMAND='fd --type d --hidden --follow --exclude .git'
        export FZF_DEFAULT_OPTS='
          --color=fg:#24292e,bg:#ffffff,hl:#0366d6
          --color=fg+:#24292e,bg+:#f1f8ff,hl+:#0366d6
          --color=info:#6a737d,prompt:#0366d6,pointer:#d73a49
          --color=marker:#28a745,spinner:#6a737d,header:#6a737d
          --height=40% --layout=reverse --border'

        # Include alias file (if present)
        if [ -f ~/.aliases ]; then
          source ~/.aliases
        fi

        # Homebrew (still needed for casks and remaining brews)
        export HOMEBREW_AUTO_UPDATE_SECS=604800

        # Go
        export GOPATH=$HOME/go
        export GOBIN=$HOME/go/bin
        export PATH="$GOBIN:$PATH"

        # pnpm
        export PNPM_HOME="/Users/kanade0404/Library/pnpm"
        case ":$PATH:" in
          *":$PNPM_HOME:"*) ;;
          *) export PATH="$PNPM_HOME:$PATH" ;;
        esac

        # Deno
        export DENO_INSTALL=/Users/kanade0404/.deno
        export PATH="$HOME/.deno/bin:$PATH"

        # Bun
        [ -s "/Users/kanade0404/.bun/_bun" ] && source "/Users/kanade0404/.bun/_bun"
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"

        # Google Cloud SDK
        if [ -f "$HOME/sdk/google-cloud-sdk/path.zsh.inc" ]; then
          source "$HOME/sdk/google-cloud-sdk/path.zsh.inc"
        fi
        if [ -f "$HOME/sdk/google-cloud-sdk/completion.zsh.inc" ]; then
          source "$HOME/sdk/google-cloud-sdk/completion.zsh.inc"
        fi

        # JetBrains Toolbox
        export PATH="$PATH:$HOME/Library/Application Support/JetBrains/Toolbox/scripts"

        # dotnet / fsharp
        export PATH="$HOME/.dotnet:$PATH"

        # moonbit
        export PATH="$HOME/.moon/bin:$PATH"

        # Modular / Mojo
        export MODULAR_HOME="/Users/kanade0404/.modular"
        export PATH="/Users/kanade0404/.modular/pkg/packages.modular.com_mojo/bin:$PATH"

        # npm global
        export PATH="$HOME/.npm-global/bin:$PATH"

        # Helper scripts
        export PATH="$HOME/.local/bin:$PATH"

        # mise (kept for Node.js multi-version management)
        eval "$(mise activate zsh)"

        # rbenv
        eval "$(rbenv init - zsh)"

        # mactex
        eval "$(/usr/libexec/path_helper)"

        # Kiro
        [[ "$TERM_PROGRAM" == "kiro" ]] && . "$(kiro --locate-shell-integration-path zsh)"

        # Custom functions
        # cd 後に自動で ls を実行
        chpwd() {
          eza --icons
        }

        # Git upstream branch syncer
        function gsync() {
          if [[ ! "$1" ]]; then
            echo "You must supply a branch."
            return 0
          fi
          BRANCHES=$(git branch --list $1)
          if [ ! "$BRANCHES" ]; then
            echo "Branch $1 does not exist."
            return 0
          fi
          git checkout "$1" && \
          git pull upstream "$1" && \
          git push origin "$1"
        }

        # Docker container oneshots
        dockrun() {
          docker run -it geerlingguy/docker-"''${1:-ubuntu1604}"-ansible /bin/bash
        }

        # Enter a running Docker container
        function denter() {
          if [[ ! "$1" ]]; then
            echo "You must supply a container ID or name."
            return 0
          fi
          docker exec -it $1 bash
          return 0
        }

        # Delete a given line number in known_hosts
        knownrm() {
          re='^[0-9]+$'
          if ! [[ $1 =~ $re ]]; then
            echo "error: line number missing" >&2;
          else
            sed -i "" "$1d" ~/.ssh/known_hosts
          fi
        }
      '';
    };
  };
}
