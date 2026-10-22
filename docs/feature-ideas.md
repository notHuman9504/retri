# Feature ideas

Features that could make Retri more useful. They're grouped by who they help and sorted roughly by value for the effort. Each one names the Pi hooks it would use, so it's clear it can be built on top of what Pi offers today (`@earendil-works/pi-coding-agent` 1.0.2).

Size: **S** is under a day, **M** is a few days, **L** needs design work first.

## Done

### Delete snapshots when the session ends (S)

The README listed "Snapshots aren't cleaned up yet" as a limit. Checkpoints don't survive a restart, so once the session ends, its snapshots are dead weight under `~/.pi/agent/retri/`.

- `session_shutdown` calls `Snapshots.discard()`, which deletes the session's refs and staging index, then runs `git prune --expire=1.hour.ago`.
- Objects that other sessions still use are kept. So are objects written in the last hour, because a snapshot another session is taking right now may not have its ref yet.
- If [checkpoints are persisted](#keep-checkpoints-across-a-restart-l), this needs to change: delete snapshots by age, not on quit.

## For the user watching the agent

### Show checkpoints in the status bar (S)

The user can't see that Retri is running, or how close the agent is to the rewind limit.

- `ctx.ui.setStatus('retri', 'checkpoint 4 · rewinds 1/5')`, updated on `turn_end`, cleared on `session_shutdown`.
- Guard it with `ctx.hasUI`, since print and JSON modes have no UI.

### Tell the user when the agent rewinds (S)

Right now a rewind shows up as a notes message in the transcript, and that's it. The user doesn't see which files changed under them.

- After the restore, `ctx.ui.notify('Rewound to checkpoint 2: 3 files restored', 'info')`.
- Get the list of files from `git diff-tree --name-status <now> <target>` before running `read-tree`.
- `pi.registerMessageRenderer(NOTES_TYPE, …)` can show the notes as a styled block instead of plain text.

### `/checkpoints` command (S–M)

A list of the current run's checkpoints: number, time, and the files that changed since the previous one.

- `pi.registerCommand('checkpoints', …)`, with `ctx.ui.select` to pick one and see its diff.
- `Checkpoint` would need to keep a timestamp. The diff comes from `git diff-tree --stat` between two checkpoint trees.

### Let the user rewind (M)

The user often sees that an attempt is going wrong before the agent does. `/rewind 3 "don't touch the schema"` would do what the tool does.

- `pi.registerCommand('rewind', …)`, with `getArgumentCompletions` listing the current checkpoint numbers.
- The command gets `ExtensionCommandContext`, which has `waitForIdle()` and `navigateTree(entryId)`. Moving the conversation with `navigateTree` matches Pi's own `/tree`. The other option is the `context_edit` path the tool uses. Which one fits better is an open question.
- The note should come from the user, so the agent knows the lesson came from them.

### Restore files when the user moves around `/tree` or `/fork` (M)

Pi's `/tree` and `/fork` move the conversation back, but the files stay where they are. So the agent ends up talking about code that isn't on disk anymore. Retri already knows which checkpoint goes with which entry.

- On `session_tree` (or `session_before_fork`), find the latest checkpoint at or before the new leaf.
- Ask with `ctx.ui.confirm('Also restore files to checkpoint 3?')`, then `Snapshots.restore`.
- This needs checkpoints that survive leaving the current run. Today they're tied to it.

### Ask before a rewind (S)

Some users want to approve anything that throws away work.

- `pi.registerFlag('retri-confirm', …)`. When it's set, `execute` in `rewind.ts` calls `ctx.ui.confirm` with the target checkpoint, the note, and the files that would change. If the user says no, the tool fails, so the model reads why.

## For the agent

### List what the rewind couldn't undo (S–M)

This is the biggest gap in the README's Limits: processes, databases, and network calls stay as they are. The agent forgets it ran `npm publish` or a migration, but the effect is still there.

- In `applyPendingRewind`, go through the entries `forgetAfter` hides, and pick out tool calls that may have reached the outside world:
  - tools whose `annotations` have `openWorldHint` or `destructiveHint` (from `pi.getAllTools()`)
  - `bash` commands that match a short list: `git push`, `curl -X POST`, `npm publish`, `docker`, migration commands, `kill`, `rm` outside the workspace
- Add a "These were not undone:" section to the notes message.

### Keep some files through a rewind (M)

A failed attempt often leaves something worth keeping, like a test that reproduces the bug. Today the agent has to write it again from memory.

- An optional `keep: string[]` parameter on the tool.
- After `read-tree`, check those paths out again from the `before-restore` snapshot, which already exists.
- The notes message should say which files were kept.

### Show the diff in the rewind result (S)

The model is told "Rewinding to checkpoint N" but not what that will undo.

- At request time, take the diff between the current files and the checkpoint tree, and return a short `--stat` in the tool result. It's also useful in `details`, for rendering.

### Undo a rewind (M)

Sometimes the agent rewinds too far.

- `restore` already saves a `before-restore-*` snapshot, so getting the files back is cheap.
- Getting the conversation back is the hard part. The hidden entries would need a `context_edit` that shows them again, if Pi supports that. Restoring only the files, with a note, would be a first step.

## Reliability and configuration

### Settings (S)

These are hard-coded today:

- `REWIND_LIMIT` (5)
- `ALWAYS_IGNORED` (`node_modules/`, `.DS_Store`)
- where snapshots are stored (`RETRI_HOME` already exists)

`pi.registerFlag` covers the CLI. A `retri` section in Pi settings would work for every session.

### Guard against large or slow snapshots (S–M)

`git add --all` on every turn is fine for source code. Generated output, datasets, or a missing `.gitignore` can make each turn slow and the snapshot store huge.

- Time each `take()`. If one is slow, `ctx.ui.notify` once and suggest `.gitignore` entries.
- Leave out files over a size limit and say so in the checkpoint label. Rewinding wouldn't restore them, which the agent needs to know.

### Keep checkpoints across a restart (L)

The README says "Checkpoints don't survive a restart."

- Save each checkpoint with `pi.appendEntry('retri', { n, entryId, tree, run })`. That's the storage Pi's docs recommend for data outside the model context.
- On `session_start`, rebuild the state from `ctx.sessionManager.getBranch()`, not from every entry, because abandoned branches are other versions of history.
- Snapshot cleanup would have to change from "on quit" to "older than N days", or "session file gone".

## Reach

### Support other coding agents (L)

The README says "Starting with Pi". `Snapshots` and the notes don't depend on Pi. Only hiding context (`context.ts`) and the event wiring (`index.ts`) do.

- Split it into a core package and a Pi adapter.
- An MCP server version could restore files for any agent that supports MCP. Hiding context would depend on what each agent allows. Where it can't be done, the rewind becomes "restore files and add a note", which is still useful.

### Save the lessons from a run (M, opt-in)

The notes are what the agent learned the hard way, and they're lost when the session ends.

- A `/retri notes` command prints the session's notes, or offers to add them to a project file such as `AGENTS.md`.
- It must never write that file on its own: the user decides what goes into project instructions.
