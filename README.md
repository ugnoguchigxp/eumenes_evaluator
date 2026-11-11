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
| `raw.jsonl`                            | 推論アダプターが返した応答本文、試行 ID、推論段階                        |
| `trials.jsonl`                         | 各試行の結果、所要時間、トークン、期待値との差                           |
| `summary.json`                         | 構成ごとの状態、issue・除外件数、期待値との差、時間とトークンの p50・p95   |
| `review.json` / `scores.template.json` | 構成名を伏せ、順序を入れ替えた指摘と、指摘ごとの採点欄                   |

実行ディレクトリは Git の対象外です。採点の根拠として共有する場合は、アクセス制御された場所に実行ディレクトリ一式を保存します。`raw.jsonl` は依頼資料を引用した応答を含み得ます。診断用のこのファイルを除いた実行ディレクトリでも採点できます。

`bench run` は `--endpoint <Chat Completions URL> --model <model>` で接続先を指定できます。認証は `EVALUATOR_API_KEY` を使い、`run.json` にはホスト名とモデル ID が残ります。

実行時に機械で照合するのは完了状態と条件ごとの判定です。期待値との差がある実行は終了コード 2 で、結果ファイルは保存されます。資料不足を期待するケースは、その状態と判定が一致すれば差として数えません。

指摘の正誤を採点するときは、`review.json` と `cases.json` を使います。採点欄の `null` を指摘順に次のいずれかで置き換え、別名で保存します。

- 既知の問題を検出した場合は `{"label":"known","defectId":"batch-over-limit"}`
- 根拠のある新しい問題は `{"label":"new_valid"}`
- 誤指摘は `{"label":"false_positive"}`
- 同じ原因についての重複は `{"label":"duplicate"}`

```sh
bun run bench score <run-directory> <scores.json>
```

構成別に既知問題の検出率、誤指摘数、対象の `caseIds` を出力します。構成間の比較には、同じケースと反復に揃えた `paired` を使います。反復時のケース比較では、対応する試行の過半数で検出した既知問題を検出済みとします。記録済みの実行失敗は検出率の分母に残ります。

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
- `evidence.initial` は最初から渡す補足資料、`evidence.allowed` は Standard が追加で読める資料です。ID は依頼ファイルの補足資料または元の変更資料を指します。プレビューの `unknownEvidenceIds` に未登録の ID を表示します。Standard は、手元にある `evidence.required` の資料を最終判定に必ず渡し、モデルの要求外で取得した分を `requiredAcquired` に記録します。必須資料が不足すると、評価は未確認になります。
- `conditionIds` に今回の評価で照合する確定条件を、`focus` に確認事項を指定できます。条件 ID を省略した範囲指定では、成果物の条件本文を推論に渡しません。
- `standard` は二回の推論の間に、要求された許可済み資料を一度取得します。`recheck` は同じ資料のまま二回推論します。Standard の結果には各段階の入力識別子、取得した資料、使用量と、`review.questions` に問いごとの結論・根拠が付きます。最終判定で回答されなかった問いは未確認として残ります。

## 深度を比較する

```sh
bun run bench check --suite examples/depth-suite.json
bun run bench run --openai --suite examples/depth-suite.json
```

[深度比較スイート](examples/depth-suite.json) は、選択したコード行と Workflow の公開設定を対象に、範囲指定 Quick、全許可資料を先渡しする Quick、同じ資料での再評価、Standard の四構成を比較します。コードの単位誤りと Workflow の適合・違反を含みます。取得元は依頼ファイルに固定した資料です。

[複数候補の比較スイート](examples/multi-evidence-suite.json) は、タイムアウト、カーソル、レポート配信について、既知の問題があるケースと適合するケースを各1件含みます。各ケースで同じ対象範囲・確定条件・許可資料を使い、Quick は6〜10件の全候補を先に受け取り、Standard は一覧を見て資料を選びます。必須資料の指定は空です。

```sh
bun run bench check --suite examples/multi-evidence-suite.json
bun run bench run --openai --suite examples/multi-evidence-suite.json --repeat 3
```

6ケースの各反復をペアにして比較します。構成を伏せた `review.json` を、固定済みの期待値と資料で採点します。検出率の分母は既知の問題数と反復数の積です。誤指摘は適合ケースを含めて数えます。追加コストは1試行の所要時間と、全推論段階の入出力トークンで確認し、検出と誤指摘の差に照らして評価します。

### Codex SDKのLunaと比較する

```sh
bun run bench run --openai --codex-sdk --repeat 3
```

