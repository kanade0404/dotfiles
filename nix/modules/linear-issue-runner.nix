{ config, pkgs, ... }:
# nix-darwin user launchd agent: 1時間毎に linear-issue-runner を起動する。
#
# 前提:
#   - ~/.config/linear-issue-runner/env に LINEAR_API_KEY などを書いておく
#     (chmod 600 推奨)。
#   - ~/.local/bin/linear-issue-runner / linear-issue-fetch が
#     install.sh で symlink 済み。
#   - claude / gh / jq / curl / bun などは Nix (configuration.nix) もしくは
#     homebrew で導入済み。
#
# ログ: ~/Library/Logs/linear-issue-runner.{out,err}.log
let
  homeBin = "${config.users.users.kanade0404.home}/.local/bin";
in {
  launchd.user.agents.linear-issue-runner = {
    serviceConfig = {
      Label = "com.kanade0404.linear-issue-runner";
      ProgramArguments = [
        "/bin/bash"
        "-lc"
        # bash -lc にすることで ~/.zshenv 経由の PATH (nix プロファイル, homebrew) を拾える。
        # 単独のスクリプトパスにすると claude/gh などが見つからない。
        "${homeBin}/linear-issue-runner"
      ];
      StartInterval = 3600; # 1 hour
      RunAtLoad = false;    # ログイン直後の暴走を避ける
      StandardOutPath = "${config.users.users.kanade0404.home}/Library/Logs/linear-issue-runner.out.log";
      StandardErrorPath = "${config.users.users.kanade0404.home}/Library/Logs/linear-issue-runner.err.log";
      ProcessType = "Background";
      Nice = 10;
    };
  };
}
