---
description: Linear issue 1 件を取得して linear-issue-driven-development skill を実行 (手動再実行用)
argument-hint: <ISSUE_IDENTIFIER> (例 ENG-123)
---

# /linear-issue $ARGUMENTS

`$ARGUMENTS` に渡された Linear issue identifier 1 件を、Routine と同じパイプライン
(`linear-issue-driven-development` skill) で処理する手動エントリポイント。
Routine が失敗した issue の再実行や、特定 issue を即着手したい時に使う。

## 実行手順

1. `LINEAR_API_KEY` / `GH_TOKEN` が無ければ環境変数または `~/.config/linear-issue-runner/env` から取得する。未設定なら停止して通知。

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

3. 取得した issue JSON を引数に Skill ツール経由で `linear-issue-driven-development`
   を起動する。

4. skill が完走したら Linear ラベルを更新:
   - 成功: `claude:in-progress` を外し `claude:done` を付与
   - 失敗: `claude:in-progress` を外し `claude:failed` を付与

## 注意

- 手動実行時も Routine と同じガードレールに従う (destructive git 禁止、他リポへ
  逸脱しない、CI 失敗 3 連 / レビュー 5 周で打ち切り)。
- Routine と同時に走るとラベル排他で衝突する可能性あり。先に `claude:in-progress`
  を付けてから作業に入ること。
