#!/usr/bin/env bash
# Claude Code の OpenTelemetry export 用 Authorization ヘッダーを供給する helper。
# settings.json の "otelHeadersHelper" から引数・stdin なしで実行され、
# stdout に {"Header-Name": "value"} 形式の JSON を返すことが期待される。
#
# トークンの解決順序:
#   1. 環境変数 OTEL_EXPORTER_TOKEN (claude.ai/code の Environment variables / shell export)
#   2. macOS Keychain (service: claude-code-otel, account: $USER)
#   3. どちらも無ければ {} を返して静かに続行 (ヘッダー無しで export される)
#
# Keychain への登録:
#   security add-generic-password -s "claude-code-otel" -a "$USER" -w '<token>' -U
#
# トークン "値" は stdout の JSON 以外には一切出力しない。
# トークンが取得できなかった場合などの診断メッセージは stderr に出すが、
# そこにトークン値そのものを含めない (トラブルシュート用に残してある)。

token="${OTEL_EXPORTER_TOKEN:-}"

if [ -z "$token" ] && [ "$(uname -s)" = "Darwin" ]; then
  account="${USER:-$(id -un 2>/dev/null)}"
  token="$(security find-generic-password -s "claude-code-otel" -a "$account" -w 2>/dev/null)"
fi

# Keychain 登録時や環境変数設定時に紛れ込んだ前後の空白 (スペース・タブ・改行) を除去する。
# 残したまま Bearer に載せると無効なヘッダーを送り続けることになり原因が分かりにくい。
# 外部コマンドには依存せず、パラメータ展開だけで 1 文字ずつ削る。
while :; do
  case "$token" in
    [[:space:]]*) token="${token#?}" ;;
    *[[:space:]]) token="${token%?}" ;;
    *) break ;;
  esac
done

if [ -z "$token" ]; then
  echo "otel-headers.sh: no token (set OTEL_EXPORTER_TOKEN or add keychain item 'claude-code-otel')" >&2
  printf '{}\n'
  exit 0
fi

# 制御文字 (生の改行・タブ等) を含むトークンは JSON 文字列に素直に埋め込めず、
# 下のエスケープでも扱えないので不正な JSON になる。そもそもトークンとして異常なので
# {} を返して静かに続行する (ヘッダー無しで export される)。
# 判定は [[:cntrl:]] に限定する ([![:print:]] だと LC_ALL=C 下で非 ASCII の
# トークンまで弾いてしまうため)。前後の空白は上で除去済みなので、末尾の改行だけを
# 理由にここで落ちることはない。
case "$token" in
  *[[:cntrl:]]*)
    echo "otel-headers.sh: token contains control characters; ignoring" >&2
    printf '{}\n'
    exit 0
    ;;
esac

# JSON 文字列としてエスケープ (バックスラッシュ → ダブルクォートの順)。jq には依存しない。
escaped="${token//\\/\\\\}"
escaped="${escaped//\"/\\\"}"

printf '{"Authorization":"Bearer %s"}\n' "$escaped"
exit 0
