# Changelog

What changed in each release of the Kermanych desktop app. The newest version is at the top.
The release workflow publishes a version's section as its GitHub Release notes, and the app
shows it as «What's new». Write each section for the people who use the app, in English.

## 1.5.0 — 2026-11-25

### New

- «Пульт» lets you follow and steer this computer's agents from your phone, through your own
  Tailscale network. Turn it on in Settings → «Застосунок» → «Пульт» and pair the phone with a
  QR code. On the phone you can read a session, answer an agent's question, send a message or a
  photo, and stop an agent. When you are away, it notifies you that an agent needs you.
- New users get a welcome screen that leads to a first workspace and project. The new project
  wizard («+» in the sidebar) checks your git token and clones a repository or uses a folder you
  already have. It also connects an existing project on this computer.
- After an agent opens a PR, Kermanych watches it and sends the agent failed checks and new
  review comments to fix. After 3 rounds in a row it pauses and asks you. Choose «авто» or
  «вручну» per project in the project's Git settings.
- A status line under the session tabs and on each agent card shows where the work is:
  Задача → Агент → ПР → CI → Ревʼю → Злиття, with the action it needs. ⌃ folds it to thin bars.
- A scheduled task remembers its earlier runs. A run reads the notes the last run left, which
  results you marked «Взято в роботу» or «Не цікаво», and the findings already reported, so it
  does not repeat itself. The task shows the notes, and «Очистити нотатки» clears them.
- «Кімната відпочинку» in the header has «Гвіздки», a one-minute break game with a leaderboard.
  Play alone, against AI models, or online with colleagues from your workspace.
- Voice dictation (🎤 or ⌥D) works in the ЦУК and Менеджмент composers.
- A scheduled task's notification opens its details in ЦТ. From there you can delete the
  notification or create a task from it.

### Improvements

- «Розклад» in ЦТ shows the tasks of the selected workspace, plus reminders and tasks without a
  project.
- In «Нова задача», the branch type is picked at the start of the «Гілка» field.
- When an MCP server adds or removes its tools, the agent's log shows one row of server pills
  instead of a long list of tool names.
- «Тестувальник» runs faster. It uses a fast model by default, and you can pick the model and
  effort per project on its page.
- Менеджмент can work on one answer for up to an hour. Before, it stopped after 4 minutes.
- «Центр сповіщень» tries again on its own when it cannot reach the cloud.

### Fixes

- «Запустити» no longer spins forever when a git fetch hangs, for example after the computer
  slept.
- A file link in an agent's log opens the file. Before, it left the window on the start-up
  screen.
- Dictation no longer sends «Музика», or a click, as a message when you said nothing.

## 1.4.0 — 2026-11-17

### New

- The avatar window (⌘K) is now «ЦТ», the central terminal. ЦУК, «Дослідження» and Менеджмент
  are tall strips in it: click one to switch. Switching keeps your drafts and scroll
  position, and a strip pulses while its assistant answers out of sight.
- «Дослідження» replaces the «Чат» page and lives in «ЦТ». It is an agent that reads your
  projects and the web but does not change code. «Продовжити агентом» turns a research into a
  task or a deep analysis in one of your projects. Old chats are archived.
- «Центр сповіщень» has a new «Оновлення» tab with the notes of every Kermanych version. Click
  a version to read all its notes.
- «ШІ-команда → MCP-сервери» is redesigned. Servers are grouped by whether agents can use them,
  and each problem comes with a button that fixes it. «Додати сервер» opens a catalog of 15
  popular servers, such as Playwright, GitHub, Linear, Sentry and Supabase.

### Fixes

- When a project's folder is missing on this computer, the app now says so and asks you to bind
  the folder again. Before, it asked you to install omp.
- The Plane token link in «Інтеграції» opens Plane's token page instead of a project.

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
