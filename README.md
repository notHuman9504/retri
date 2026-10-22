# Retri

A rewind button for coding agents.

Retri is a tool that coding agents call themselves. When an attempt goes wrong, the agent rewinds to an earlier checkpoint: files and context go back, and a note carries the lesson forward.

```
rewind(2, "Sleeps don't fix it. The expiry check is wrong.")
```

- Files go back
- Context goes back
- The lesson stays

In development. Starting with [Pi](https://pi.dev).

## Try it

Retri is a Pi extension. Load it for one session:

```bash
pi -e /path/to/retri/src/index.ts
```

Or install it so every session has it:

```bash
pi install /path/to/retri
```

## How it works

1. **Every turn is a checkpoint.** After the agent's tools run, Retri saves a snapshot of the project files and the point the conversation reached. Each tool result ends with a label such as `[checkpoint 3]`, so the agent can name it.
2. **The agent decides to rewind** and calls `rewind(checkpoint, note)`.
3. **When the turn ends, Retri:**
   - puts the files back to that checkpoint,
   - hides everything after it from the model's context, using Pi's `context_edit` entries,
   - adds a message with every note written so far.
4. **The agent carries on from the checkpoint.** The abandoned attempt is gone from what the model sees but stays in the session history.

Snapshots live in a private git repository under `~/.pi/agent/retri/snapshots/`. Your project's own git repository is never touched, and files your `.gitignore` excludes are never snapshotted or restored.

## Limits

- **Only files and conversation go back.** Running processes, databases, and anything sent to an outside service stay as they are.
- **Rewinds stay inside one prompt.** The agent can't rewind past the message that started its current work, so your earlier instructions are never removed.
- **At most 5 rewinds per prompt.**
- **Checkpoints don't survive a restart.** Resuming a session starts with no checkpoints.
- **A checkpoint that context compaction has summarised away can't be rewound to.**
- **Snapshots are deleted when the session ends** (quit, reload, `/new`, `/resume`, `/fork`). Files saved in the last hour are kept a little longer, in case another session is using them. If Pi is killed, its snapshots stay on disk.

## Ideas

[docs/feature-ideas.md](docs/feature-ideas.md) lists features that could come next.

## Develop

```bash
npm install
npm test
npm run typecheck
```

The tests run Pi itself with a scripted model, and check what the model is sent after a rewind.
