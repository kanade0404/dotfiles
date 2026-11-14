{
  description = "kanade0404 macOS system configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nix-darwin = {
      url = "github:LnL7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nix-darwin, home-manager, ... }:
    let
      # ホスト共通の構成。host 固有値 (hostName / nixEnable) だけを引数で受ける。
      #   hostName : macOS HostName / LocalHostName / ComputerName と flake attribute 名
      #   nixEnable: nix-darwin に Nix インストールを管理させるか。
      #              Determinate Nix が入ったマシンでは false にする
      #              (Determinate 自身の daemon と競合して activation が abort するため)。
      #              false のとき flakes / nix-command は Determinate が
      #              /etc/nix/nix.conf で提供するので nix.settings.experimental-features は不要。
      mkDarwin = { hostName, nixEnable }: nix-darwin.lib.darwinSystem {
        system = "aarch64-darwin";
        modules = [
          ./configuration.nix
          {
            networking.hostName = hostName;
            networking.localHostName = hostName;
            networking.computerName = hostName;

            nix.enable = nixEnable;
            nix.settings.experimental-features =
              nixpkgs.lib.mkIf nixEnable [ "nix-command" "flakes" ];
          }
          home-manager.darwinModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.backupFileExtension = "backup";
            home-manager.users.kanade0404 = import ./home.nix;
          }
        ];
      };
    in
    {
      darwinConfigurations = {
        # メイン PC (nix-darwin が Nix を管理)
        "kanade0404" = mkDarwin {
          hostName = "kanade0404";
          nixEnable = true;
        };

        # MacBook Air (Determinate Nix 入り → nix-darwin の Nix 管理は無効)
        "kanade0404-air" = mkDarwin {
          hostName = "kanade0404-air";
          nixEnable = false;
        };
      };
    };
}
