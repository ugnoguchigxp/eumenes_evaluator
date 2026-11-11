# Eumenes Evaluator Quick Review

固定したコード差分やワークフロー定義を一回の構造化推論で評価し、根拠付きの指摘と、確認できた範囲・条件を JSON で返します。

## 実行

Bun 1.4.4 を使用します。

```sh
bun install --frozen-lockfile
bun run verify
bun run quick examples/code-request.json --fixture examples/code-response.json --arm C
```

最後のコマンドは架空のコード差分と固定応答を使います。標準入力を使うときは、依頼ファイルの位置に `-` を指定します。正常完了の終了コードは 0、未確認事項を含む結果は 2、失敗・中断・期限超過は 1 です。完了した評価にも条件違反や不具合の指摘は含まれます。

OpenAI の GPT-6 Luna で検証するには、環境変数 `OPEN_AI_API_KEY` を設定した状態で実行します。

```sh
bun run quick examples/code-request.json --openai --arm C
```

このコマンドは評価資料を OpenAI API に送信します。

別の推論接続先を使う場合は、Chat Completions 互換で `response_format.json_schema` と `max_tokens` を受ける URL とモデルを指定します。認証が必要な場合は `EVALUATOR_API_KEY` に接続先のキーを設定します。

```sh
bun run quick examples/code-request.json --endpoint "$EVALUATOR_ENDPOINT" --model "$EVALUATOR_MODEL" --arm C
```

実行先には指定した資料と有効な確定条件が送信されます。Eumenes へ組み込む際は、パッケージの `evaluate(request, { model, signal })` に本体の推論接続を渡せます。

## 入力の準備

- コードの `target.changes` に変更箇所の前後を分けて入れます。テキストは LF で、位置は 1 始まりです。主根拠にできるのはこの一覧の変更範囲です。追加・削除では片側を `null` にします。周辺コードは `evidence` に入れ、`side` に対応するコミットを `version` に指定します。
- Workflow は `target.document` に固定した JSON 定義を入れます。主根拠の資料 ID は `workflow` で、JSON Pointer を使って位置を示します。省略された項目は既存の親を指せます。
- `targetDigests` に digest を除いた対象を渡すと、対象の digest と、コードの場合は変更一覧の digest が得られます。コード資料は固定したコミット対から用意し、Workflow の周辺資料は対象と同じ `version` を使います。
- `scope` に確認が必要な資料 ID を列挙します。コードの変更箇所には `<change-id>:base` と `<change-id>:head` が割り当てられます。資料の不足・切り詰め・モデルの未回答は `unverified` になります。
- 確定条件は有効な出所と対象の ID・版・digest を持つものを渡します。訂正済み・撤回済みの条件は入力の状態で示します。条件が存在しない場合は `none`、確認が必要な条件を取得できない場合は `unavailable` を指定します。結果の `conditionChecks` で、各条件の適合・違反・未確認と根拠を確認できます。

## 比較試験

同じ依頼ファイルと同じモデル・接続先を使い、`--arm` で渡す情報を切り替えます。A は一般的なレビュー、B は具体的な不具合と根拠を求める基準、C は B に確定条件を追加、D は B に元の依頼文を追加します。D には `originalRequest` が必要です。全構成で同じコード資料・スコープ・予算を使用します。

ケースと試行を識別できる名前で結果を保存します。採点時は構成名、評価基準名、入力識別情報を伏せ、指摘の根拠を照合します。既知の問題の検出率、全ケースの誤指摘、未確認・失敗を集計し、同じ変更における改善と悪化を記録します。

### 継続検証のコマンド

```sh
bun run bench check
bun run bench run --openai
bun run bench run --openai --repeat 3
bun run bench run --openai --case batch-limit --case batch-corrected
```

`check` はキー不要で、全サンプルの入力、版、根拠参照、期待値を検査します。実モデルでの全件実行は1周で23試行です。構成と回数は [スイート](examples/suite.json) と `--repeat` で指定します。コードはケースごとの A/B/C/D、Workflow は固定の評価基準で実行します。いずれも同じ Quick Review を呼びます。

スイートには、コードだけで見つけられるリトライの単位誤り、正しい改名、合意条件への違反、同じ差分に対する条件の訂正、条件の撤回、元の依頼文でも判定できるケース、Workflow の公開条件の正常・違反・資料不足があります。すべて架空データです。