このコマンドは複数候補の6ケースに `codex-sdk` を追加し、資料先渡しQuick、Standard、Codex SDKの3構成を各3回、計54試行で比較します。3構成のモデル指定は `gpt-6-luna` です。SDKは新規セッションごとに空の作業ディレクトリを使い、Quickと同じ資料本文、評価指示、出力スキーマを受け取ります。Web検索・シェル・MCPを無効にし、既存のセッションを引き継ぎません。 [OpenAIのCodex SDKドキュメント](https://developers.openai.com/codex/sdk/)

「正しい完了」は `completed`、全条件が期待値と一致、既知問題をすべて検出し、誤指摘や資料に反する具体的な記述がない試行です。既知問題の説明に数値などの誤りがあれば、検出とは別に採点時に記録します。所要時間にはSDKの起動と終了を含め、トークンは接続先が報告する値を使います。SDKの使用量にはCodex固有の入力も含まれます。SDKは出力トークン上限に既定値を使い、QuickとStandardには評価依頼の上限を適用します。

SDKにそろえ、Lunaの推論強度 `low` でQuick・Standard・素のCodexを比較する場合は、次を実行します。

```sh
bun run bench run --openai --codex-sdk-low --repeat 3
```

素のCodexは既定のCodex指示に短いレビュー依頼を加え、資料先渡しQuickと同じ全資料と構造化出力のスキーマを渡します。3構成で同じ根拠検証を行い、Standardの調査段階と最終判定にもSDKの `low` を使います。

### Standardの実行中にSteerを試す

調査中に許可済み資料のIDを一行ずつ入力すると、Standardの最終判定に補足として渡ります。以下はCodex SDKのLunaを使う例です。

```sh
request=examples/cases/maple-preview-deadline.json
scope=examples/scopes/maple-preview-deadline.json
digest=$(bun run quick "$request" --scope "$scope" --preview | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).digest)')
bun run quick "$request" --scope "$scope" --expected-scope-digest "$digest" \
  --depth standard --steer --openai --codex-sdk-low
```

`Steer ready` が出たら `preview-timeouts` と入力して Enter を押します。`Steer accepted` で受付が分かり、結果の `steering.evidenceIds` に引き渡した資料IDが出ます。最終判定の入力を作る直前に受付を締め、許可範囲・資料の版・有効期限を再確認します。調査が取得した資料と重複した場合も本文は一度だけ送ります。

`steering.outcome` の `committed` はモデルの応答を確認できたことを示します。結果そのものの採用は根拠検証と `status` で判断します。入力予算を超えた補足は `released` として外し、モデルに送った後で応答が確認できない場合は `unknown` になります。

Inboxは [eumenes-steer](https://github.com/ugnoguchigxp/eumenes_steer/tree/1250b2071392bf54204fda871cd371830713ce45) 0.1.0を使用し、同梱TGZのSHA-256先頭12桁は `1ca04b8bee9b` です。

## 調整と最終評価

[調整用6件](examples/calibration-suite.json)と[最終評価用18件](examples/final-suite.json)は別のスイートです。最終評価には、コードだけで確認できる回帰、確定条件に依存する回帰、正常変更が各6件あります。反復数・採点方法・実行前に固定した許容値は [計測手順](examples/benchmark-protocol.md) に記載しています。

二段階のCLI試験には `--fixture <調査応答> --fixture <最終応答>` を順に指定できます。範囲を指定して比較構成 A・B・D を使うと、プレビューと実行の両方で条件選択が空になります。

## 評価結果の issue

`conditionSelection.applied` は評価に選んだ条件の ID です。`excluded` は未確定・適用先の不一致・出所の失効により除外した条件と理由を記録します。`rejected` はモデル応答の配列名 `kind`、0始まりの `index`、除外理由 `reason` を返します。同内容の確認結果は1件にまとめます。参照不正で項目を除外したときは、検証を通った指摘を残して `incomplete` を返します。

| コード | 状態 | 確認する点 |
| --- | --- | --- |
| `invalid_request`, `rubric_target_mismatch`, `target_digest_mismatch`, `invalid_diff`, `duplicate_evidence_or_scope`, `duplicate_condition`, `empty_diff_excerpt`, `evidence_version_mismatch` | `failed` | 契約、評価基準、固定版、資料と ID を照合する |
| `invalid_review_depth`, `scope_required_for_depth`, `scope_required_for_preview_digest`, `steering_requires_standard` | `failed` | 評価深度と必要な範囲指定を確認する |
| `invalid_scope_selection`, `scope_target_mismatch`, `scope_selector_target_mismatch`, `scope_selector_no_match`, `scope_evidence_not_allowed`, `scope_evidence_id_conflict`, `scope_preview_mismatch` | `failed` | 対象版と選択範囲、許可資料を照合してプレビューを取り直す |
| `target_scope_missing`, `scope_unverified`, `investigation_evidence_unavailable`, `investigation_questions_unverified` | `incomplete` | 未確認の範囲・問いと、判断に必要な資料を確認する |
| `condition_target_mismatch`, `condition_sources_inactive`, `conditions_unavailable`, `required_conditions_unavailable`, `conditions_unverified` | `incomplete` | 確定条件の適用先、出所、未確認理由を確認する |
| `request_size_limit`, `prompt_size_limit` | `incomplete` | 評価対象と資料の量を調整する |
| `model_output_partially_rejected` | `incomplete` | `rejected` と未確認項目で除外理由を確認する |
| `invalid_investigation_output`, `invalid_model_output` | `failed` | 構造化応答の形式を確認する |
| `model_request_failed` | `failed` | `detail` に応じて認証、レート制限、接続先、出力上限、拒否、不正応答を確認する |
| `deadline_exceeded`, `cancelled` | `expired`, `cancelled` | 期限超過・中断の記録を確認する |

複数の issue がある試行では、最終的な状態は失敗・期限切れ・取消になることもあります。
