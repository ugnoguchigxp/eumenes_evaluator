# Eumenes Evaluator 改善実装計画

2026-11-11 · インスペクション結果にもとづく計画 · 実装前  
前提は [Quick Review の開発・接続計画](plan.md)、[範囲指定と深度拡張の計画](scope-and-depth-plan.md)、[前回のプロジェクト評価](verification-runs/project-review-2026-11-11.mkbqKN/report.md)。

## この計画の範囲

対象は 2026-11-11 13:42 時点のソース。`bun run verify` は通過（型エラーなし、25試験、行カバレッジ 94.5%）。前回評価の F01〜F03 は修正済みで、F04〜F06 は未修正のまま再現した。

載せた項目はすべて、次のいずれかで確認したものに限る。

- **再現**：固定応答または `fetch` の差し替えで現行ソースに対して実行し、記載の結果を得た。サーバーは起動していない。
- **記録**：`verification-runs/` に保存済みの実モデル記録から読み取った。
- **読解**：コードまたは文書の記述から直接確認した。

確認できていない点は「要確認」と明記し、項目の根拠には使っていない。

調査中に `src/bench/suite.ts` が更新され続けていた（236→240 行）。行番号は調査時点のもので、着手時に再確認する。

## 項目一覧

| ID | 優先 | 内容 | 確認 | 主な変更先 |
| --- | --- | --- | --- | --- |
| R01 | 高 | 適用版が合わない確定条件が無言で外れ、`completed` になる | 再現 | `src/snapshot.ts`、`src/evaluate.ts`、`src/contracts.ts` |
| R02 | 高 | 参照不正が1件あると、正しい指摘ごと全件破棄して `failed` になる | 再現・記録 | `src/evaluate.ts` |
| R03 | 中 | HTTP アダプターが失敗の種類を区別しない。平文 `http:` にトークンを送る | 再現 | `src/http-model.ts`、`src/evaluate.ts` |
| R04 | 中 | `--arm A/B/D` と条件付き範囲指定の併用で、外した条件が「取得不能」になる（前回 F05） | 再現 | `src/cli.ts`、`src/rubrics.ts` |
| R05 | 中 | Standard で `required` の資料が、手元にあってもモデルが要求しないと渡らない | 再現 | `src/evaluate.ts`、`src/investigation.ts` |
| R06 | 中 | 実モデル検証の規模が計画に届いていない | 記録 | `examples/` |
| R07 | 中 | 失敗した試行のモデル生出力が残らず、原因を追えない | 記録 | `src/bench/run.ts`、`src/bench/report.ts` |
| R08 | 低 | スイートのシンボリックリンクがスイート外を読める（前回 F04） | 再現 | `src/bench/suite.ts` |
| R09 | 低 | `bench run` が OpenAI 固定 | 読解 | `src/bench/cli.ts` |
| R10 | 低 | 実行記録の digest が、範囲指定・二段階用の指示文を含まない | 読解 | `src/bench/run.ts`、`src/rubrics.ts` |
| R11 | 低 | 構成別の検出率が、構成ごとに異なるケース集合で計算される | 記録 | `src/bench/report.ts` |
| R12 | 低 | 範囲指定の `allowed` に存在しない資料 ID を書いても通る | 再現 | `src/scope.ts` |
| R13 | 低 | CLI の入力エラーが生の英語メッセージ。`--fixture` で Standard を通せない | 再現 | `src/cli.ts` |
| R14 | 低 | issue コードが `string` 型で、一覧の文書がない | 読解 | `src/contracts.ts`、`README.md` |
| R15 | 低 | `evaluate()` が約 400 行の単一関数 | 読解 | `src/evaluate.ts` |
| R16 | 低 | 試験が通っていない拒否経路がある | 再現 | `test/` |
| R17 | 低 | Git 管理外。検証記録が無視対象。CI・lint 設定なし | 読解 | リポジトリ設定 |
| R18 | 低 | `plan.md` の記述が実装とずれている | 読解 | `plan.md` |

