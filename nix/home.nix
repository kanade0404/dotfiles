{ pkgs, ... }: {
  home.stateVersion = "24.11";

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
      userName = "kanade0404";
      userEmail = "melty0404@gmail.com";
      delta.enable = true;
      extraConfig = {
        core = {
          editor = "vi";
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
        merge.tool = "kdiff3";
        difftool.prompt = false;
        pull.rebase = true;
        commit.template = "/Users/kanade0404/.gitmessage";
      };
      aliases = {
        c = "commit";
        ca = "commit -a";
        cm = "commit -m";
        cam = "commit -am";
        d = "diff";
        dc = "diff --cached";
        l = ''log --graph --pretty=format:"%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset" --abbrev-commit'';
      };
    };

    # Starship prompt
    starship = {
      enable = true;
    };

    # tmux
    tmux = {
      enable = true;
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
      };

      plugins = [
        {
          name = "zsh-history-substring-search";
          src = pkgs.zsh-history-substring-search;
          file = "share/zsh-history-substring-search/zsh-history-substring-search.zsh";
        }
      ];

      initExtra = ''
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

        # mise (kept for Node.js multi-version management)
        export PATH="/Users/kanade0404/.local/bin:$PATH"
        eval "$(mise activate zsh)"

        # rbenv
        eval "$(rbenv init - zsh)"

        # mactex
        eval "$(/usr/libexec/path_helper)"

        # Kiro
        [[ "$TERM_PROGRAM" == "kiro" ]] && . "$(kiro --locate-shell-integration-path zsh)"

        # Custom functions
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
