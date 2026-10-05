# Slack bot — deliver long answers in full

## Goal

A long answer from the Slack documentation bot failed with
«Sorry, I could not answer this one (slack chat.update: msg_too_long).» The asker must get
the whole answer, however long it is.

## Context

`SlackService.answer` (`apps/api/src/slack/slack.service.ts`) posts a placeholder and then
edits it into the answer with `chat.update`. Slack documents a hard cap of 4,000 characters
for `chat.update`'s `text` and answers `msg_too_long` beyond it
(<https://docs.slack.dev/reference/methods/chat.update/>). `chat.postMessage` recommends the
same 4,000 and truncates past 40,000. Any answer over 4,000 characters therefore became the
apology.

## Decisions

- **Split the answer into consecutive thread replies.** The placeholder is edited into the
  first part; every further part is a `chat.postMessage` in the same thread, in order. No
  length is ever refused.
- **3,500 characters per part** (`SLACK_TEXT_LIMIT`), a margin under 4,000 because Slack's
  count does not have to match `String.length`.
- **Break between paragraphs, then lines, and cut a line only past half a part.** A cut line
  breaks at a space and never inside a `<url|label>` link or a surrogate pair. A code block
  split across parts is closed with ``` and reopened with a bare ``` so both halves render as
  code.
- **A failure after the first part does not overwrite it.** The apology is then posted as a
  new reply instead of replacing what was already delivered.
- Rejected: `markdown_text` (12,000 characters on `chat.update`). It only moves the limit,
  and it is a different dialect from the mrkdwn `toSlackMrkdwn` produces. Also rejected:
  Block Kit sections, which have their own 3,000-character and 50-block limits.

## Changes

- `apps/api/src/slack/slack-map.ts` — `SLACK_TEXT_LIMIT`, `splitForSlack` (pure).
- `apps/api/src/slack/slack.service.ts` — `answer` sends the parts; the apology goes to a new
  reply once the first part is posted.
- `apps/api/test/slack-map.spec.ts` — `splitForSlack` cases: a short answer stays whole,
  paragraph breaks lose nothing, a cut code block is balanced in every part, an overlong
  line is cut at a space and never inside a link.

## Verification

- `pnpm --filter @kermanych/api typecheck` — passes.
- `vitest run test/slack-map.spec.ts test/slack-client.spec.ts` — 23 tests pass.
- Throwaway smoke (deleted): a real `SlackService.answer` with the real `SlackClient` against
  a local fake Web API that answers `msg_too_long` for `chat.update` over 4,000 characters.
  The cloud and the model were mocked to return a 12,861-character answer with a 120-line
  code block. Result: one `chat.update` of the placeholder (1,010 chars) plus four
  `chat.postMessage` replies in the thread (3,471 / 3,425 / 3,037 / 1,519). No apology was
  posted. The code block was closed at the end of part 2 and reopened at the start of part 3.

## Documentation impact

- `kermanych/README.md` `### Slack` — new bullet «Long answers arrive in parts».
