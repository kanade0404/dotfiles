{ ... }: {
  # Squid HTTP proxy: kept in Homebrew (squid is Linux-only in nixpkgs)
  # Managed via `brew services start squid`

  # AeroSpace tiling window manager
  services.aerospace = {
    enable = true;
    settings = {
      start-at-login = false; # launchd manages startup

      # Automatically switch back to "tiles" when possible
      default-root-container-layout = "tiles";
      default-root-container-orientation = "auto";

      # Normalizations
      enable-normalization-flatten-containers = true;
      enable-normalization-opposite-orientation-for-nested-containers = true;

      # Gaps
      gaps = {
        inner.horizontal = 8;
        inner.vertical = 8;
        outer.left = 8;
        outer.bottom = 8;
        outer.top = 8;
        outer.right = 8;
      };

      # Assign workspaces to monitors
      workspace-to-monitor-force-assignment = {
        "1" = "Built-in Retina Display";
        "2" = "Built-in Retina Display";
        "E" = "EV3450XC";
        "F" = "EV3450XC";
      };

      # Float non-tileable apps
      on-window-detected = [
        { "if".app-id = "com.apple.finder"; run = "layout floating"; }
        { "if".app-id = "com.apple.systempreferences"; run = "layout floating"; }
        { "if".app-id = "com.apple.SystemPreferences"; run = "layout floating"; }
        { "if".app-id = "com.apple.calculator"; run = "layout floating"; }
        { "if".app-id = "com.apple.ActivityMonitor"; run = "layout floating"; }
        { "if".app-id = "com.apple.Preview"; run = "layout floating"; }
        { "if".app-id = "com.apple.keychainaccess"; run = "layout floating"; }
        { "if".app-id = "com.1password.1password"; run = "layout floating"; }
        { "if".app-id = "jp.naver.line.mac"; run = "layout floating"; }
      ];

      # Key bindings
      mode.main.binding = {
        # Focus
        alt-h = "focus left";
        alt-j = "focus down";
        alt-k = "focus up";
        alt-l = "focus right";

        # Move windows
        alt-shift-h = "move left";
        alt-shift-j = "move down";
        alt-shift-k = "move up";
        alt-shift-l = "move right";

        # Workspaces (built-in)
        alt-1 = "workspace 1";
        alt-2 = "workspace 2";
        # Workspaces (external)
        alt-e = "workspace E";
        alt-f = "workspace F";

        # Move to workspace
        alt-shift-1 = "move-node-to-workspace 1";
        alt-shift-2 = "move-node-to-workspace 2";
        alt-shift-e = "move-node-to-workspace E";
        alt-shift-f = "move-node-to-workspace F";

        # Layout
        alt-slash = "layout tiles horizontal vertical";
        alt-comma = "layout accordion horizontal vertical";
        alt-t = "layout floating tiling";
        alt-shift-t = "fullscreen";

        # Resize
        alt-minus = "resize smart -50";
        alt-equal = "resize smart +50";

        # Service mode
        alt-shift-semicolon = "mode service";
      };

      # Service mode for less common operations
      mode.service.binding = {
        esc = "mode main";
        r = [ "flatten-workspace-tree" "mode main" ];
        f = [ "layout floating tiling" "mode main" ];
        backspace = [ "close-all-windows-but-current" "mode main" ];
      };
    };
  };
}
