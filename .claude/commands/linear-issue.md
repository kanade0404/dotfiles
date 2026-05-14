---
description: Linear issue 1 件を取得して linear-issue-driven-development skill を実行 (手動再実行用)
argument-hint: <ISSUE_IDENTIFIER> (例 ENG-123)
---

# /linear-issue $ARGUMENTS

`$ARGUMENTS` で指定された Linear issue 1 件をヘッドレス runner と同じ手順で処理する
ための手動エントリポイント。runner が失敗した issue を再実行したい時や、特定の
issue をすぐ着手したい時に使う。

## 実行手順

1. `LINEAR_API_KEY` が無ければ `~/.config/linear-issue-runner/env` を `source` する。
   未設定なら停止してユーザーに通知。

2. Linear GraphQL で identifier 引きで issue を取得:

   ```bash
   curl -sS -X POST https://api.linear.app/graphql \
     -H "Authorization: $LINEAR_API_KEY" \
     -H "Content-Type: application/json" \
     --data "$(jq -n --arg id "$ARGUMENTS" '{
       query: "query($id:String!){ issue(id:$id){ id identifier title description url branchName state{name type} team{key id} labels{nodes{id name}} } }",
       variables: { id: $id }
     }')" | jq '.data.issue'
   ```

3. 取得した issue JSON を引数に `linear-issue-driven-development` skill を起動する
   (Skill ツール経由)。

4. skill が完走したら、Linear のラベルを以下のいずれかに更新:
   - 成功: `claude:in-progress` を外し `claude:done` を付与
   - 失敗: `claude:in-progress` を外し `claude:failed` を付与

   ラベル ID は `linear-issue-runner` 内のヘルパと同じ GraphQL ミューテーション
   (`issueAddLabel` / `issueRemoveLabel`) で操作する。

## 注意

- 手動実行時も runner と同じガードレールに従う (destructive git 禁止・他リポへ
  逸脱しない・無限ループしない)。
- runner が同時に同じ issue を拾うと二重起動になるので、開始時にまず
  `claude:in-progress` を付けてから作業に入ること。
