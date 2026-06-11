# pi-ed

Explicit one-shot prompt rewriter for [pi](https://github.com/badlogic/pi-mono).

Type a rough prompt, add `/ed`, and `pi-ed` rewrites it into a clearer prompt. You get an Accept/Reject preview before anything is sent to the agent.

## Installation

> **Package naming:** the npm package name is `pi-ed`; the GitHub repository is `tals/ed`. They differ, so use the source-specific names below.

Install from npm:

```sh
pi install npm:pi-ed
```

Install from GitHub:

```sh
pi install https://github.com/tals/ed
```

Install from a local checkout for development:

```sh
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/ed.ts" ~/.pi/agent/extensions/ed.ts
```

For a single project instead of global install:

```sh
mkdir -p .pi/extensions
ln -sf "$PWD/ed.ts" .pi/extensions/ed.ts
```

After installing while pi is already running, use `/reload` or restart pi.

## Usage

Add `/ed` as a standalone token anywhere in your draft:

```text
make the loader thing not crash on syntax errs /ed
make the loader thing not crash on syntax errs /ed more formal, mention the file
/ed make the loader thing not crash on syntax errs
```

How parsing works:

- Text before `/ed` is the draft.
- Text after `/ed` is an optional editing instruction.
- If `/ed` comes first, the rest of the message is treated as the draft.
- Running `/ed` by itself opens a multi-line editor.

## What happens

1. `pi-ed` rewrites the draft once using the current session model by default.
2. Recent conversation turns are included as context so references like “it” or “that file” can be resolved.
3. The rewrite streams into a preview.
4. Accept puts the rewritten prompt back in the editor for review.
5. Reject, abort, or error restores exactly what you typed.

Nothing is auto-sent. You always review before submitting, and `ctrl+-` can undo after accepting.

## Editor niceties

- `/ed` is highlighted in the prompt editor.
- A dim `prettify` ghost hint appears when the draft ends with `/ed`.
- Attached images are not carried through the rewrite flow; re-attach them after accepting.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `ED_MODEL` | session model | Rewrite model. Use `provider/model-id`, or a bare model id to keep the session provider. |

Reasoning effort is disabled for the rewrite call.

## Uninstall

If installed as a pi package:

```sh
pi remove npm:pi-ed
```

If installed by symlink, remove the symlink from `~/.pi/agent/extensions/` or `.pi/extensions/`.
