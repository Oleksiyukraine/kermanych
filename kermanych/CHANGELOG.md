# Changelog

What changed in each release of the Kermanych desktop app. The newest version is at the top.
The release workflow publishes a version's section as its GitHub Release notes, and the app
shows it as «What's new». Write each section for the people who use the app, in English.

## 1.3.1 — 2026-11-15

### New

- ЦУК answers faster. ЦУК and Менеджмент show the answer while it is being written, and
  Менеджмент shows what it is looking at. Stop an answer with «■» in place of the send button,
  or with Esc.
- While the app starts and while you sign in, the word КЕРМАНИЧ gathers from pixels, with a
  random engineer's quote under it.

### Improvements

- The app checks for a new version every hour instead of every 4 hours, so updates reach you
  sooner.

### Fixes

- Pressing 🎤 no longer freezes the window.
- In a new session, a Next.js app in the live preview picks up the agent's edits again. You no
  longer have to reload or restart the preview.
- Web pages open in your browser can no longer read your agents' sessions from the app's local
  service.

## 1.3.0 — 2026-11-15

### New

- Text you have not sent yet stays where you typed it: in an agent's chat, a task form, an
  issue comment. It survives switching to another agent, closing the form and restarting the
  app, and is cleared when you send or save. Agents, cards and chats with unsent text show ✎.
- Voice dictation runs on your computer instead of OpenAI. It is free and needs no OpenAI key.
  Download the speech model once in Settings → «Голос». It works in «Синергія», in task forms,
  and in «Агенти» and «Чат».
- In «Агенти» and «Чат», the 🎤 ▾ menu picks dictation or a Live conversation. You can now
  interrupt a Live conversation by speaking.
- «ШІ-команда → MCP-сервери» shows the project's MCP servers. You can add, edit, delete and
  test them there, and fill in the values they need. Secrets go to the project's `.env`.
- «Надіслати відгук» sends a bug report or an idea, with screenshots, to the maintainers. Open
  it from the icon in the header or from Settings → «Загальне».

### Fixes

- Half-typed text no longer moves to the next agent, or to the next Jira issue's comment.
- Long notifications stay compact. «Pull» now shows a one-line result instead of git's full
  output.
- Creating a task from a finding, a document or «Синергія» no longer shows empty project and
  assignee lists after the app started without a network.

## 1.2.0 — 2026-11-05

- First public release: a signed and notarized macOS app (Apple Silicon) and a Linux AppImage.
- The app updates itself. It downloads a new version in the background, installs it when you
  quit, and shows what is new in it.
- Agents and terminals find `omp`, `claude` and `git` also when you open the app from Finder,
  the Dock or the application menu.
