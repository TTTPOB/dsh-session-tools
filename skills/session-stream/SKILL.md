# Read DSH session history

Use this skill to find prior conversations, inspect full events or tool errors, trace subagents, or compute statistics. Query from Bash with `curl` and filter with `jq`. Avoid opening or decompressing session files directly. If indexed search reports an error, surface it instead of scanning logs to replace the search.

Use exact, full session IDs copied from `/sessions` or `/search` output: some IDs start with `session-` and some are bare UUIDs, so never add or strip the prefix. The socket reads the current Host's session corpus. Default scope is all projects. To stay within a project, pass its exact absolute session `cwd` to `/sessions` or `/search`; or use IDs already known to belong to the project. If `$DSH_SESSION_STREAM` is absent, Bash is not connected to an active Unix stream; report that rather than guessing a socket path. This API reads one cut per session, not a continuous tail.

## Endpoints (GET)

| Path | Parameters | One NDJSON line |
| --- | --- | --- |
| `/sessions` | optional `cwd`, `limit` | `header` (`id`, `cwd`, `parentSession` and other metadata), `title` (string or `null`), `live`, `persisted` |
| `/search` | required `q`, `group=session` or `group=event`; optional up to 50 repeated `session`, `cwd`, `limit` | session hit (`header`, `bestMatch`) or event hit (`sessionId`, `session`, `seq`, `type`, `snippet` and other index fields) |
| `/events` | 1–50 repeated `session` values; optional `types` (comma-separated), `after_seq` (exclusive, min. −1), `until_seq` (inclusive, min. 0) | original event with added `session_id` |
| `/trace` | exactly one `session` | `target`, `ancestors`, `descendants`, `complete`; `root` or `unresolvedParentId` |

`limit` is a positive integer; leaving it out returns all results, which for a common word can be tens of thousands of lines, so always pass `limit` to `/search` and `/sessions` unless you aggregate the whole stream in `jq`. No cursor is exposed. `types` omitted excludes `request/header` and `system/message`; name either explicitly to include it. Use `--get --data-urlencode` for query strings. Example indexed queries: `"connection refused"`, `timeout OR retry`, `timeout -deprecated`. Index warmup may delay one `/search` request for up to 120 seconds in total.

Each line is a complete JSON value, including large events. An `error` line or nonzero command exit means the results are incomplete. Before the first row, errors use a non-2xx response and a single `{"error":{"code":"…","message":"…"}}` line; after the first row, the service writes an error line and aborts the transfer. Keep `set -o pipefail` so a successful `jq` does not hide curl's failure. Do not treat a truncated Bash preview as a complete result: reduce, filter, or aggregate inside Bash.

## Event fields

- Common: `session_id`, `seq` (unique within the session), `type`, `time` (Unix milliseconds), `data`. Keep raw `surfaceOp` and provenance fields when investigating replacements; the stream is not the current model-visible context.
- `user/message`: `.data.content[]`; `.data.source.kind == "user"` distinguishes real user input from injected contexts, forwarded messages, and other synthetic input.
- `assistant/message`: `.data.turn`, `.data.step`, `.data.message.content[]`; block `type` can be `reasoning`, `text`, or `tool-call`. A `tool-call` block's `.arguments` is a JSON **string**; use `fromjson` to decode, retaining the original on malformed input.
- `tool/call`: `.data.{turn,step,callId,name,arguments}`; `arguments` is a JSON string. Pair with `tool/result` on `.data.message.toolCallId`, not by adjacency. Failure is `.data.message.isError`; inspect `.data.error.reason` when present plus exact `.data.message.content`.
- `tool/ptc-dispatch-start` and `tool/ptc-dispatch`: `.data.{rootCallId,parentCallId,subCallId,name,arguments}`; nested arguments are already JSON. Completion also includes `.data.{isError,content,error}`. These records are not necessarily shown to the model.
- `session/title`: `.data.title`; `/sessions` returns the latest folded title. Trace records hold metadata inside `.header`, and child nodes hold it inside `.session.header`.

## 1. Find conversations by keyword

```bash
set -o pipefail
: "${DSH_SESSION_STREAM:?Load the session-stream skill in a connected DSH Bash}"
query=${QUERY:-connection refused}
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/search \
  --data-urlencode "q=$query" --data-urlencode group=session --data-urlencode limit=10 |
  jq -c '{session_id: .header.id, cwd: .header.cwd, bestMatch}'
```

## 2. Read all real user messages in a session

```bash
set -o pipefail
: "${SESSION:?Set SESSION to the full session ID}"
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/events \
  --data-urlencode "session=$SESSION" --data-urlencode 'types=user/message' |
  jq -c 'select(.data.source.kind == "user") | {seq, time, content: .data.content}'
```

## 3. Find failed tools, their arguments, and the exact errors