## 高：結果の信頼性

### R01 除外した確定条件を結果に出す

**現状。** [`activeConditions`](src/snapshot.ts#L88) は、`confirmed` 以外、対象の ID・版・digest が一致しないもの、出所が失効したものを順に落とす。範囲指定なしの実行で issue になるのは出所の失効だけ（[`condition_sources_inactive`](src/evaluate.ts#L371)）。

**再現。** `examples/code-request.json` の唯一の条件で `appliesTo.version` だけを古い値にした。条件はモデルに渡らず、結果は `status: "completed"`、`conditions: "available"`、`conditionChecks: []`、`issues: []`。ホストが版や digest を取り違えると「条件違反なし」に見える。

**変更。**

1. `activeConditions` が、落とした条件ごとに ID と理由（`not_confirmed`、`target_mismatch`、`source_inactive`）を返す。
2. 結果に `conditionSelection: { applied: string[], excluded: Array<{ id, reason }> }` を追加する。既存フィールドは変えない。
3. `confirmed` かつ `target_mismatch` の条件が1件でもあれば、issue `condition_target_mismatch`（`detail` に ID）を出して `incomplete` にする。`superseded`・`withdrawn`・`proposed` は訂正・撤回の正常経路なので、記録だけで issue にしない。
4. 範囲指定ありの経路は現行の `required_conditions_unavailable` を維持し、`conditionSelection` だけ追加する。

**受入。**

- 上の再現入力が `incomplete` と `condition_target_mismatch` を返す。
- `batch-corrected`（訂正）と `export-columns`（撤回）は現行どおり期待値と一致し、`excluded` に理由付きで載る。
- `bun run bench check` が両スイートで通る。

**注意。** 別の対象向けの条件を同じ入力に混ぜる運用をホストが想定している場合、手順 3 は誤検知になる。その場合は 1・2 だけ入れ、3 を見送る。[計画](plan.md#eumenes-本体の接続)は「対象との対応を確認できる条件を取得する」としているため、3 まで入れる案を推す。

### R02 参照不正の項目だけを落とす

**現状。** [`referenceError`](src/evaluate.ts#L97) が最初の不正で文字列を返し、[呼出し側](src/evaluate.ts#L568)が全出力を破棄して `failed` にする。

**再現。** 正しい指摘1件と、補助根拠が範囲外の行を指す指摘1件を返す固定応答で、結果は `failed`、指摘 0 件。

**記録。** 深度比較の2回の実行で、二段階構成（recheck・standard）の 12 試行中 3 件が `invalid_model_references` で失敗した（`duplicate_checks`、`invalid_condition_check`、詳細なしが各1件）。Quick 系の 35 試行では 0 件。

**変更。** 追加の推論はせず、項目単位で採否を決める。

| モデル出力の不正 | 扱い |
| --- | --- |
| 同一 ID の `scopeChecks`・`conditionChecks` が重複 | 内容が同じなら1件に畳む。食い違えばその ID を未確認にする |
| 範囲外 ID の `scopeChecks`、未知 ID の `conditionChecks` | その項目を捨てる |
| `conditionChecks` の根拠が存在しない、または根拠なしの適合・違反 | その条件を未確認にし、その `conditionId` を持つ指摘も捨てる |
| 指摘の主根拠が選択外、または根拠位置が存在しない | その指摘を捨てる |
| `violated` に対応する指摘が残らない、指摘の `conditionId` が `violated` でない | その条件を未確認にし、対応する指摘を捨てる |

- 1件でも捨てたら issue `model_output_partially_rejected` を出して `incomplete` にする。`completed` にはしない。
- 結果に `rejected: Array<{ kind, index, reason }>` を追加し、何をなぜ落としたかを残す。落とした指摘の本文は結果に載せない。
- JSON 解析失敗とスキーマ違反は現行どおり `failed`。
- `questionChecks` も同じ方針にし、不正な項目の問いは未確認のまま残す。

**受入。**

- 上の再現入力が `incomplete`、指摘1件、`rejected` 1件を返す。
- 既存の試験「存在しない根拠、異なる側の行、抜粋範囲外を拒否する」「選択した資料 ID でも選択外の行が主根拠なら拒否する」は、不正な指摘が結果に出ないことを引き続き確認する（期待状態は `failed` から `incomplete` に変わる）。
- 不正な参照を持つ指摘が `findings` に残る経路がないことを、表の各行について固定応答で確認する。

**見送った案。** 誤りを伝えて1回だけ再出力させる方式は、Quick の「一回の構造化推論」という契約と予算に影響する。上の変更後も失敗が残る場合に、R07 の記録で効果を見積もってから検討する。

## 中：運用と検証

### R03 HTTP の失敗を区別する

**再現。** `fetch` を差し替え、401・429・503、`finish_reason` が `length`・`content_filter` の 200 応答を返した。5通りすべて `failed` と `model_request_failed` で、`detail` なし。また `http://` の非ループバック先に `Authorization` ヘッダーが送られた。

**変更。**

1. `http-model.ts` に `ModelError`（`kind`: `auth`、`rate_limited`、`unavailable`、`truncated`、`refused`、`invalid_response`）を追加し、[応答の検査](src/http-model.ts#L79)と [`finish_reason` の固定](src/http-model.ts#L23)をこれに置き換える。
2. `evaluate` の [catch](src/evaluate.ts#L641) は、`ModelError` のときだけ `detail` に `kind` を入れる。エラーメッセージ・応答本文・キーは結果に入れない。
3. [URL の検査](src/http-model.ts#L43)で、トークン付きの `http:` はループバック宛てだけ許可する。
4. `index.ts` から `ModelError` を公開し、ホストの推論接続も同じ種別を投げられるようにする。

**受入。** 5通りの模擬応答を `detail` で見分けられる。トークン付きの `http://models.example.invalid/` は生成時に拒否され、`http://127.0.0.1/` は通る。

**判断事項。** 自動再試行は入れない。[計画](plan.md#1-比較条件と採点を固定する)は再試行を実行履歴に記録する前提で、評価1件あたり推論1回としている。429・503 の再試行が必要になったら、bench 側に回数を記録する形で別途追加する。

### R04 比較構成と範囲指定の条件を揃える

**再現。** `conditionIds: ["max-batch-size"]` を持つ範囲指定と `comparisonRequest(request, "A" | "B")` の組合せで、`required_conditions_unavailable` と `incomplete`。構成が条件を外したのに、範囲指定が同じ条件を必須にしている。

**変更。** `rubrics.ts` に `comparisonSelection(selection, arm)` を追加し、C 以外では `conditionIds` を空にする。[CLI](src/cli.ts#L65) はプレビューと実行の両方でこれを通す。プレビュー digest は構成ごとに変わる（現行も依頼側の変換後に計算している）。

**受入。** 同じ範囲指定で A・B・D は条件なしで `completed` になり、C は条件を照合する。現行の深度スイートは構成 A〜D を使わないため影響しない。

### R05 Standard で必須資料を確実に渡す

**再現。** `examples/cases/retry-delay.json` と `examples/scopes/retry-line.json`（`timer` が `allowed` かつ `required`）を Standard で実行し、一回目が資料を要求しない固定応答を返した。`timer` は取得されず、「資料がありません」で `incomplete`。

**変更。** Standard の[資料取得](src/evaluate.ts#L523)で、モデルの要求に加えて `required` のうちカタログにある資料を必ず取得する。段階記録にはモデルが要求した ID（`requested`）と必須で補った ID（`requiredAcquired`）を分けて残す。Quick と recheck は現行どおり。

**受入。** 上の再現が `completed` になり、`requested: []`、`requiredAcquired: ["timer"]` が残る。

**判断事項。** 現行の深度スイート3件は、許可資料と必須資料が同じ1件。この変更後は Standard が必ずその資料を得るため、「モデルが正しい資料を選べるか」は `requested` でしか測れなくなる。R06 で、必須でない許可資料や不要な資料を含むケースを足すことが前提になる。測定を優先して現行動作を残す選択もあり、その場合は README に「Standard の完了はモデルの要求に依存する」と明記する。

### R06 検証ケースを計画の規模にする

**記録。**

- [計画](plan.md#1-比較条件と採点を固定する)は調整用6件＋最終評価18件を各3回。実績は条件比較9件と深度比較3件を各1回。差分はすべて1行級で、入力は約1,000〜2,300トークン。
- A→B は既知問題3件中、改善0件。B→C の改善2件は、条件を渡さなければ検出できない欠陥。
- Standard と資料先渡し Quick はともに 2/2 検出。所要時間の中央値は 17.5 秒と 6.6 秒、入力トークンは 2,284 と 1,231。

**変更。** `examples/` にケースを追加する。コードの変更は不要。

1. 調整用と最終評価用を別スイートに分ける。
2. 最終評価用は、コードだけで確認できる回帰・条件依存の回帰・正常変更を各6件。訂正・撤回を回帰例と正常例の両方に入れる。
3. 深度比較用に、許可資料が複数あり一部が無関係なケース、二段階の依存を追うケース、追加資料で指摘候補が反証されるケース、正常変更を入れる。
4. 複数ファイル・複数箇所の差分を含める。
5. 各構成3回で実行し、許容する誤指摘数・時間・トークンを実行前に決めて記録する。

**受入。** `bun run bench check` が全スイートで通る。実モデルでの実行と採点は API 送信と費用を伴うため、実施は別途判断する。

**要確認。** 採点ファイル名が `scores.codex.json` で、計画の「人が採点」と異なる可能性がある。採点者を確認し、モデルが採点した場合は人の再採点を最終評価の条件にするか決める。

### R07 失敗の原因を記録に残す

**記録。** `trials.jsonl` の試行は `result` だけを持ち、モデルの生出力がない。R02 の3件は、どの項目がなぜ不正だったかを後から確認できない。`summary.json` の構成別集計は状態の件数だけで、issue コード別の件数がない。

**変更。**

1. `runSuite` が渡すモデルを包み、各段階の生出力を `raw.jsonl`（`reviewId`、段階、本文）に保存する。`review.json` と採点欄には含めない。
2. `summarize` に、構成別の issue コード件数と、R02 の `rejected` 件数を追加する。

**受入。** 固定応答の試験で、失敗した試行の生出力が `raw.jsonl` に残り、`summary.json` に issue コード別の件数が出る。`bench score` は現行の記録（`raw.jsonl` なし）も採点できる。

## 低：周辺と保守

### R08 スイートの読出しをリンク解決後に検査する

**再現。** スイート内に、スイート外の依頼ファイルを指すシンボリックリンクを置いた。`loadSuite` は受理した。[現行の検査](src/bench/suite.ts#L161)は文字列上の相対パスだけを見る。

**変更。** スイートのディレクトリと対象の両方を `realpath` で解決してから包含を検査し、通常ファイル以外を拒否する。

**受入。** 上のリンクが読出し前に拒否され、既存の2スイートは通る。

### R09 bench で接続先とモデルを選べるようにする

**読解。** [`bench run`](src/bench/cli.ts#L51) は `--openai` がないと停止し、モデル ID も固定。`runSuite` 自体は任意のモデルを受ける。

**変更。** `quick` と同じ `--endpoint` と `--model` を受け、`run.json` に接続先のホスト名とモデル ID を記録する。認証は `EVALUATOR_API_KEY`。

**受入。** `--openai` と `--endpoint` の併用は拒否される。`fetch` を差し替えた試験で、指定したモデル ID が `run.json` に残る。

### R10 指示文の全体を digest に含める

**読解。** [`run.json` の `rubrics`](src/bench/run.ts#L55) は `rubricInstructions` の digest だけを持つ。範囲指定時に[追加する指示](src/evaluate.ts#L390)と、`investigationInstructions`・`verificationInstructions` は含まれない。スキーマの digest は別にある。基準の版は `1` 固定のため、これらの文面を変えても記録上は区別できない。

**変更。** 範囲指定用の指示を `rubrics.ts` の定数に移し、`run.json` に指示文それぞれの digest を追加する。

**受入。** 指示文を1文字変えると `run.json` の該当 digest が変わることを試験で確認する。

### R11 構成別の集計にケース集合を明示する

**記録。** 条件比較の採点結果で、A・B・C は6試行・既知問題3件、D は2試行・既知問題2件。構成別の `recall` は分母のケースが異なり、D の 0.5 と C の 1.0 は直接比べられない。同一ケースの比較は `paired` にある。

**変更。** [`score`](src/bench/report.ts#L159) の構成別出力に対象ケース ID の一覧を加える。README に、構成間の比較は `paired` を使うと明記する。

**受入。** 採点出力の各構成に `caseIds` が出る。

### R12 範囲指定の未知の資料 ID を知らせる

**再現。** `evidence.allowed` に存在しない ID `typo-id` を加えてプレビューした。終了コード 0 で、`allowedEvidenceIds` には載り、`availableEvidence` には載らない。書き間違いに気づけない。

**変更。** プレビューの出力に `unknownEvidenceIds` を追加する。digest の計算対象は変えないため、既存の記録の照合に影響しない。

**受入。** 上の入力で `unknownEvidenceIds: ["typo-id"]` が出る。既存のプレビュー digest は変わらない。

### R13 CLI の入力エラーと固定応答

**再現。**

- 壊れた範囲指定ファイルで `JSON Parse error: Expected '}'` がそのまま出る。
- 存在しない依頼ファイルで `ENOENT: no such file or directory, open 'no-such.json'` がそのまま出る。
- `--depth standard` と `--fixture` の組合せは、同じ応答が両段階に返るため必ず `invalid_investigation_output` になる。

**変更。** ファイルの読出しと JSON 解析の失敗を、どのファイルかを含む日本語のメッセージにする。`--fixture` を2回指定できるようにし、1つ目を調査段階、2つ目を最終判定に使う。

**受入。** 3通りの再現がそれぞれ、対象ファイルを示すメッセージまたは `completed` になる。

### R14 issue コードを型と文書にする

**読解。** [`issues`](src/contracts.ts#L198) の `code` は `string`。コードは `evaluate.ts` と `scope.ts` に約30種あり、`invalid_model_references` は `detail` に下位コードを持つ。README に一覧がない。

**変更。** `contracts.ts` にコードの列挙を置き、`EvaluationResult` の型に使う。`ScopeError` のコードも同じ列挙に含める。README に、コード・状態・対処の表を追加する。R01〜R03 で増えるコードもここに入れる。

**受入。** 列挙にないコードを返す箇所が型検査で落ちる。

### R15 `evaluate()` を分割する

**読解。** [`evaluate`](src/evaluate.ts#L234) は約 400 行で、期限管理、段階実行、結果の組立てがクロージャで同じ変数を共有している。

**変更。** 動作を変えずに、期限と中断を持つ段階実行と、入力の準備（範囲の解決・資料・条件）を別関数に出す。R01・R02・R05 の後に行う。

**受入。** 試験を変更せずに `bun run verify` が通る。

### R16 拒否経路の試験を足す

**再現。** カバレッジで未実行だった行のうち、拒否の分岐にあたるもの。

- `src/bench/archive.ts`：実行 ID の不一致、スイート digest の不一致、予定数の不一致、別実行の混入、取消済みの試行、入力 digest の不一致。
- `src/http-model.ts`：不正な URL と HTTP 失敗（R03 で扱う）。
- `src/evaluate.ts`：不正な深度、範囲指定なしの深度指定、開始前の期限切れ、調査段階の不正出力。

**変更。** 上の分岐ごとに、固定入力で拒否を確認する試験を追加する。R01〜R05 の試験は各項目で追加する。

**受入。** 列挙した行が `bun test --coverage` で実行済みになる。

### R17 版管理と自動検査

**読解。** 作業フォルダは Git リポジトリではない。`.gitignore` は `verification-runs/` を除外しているが、README・計画・前回評価はこのフォルダの記録を根拠として参照している。CI 設定、lint・整形の設定ファイルはない。`package.json` に `"private": true` がない。

**変更。**

1. Git 管理を始める（実行は利用者が行う）。
2. 根拠として参照する実行記録の保存方針を決める。採点済みの記録を残すなら、除外対象から外すか別の保存先を README に書く。
3. `package.json` に `"private": true` を追加する。取込みは tarball で行う計画のため影響しない。
4. `bun run verify` と `bun run bench check`（両スイート）を走らせる CI を追加する。
5. 整形と lint の設定を置く。

**受入。** 新しい作業コピーで `bun install --frozen-lockfile` と CI のコマンドが通る。

### R18 計画書を実装に合わせる

**読解。** [`plan.md`](plan.md) の冒頭は「実装前」のまま。比較構成の表は A・B・C で、実装済みの D（元の依頼文を追加）がない。

**変更。** 状態の記述を更新し、D を表に加える。この計画の完了後、結果を `plan.md` の検証節に反映する。

## 実装順

`src/evaluate.ts` を複数の項目が変更するため、同じファイルに触れる項目は並行させず順に行う。

| 段階 | 項目 | 触れる主なファイル | 段階の完了条件 |
| --- | --- | --- | --- |
| 1 | R01 → R02 → R05 → R03 | `src/evaluate.ts`、`src/snapshot.ts`、`src/investigation.ts`、`src/http-model.ts`、`src/contracts.ts` | 各項目の受入試験と `bun run verify`、両スイートの `bench check` が通る |
| 2 | R04、R12、R13 | `src/cli.ts`、`src/rubrics.ts`、`src/scope.ts` | 同上 |
| 3 | R07 → R11、R08、R09、R10 | `src/bench/` | 同上。現行の保存済み記録を `bench score` で採点できる |
| 4 | R14 → R15、R16 | `src/contracts.ts`、`src/evaluate.ts`、`test/` | 試験を変えずに R15 が通る |
| 5 | R06 | `examples/` | 全スイートの `bench check` が通る |
| 6 | R17、R18 | リポジトリ設定、`plan.md` | CI が通る |

段階 1 の後に一度、独立したレビューを入れる。結果の契約（`conditionSelection`、`rejected`、新しい issue コード）が変わるため、段階 3 以降はその契約を前提にする。

`src/bench/suite.ts` は調査中に更新されていたため、段階 2・3 で触れる前に進行中の変更と重ならないか確認する。

## 契約への影響

- 結果への追加は `conditionSelection`、`rejected`、段階記録の `requiredAcquired`、プレビューの `unknownEvidenceIds`。既存フィールドの意味は変えず、`contractVersion` は 1 のままにする。
- 状態が変わる入力は2種類。適用版が合わない確定条件を含む入力は `completed` から `incomplete` に、参照不正を一部含むモデル出力は `failed` から `incomplete` になる。
- 保存済みの実行記録は、入力 digest の計算を変えないため引き続き採点できる。

## この計画に含めないもの

- 実モデルでの再実行と採点。API 送信と費用を伴うため、R06 のケースが揃った後に別途判断する。
- Deep と Eumenes 本体への接続。[前回評価の進行条件](verification-runs/project-review-2026-11-11.mkbqKN/report.md)のとおり、再評価の後に決める。
- 自動再試行（R03）と、誤りを伝えた再出力（R02）。記録を見てから判断する。
