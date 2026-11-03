{ ... }: {
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap"; # Remove formulae/casks not listed here
      upgrade = true;
      # Homebrew 5.1.15+ では `brew bundle install --cleanup` の cleanup 実行に
      # --force-cleanup / --force / $HOMEBREW_ASK のいずれかが必須 ($HOMEBREW_ASK は
      # install/upgrade にも確認プロンプトを挟むため activation 用途に向かない)。--force は
      # install/upgrade 側も --overwrite 動作になり危険なため、cleanup の確認回避
      # だけを目的に --force-cleanup を使う。
      # 新しい nix-darwin は cleanup = "uninstall" / "zap" で同じフラグを自動付与するが、
      # 付与条件が将来変わっても darwin-rebuild の cleanup が失敗しないよう、明示指定を
      # 残している (boolean switch なので重複しても無害)。逆に Homebrew 側がこのフラグを
      # 廃止すると `brew bundle` が invalid option で失敗する。その場合は nix-darwin 側の
      # 自動付与も同じく失敗するため、ここを外すだけでは直らず nix-darwin の更新が必要。
      # 実際に付与されるコマンドラインは `darwin-rebuild build` 後に
      # `grep -n 'brew bundle' result/activate` で確認できる。nix-darwin の自動付与が
      # 生きているかは `grep -o -- '--force-cleanup' result/activate | wc -l` が
      # 2 (自動 + 明示) かで判別する。
      extraFlags = [ "--force-cleanup" ];
    };

    taps = [
      { name = "ariga/tap"; trusted = true; }
      # Herdr UI (herdr-gpui) の作者 Fabien Penso の個人 tap。herdr 本体 (herdrdev) とは
      # 無関係の第三者なので、tap 全体は信頼せず、casks 側で herdr-gpui だけを trusted に
      # する。これで防げるのは tap に追加される他の cask / formula だけで、herdr-gpui の
      # cask 定義そのもの (HEAD に追従し preflight 等も実行される) は作者を全面的に信頼する。
      # Homebrew 7.0 の実装で確認済み (5.1.x は未確認): cask の読み込み (cask_loader) は
      # cask 単位の trust で通るので、アプリ内 updater の `brew upgrade --cask herdr-gpui` も通る。
      # 全 cask を列挙する経路 (Cask.all) は、tap 内の未信頼 cask を読み飛ばすだけでエラーに
      # しない (Trust.trusted_cask_files)。brew bundle の cleanup が読み込むのは入っている
      # cask だけで、それは trusted 済み。
      "penso/tap"
    ];

    # Formulae that stay in Homebrew (not available or problematic in nixpkgs)
    brews = [
      "ariga/tap/atlas"
      "herdr" # Agent multiplexer for the terminal (not in nixpkgs)
      "php"
      "rbenv"
      "ruby-build"
      "squid" # not available on aarch64-darwin in nixpkgs
    ];

    # All GUI applications (casks)
    casks = [
      "1password"
      "discord"
      "dropbox"
      "firefox"
      "font-fira-code"
      "font-fira-code-nerd-font"
      "google-chrome"
      "gyazo"
      "karabiner-elements"
      "mactex-no-gui"
      "notion"
      "obsidian"
      "orbstack"
      # herdr daemon の GUI クライアント (Herdr UI)。信頼の範囲は taps の penso/tap を参照。
      # tap HEAD は固定していない (nix-homebrew の mutableTaps = false で固定できるが、
      # 管理方式ごと移行になるので採らない)。greedy は将来 auto_updates が宣言されても
      # upgrade = true で上げ続けるため。daemon (brews の "herdr") とは別リリースなので、
      # GUI が繋がらなくなったら `herdr --version` と GUI のバージョンの組み合わせを疑う。
      { name = "penso/tap/herdr-gpui"; greedy = true; trusted = true; }
      "postman"
      "raycast"
      "secretive"
      "slack"
      "spotify"
      "temurin@21"
      "the-unarchiver"
      "utm"
      "visual-studio-code"
      "warp"
      "zoom"
    ];
  };
}
