# duckboard

A Claude Code mod: one pane that shows every Claude Code session on your computer, so you stop checking each one by hand.

It reads your own `~/.claude` files (the live-session registry and the session transcripts) and the engine's usage call. Nothing is sent anywhere.

## What it shows

- The 5-hour and weekly limits, with reset times.
- Sessions in three groups: **Working**, **Your turn** (idle, the prompt cache still warm) and **Cold** (cache gone, or the session closed). Cold is folded; press Show.
- Per session: what it is doing, running agents, cache time left, context size.
- **Details** on a row: the last update, context, cache, running agents, a ticket id, git push state and the newest test run, where known.
- **Compact** on an idle session with a warm cache. Compacting another session works only when that session runs duckboard too.

Open the pane with `/duckboard`. It also opens when a session starts.

## Install

At the prompt of a terminal session:

```
/plugin install duckboard --marketplace stalladesign/duckboard
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install duckboard --marketplace stalladesign/duckboard
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `stalladesign/duckboard`, then Add plugin.

After installing, restart your open sessions so every session runs the same version.

## Requirements

A Claude Code build that supports mods (hooks modules). Mods are early access; the API may change between releases. Built and tested on 2.1.308.

## Options

Set in the config menu (`/config`) or under `pluginConfigs.duckboard` in settings:

- `addressName`: if a reply line starts with this name and a comma or colon, the board drops it.
- `autoCompact` (off by default): compact an idle, warm session after `autoCompactIdleMinutes` (default 50; must be under the 60 minute cache lifetime) when its context is at least `autoCompactMinTokens` (default 100000).
