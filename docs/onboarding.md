# Team onboarding

Every engineer runs their own agent, with their own credentials. Nothing in this
setup is shared at runtime: your Jira actions are attributed to you, your PRs are
opened by your GitHub account, and your session history stays on your machine.

Budget 15 minutes. Steps 1–4 are required; step 5 is the check that you're done.

> **Never share or copy someone else's `~/.omp/agent/` directory.** It holds OAuth
> credentials, session transcripts, and history databases. Only `mcp.json` is
> meant to be replicated, and only the non-secret server declarations in it.

---

## 1. Install the `omp` CLI

The extension is a front-end. It spawns the same `omp` binary you'd use from a
terminal, so the CLI must be installed and authenticated first.

```bash
omp --version   # expect omp/17.3.0 or newer
```

If the binary lives somewhere off your `PATH`, point the `omp.executablePath`
setting at it instead of moving it.

## 2. Install the extension

Download the latest `omp-ui-<version>.vsix` from the repository's
[Releases](https://github.com/HEshtay/omp-ui/releases) page — do not build your
own, so the whole team runs an identical, CI-verified build.

```bash
code --install-extension omp-ui-0.1.0.vsix
```

Then **reload the window**. The IDE bridge registers itself at activation and
`omp` only reads MCP config at agent startup, so a reload is not optional.

Open the **OMP** view from the activity bar, or press `Ctrl+Shift+Alt+O`
(`Cmd+Shift+Alt+O` on macOS).

## 3. Authenticate GitHub

```bash
gh auth login
```

Choose your own account and grant `repo`, `workflow`, and `read:org`. The agent
reads issues and PRs and opens PRs through `gh`, so whichever account is *active*
is the author of record.

If you have more than one GitHub account on this machine, check which one is
active before letting an agent open a PR:

```bash
gh auth status      # the account marked "Active account: true" is the author
gh auth switch      # change it
```

## 4. Authorize Jira and Confluence

The Atlassian MCP server is declared per user in `~/.omp/agent/mcp.json`. Add the
`atlassian` entry below if it isn't there already, keeping any other entries
intact:

```json
{
  "mcpServers": {
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp/authv2",
      "auth": {
        "type": "oauth",
        "credentialId": "mcp_oauth:profile:default:https://mcp.atlassian.com/v1/mcp/authv2",
        "tokenUrl": "https://cf.mcp.atlassian.com/v1/token",
        "clientId": "W_GX0m5Yt1TE0yFT",
        "resource": "https://mcp.atlassian.com/v1/mcp/authv2"
      },
      "oauth": {
        "clientId": "W_GX0m5Yt1TE0yFT"
      }
    }
  }
}
```

There is no secret in that block — the OAuth flow runs in your browser on first
use and stores *your* token in *your* credential store. Sign in as yourself.

Do **not** hand-write a `vscode-ide` entry. The extension writes and repairs that
one on every activation, pointing at your own VS Code binary and your own
extension install directory (`src/ide/registration.ts`). It merges into the file
and leaves every other server untouched.

## 5. Verify

Run all seven. Each has a concrete expected result; if one fails, stop there.

| # | Check | Expected |
|---|---|---|
| 1 | `omp --version` | `omp/17.3.0` or newer |
| 2 | `gh auth status` | `✓ Logged in`, correct active account |
| 3 | Press `Ctrl+Shift+Alt+O` | OMP chat opens and accepts a message |
| 4 | **OMP** output channel (Output panel → OMP) | `ide bridge: listening on … (12 tools)` |
| 5 | Ask the agent: *"run the typecheck task"* | it calls `run_task` and reports exit code 0 |
| 6 | Ask the agent: *"run the tests"* | it calls `run_tests` and reports pass/fail counts, not raw terminal text |
| 7 | Ask the agent: *"list the Jira projects I can create issues in"* | your real project keys come back |

Check 4 proves the IDE bridge is live — the agent can read diagnostics, resolve
symbols through the language server, see SCM diffs, see the file and cursor you
are looking at, and run this workspace's configured tasks and tests. Checks 5 and
6 prove it end to end, and prove the difference between the two: `run_task` hands
back a task's exit code and terminal text, `run_tests` hands back counts and the
`file:line` of each failure. Check 7 proves your own Atlassian OAuth completed.

If check 4 shows no line at all, run **OMP: Register IDE Bridge with omp** from
the command palette, then reload the window.

---

## Approval mode: decide this per repository

`omp`'s own default is `yolo` — every tool call auto-approved, including writes
and shell commands. That is fine on a scratch branch and wrong on a product
repository.

Set it per workspace in `.vscode/settings.json` and commit that file, so the
policy travels with the repo rather than living in each engineer's head:

```json
{
  "omp.approvalMode": "write"
}
```

- `write` — ask before commands, auto-approve file edits. Sensible default for
  product repos, since edits are reviewable as diffs and commands are not.
- `always-ask` — ask before every write and command. Use while a team is still
  building trust in the loop.
- `yolo` — auto-approve everything. Scratch work only.

Checkpoints shift that trade-off a little. With `omp.checkpoints.enabled` (the
default) the extension snapshots the work tree before each turn, so a turn's file
changes can be reverted wholesale from the transcript or with **OMP: Revert
Workspace to Checkpoint** — a file-level undo omp itself does not have, and the
reason `yolo` is survivable on a scratch branch at all.

It is not a substitute for approval on a product repository. A snapshot covers
only what git can see, so `.gitignore`d build output, caches, and local databases
are *not* restored, and nothing a command did outside the work tree — a push, a
migration, a deleted container — is undone by rewinding files.

## What to agree on before scaling up

Tooling is per-engineer; conventions are not. Pin these down in each repo's
`AGENTS.md` so every teammate's agent behaves the same way:

- Branch naming that carries the Jira key (e.g. `DAK-1234-short-slug`), so Jira
  and GitHub stay cross-linked without manual bookkeeping.
- The real build, test, and lint commands — or a `tasks.json` the agent can find
  with `list_tasks`.
- Definition of done: which checks must be green before a PR is opened.
- Who transitions Jira issues, the agent or the human, and at which point.