```bash
set -o pipefail
: "${SESSION:?Set SESSION to the full session ID}"
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/events \
  --data-urlencode "session=$SESSION" --data-urlencode 'types=tool/call,tool/result,tool/ptc-dispatch' |
  jq -cn '
    foreach inputs as $e ({calls: {}, out: null};
      .out = null |
      if $e.type == "tool/call" then .calls[$e.data.callId] = $e.data
      elif $e.type == "tool/result" then
        $e.data.message.toolCallId as $id |
        .calls[$id] as $call |
        if $e.data.message.isError then
          .out = {seq: $e.seq, callId: $id, name: $call.name,
            arguments: $call.arguments, error: $e.data.error, content: $e.data.message.content}
        else . end | del(.calls[$id])
      elif $e.type == "tool/ptc-dispatch" and $e.data.isError then
        .out = {seq: $e.seq} + ($e.data | {subCallId, parentCallId, name, arguments, error, content})
      else . end;
      .out | select(. != null))'
```

## 4. Read the ordered tool calls in one turn and decode arguments

```bash
set -o pipefail
: "${SESSION:?Set SESSION to the full session ID}" "${TURN:?Set TURN to the turn number}"
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/events \
  --data-urlencode "session=$SESSION" --data-urlencode 'types=turn/start,tool/call,tool/ptc-dispatch-start' |
  jq -cn --argjson turn "$TURN" '
    foreach inputs as $e ({turn: null};
      if $e.type == "turn/start" then .turn = $e.data.turn else . end;
      select(.turn == $turn) | $e |
      if .type == "tool/call" then
        {seq, step: .data.step, callId: .data.callId, name: .data.name,
         arguments: (.data.arguments | . as $raw | try fromjson catch $raw)}
      elif .type == "tool/ptc-dispatch-start" then
        {seq} + (.data | {rootCallId, parentCallId, subCallId, name, arguments})
      else empty end)'
```

## 5. Read one full event by seq

```bash
set -o pipefail
: "${SESSION:?Set SESSION to the full session ID}" "${SEQ:?Set SEQ to the event sequence}"
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/events \
  --data-urlencode "session=$SESSION" --data-urlencode "after_seq=$((SEQ - 1))" --data-urlencode "until_seq=$SEQ"
```

For a prompt/header event, append `--data-urlencode 'types=request/header,system/message'` to the request. An empty successful response means no selected event exists in that range.

## 6. Read context around an indexed event hit

```bash
set -o pipefail
query=${QUERY:-connection refused}
hit=$(curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/search \
  --data-urlencode "q=$query" --data-urlencode group=event --data-urlencode limit=1 |
  jq -ces 'first(.[] | select(has("sessionId")))') || exit 1
sid=$(jq -er '.sessionId' <<< "$hit") || exit 1
seq=$(jq -er '.seq' <<< "$hit") || exit 1
lo=$((seq > 5 ? seq - 6 : -1))
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/events \
  --data-urlencode "session=$sid" --data-urlencode "after_seq=$lo" --data-urlencode "until_seq=$((seq + 5))" |
  jq -c '{seq, type, data}'
```

## 7. Count calls and compute errors per tool across sessions

Set `SESSION` and `SECOND_SESSION` to two different full IDs. Add more `session` parameters, or batch requests at 50 IDs for larger studies. Calls without a result are counted but do not enter the error-rate denominator.

```bash
set -o pipefail
: "${SESSION:?Set SESSION}" "${SECOND_SESSION:?Set SECOND_SESSION}"
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/events \
  --data-urlencode "session=$SESSION" --data-urlencode "session=$SECOND_SESSION" \
  --data-urlencode 'types=tool/call,tool/result,tool/ptc-dispatch-start,tool/ptc-dispatch' |
  jq -n '
    reduce inputs as $e ({totals: {}, pending: {}};
      ($e.session_id + "\u0000" + ($e.data.callId // $e.data.message.toolCallId // $e.data.subCallId // "")) as $key |
      if $e.type == "tool/call" or $e.type == "tool/ptc-dispatch-start" then
        .pending[$key] = $e.data.name | .totals[$e.data.name].calls += 1
      elif $e.type == "tool/result" or $e.type == "tool/ptc-dispatch" then
        .pending[$key] as $name |
        if $name == null then . else
          .totals[$name].settled += 1 |
          if ($e.data.message.isError // $e.data.isError // false) then .totals[$name].errors += 1 else . end |
          del(.pending[$key])
        end
      else . end) |
    .totals | to_entries | sort_by(-.value.calls) | map(
      {name: .key, calls: .value.calls, settled: (.value.settled // 0), errors: (.value.errors // 0)} |
      .error_rate = (if .settled > 0 then .errors / .settled else null end))'
```

## 8. Inspect the subagent tree

```bash
set -o pipefail
: "${SESSION:?Set SESSION to the full session ID}"
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/trace \
  --data-urlencode "session=$SESSION" |
  jq 'def child: {id: .session.header.id, children: [.descendants[] | child]};
    {target: .target.header.id, ancestors: [.ancestors[].header.id],
     children: [.descendants[] | child], complete, unresolvedParentId}'
```