結果は毎回 `verification-runs/<実行ID>/` に保存されます。別の保存先は `--out <新規ディレクトリ>`、別のスイートは `--suite <JSON>` で指定できます。

| ファイル                               | 内容                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `run.json` / `cases.json`              | モデル、評価基準と出力形式の版識別、実行条件、入力と採点基準の固定コピー |
| `trials.jsonl`                         | 各試行の結果、所要時間、トークン、期待値との差                           |
| `summary.json`                         | 構成ごとの状態、期待値との差、時間とトークンの中央値・95パーセンタイル   |
| `review.json` / `scores.template.json` | 構成名を伏せ、順序を入れ替えた指摘と、指摘ごとの採点欄                   |

実行時に機械で照合するのは完了状態と条件ごとの判定です。期待値との差がある実行は終了コード 2 で、結果ファイルは保存されます。資料不足を期待するケースは、その状態と判定が一致すれば差として数えません。

指摘の正誤を採点するときは、`review.json` と `cases.json` を使います。採点欄の `null` を指摘順に次のいずれかで置き換え、別名で保存します。

- 既知の問題を検出した場合は `{"label":"known","defectId":"batch-over-limit"}`
- 根拠のある新しい問題は `{"label":"new_valid"}`
- 誤指摘は `{"label":"false_positive"}`
- 同じ原因についての重複は `{"label":"duplicate"}`

```sh
bun run bench score <run-directory> <scores.json>
```

構成別の既知問題の検出率と誤指摘数、A→B・B→C・D→C の同一ケースでの改善と悪化を出力します。反復時のケース比較では、対応する試行の過半数で検出した既知問題を検出済みとします。記録済みの実行失敗は検出率の分母に残ります。

採点には、実行時に保存した予定・入力・完了記録・全試行が必要です。中断、試行の欠落・重複、別入力の混入があれば、集計を返さず終了します。

## 評価範囲を指定する

範囲指定ファイルを用意し、固定した入力と組み合わせます。プレビューはモデルを呼ばず、選択した版、行・JSON Pointer、利用できる補足資料、選択した条件の版と digest を表示します。最上位の `digest` を確認し、以下の `SCOPE_DIGEST` に設定してください。対象、選択、許可資料、条件本文・出所・版のどれかが変わっていれば、推論前に停止します。

```sh
bun run quick examples/cases/retry-delay.json --scope examples/scopes/retry-line.json --preview
bun run quick examples/cases/retry-delay.json --scope examples/scopes/retry-line.json --expected-scope-digest "$SCOPE_DIGEST" --openai
bun run quick examples/cases/retry-delay.json --scope examples/scopes/retry-line.json --expected-scope-digest "$SCOPE_DIGEST" --depth standard --openai
```

- `version: 1` と `targetId`、`targetVersion`、`targetDigest` に依頼の対象を指定します。例は [コードの行指定](examples/scopes/retry-line.json) と [Workflow の部分木指定](examples/scopes/policy-public.json) です。
- `include` でコードの `file`、`directory`、`lines` または Workflow の `pointer` を指定します。行指定には `path`、`side`、`startLine`、`endLine` を使います。指摘の主根拠はこの範囲に置きます。
- `evidence.initial` は最初から渡す補足資料、`evidence.allowed` は Standard が追加で読める資料です。ID は依頼ファイルの補足資料または元の変更資料を指します。`evidence.required` にある資料が不足すると、評価は未確認になります。
- `conditionIds` に今回の評価で照合する確定条件を、`focus` に確認事項を指定できます。条件 ID を省略した範囲指定では、成果物の条件本文を推論に渡しません。
- `standard` は二回の推論の間に、要求された許可済み資料を一度取得します。`recheck` は同じ資料のまま二回推論します。Standard の結果には各段階の入力識別子、取得した資料、使用量と、`review.questions` に問いごとの結論・根拠が付きます。最終判定で回答されなかった問いは未確認として残ります。

## 深度を比較する

```sh
bun run bench check --suite examples/depth-suite.json
bun run bench run --openai --suite examples/depth-suite.json
```

[深度比較スイート](examples/depth-suite.json) は、選択したコード行と Workflow の公開設定を対象に、範囲指定 Quick、全許可資料を先渡しする Quick、同じ資料での再評価、Standard の四構成を比較します。コードの単位誤りと Workflow の適合・違反を含みます。取得元は依頼ファイルに固定した資料です。
