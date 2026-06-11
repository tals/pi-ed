# pi-ed

Explicit one-shot prompt rewriter extension for [pi](https://github.com/badlogic/pi-mono).

Type a rough prompt, append `/ed`, and it gets rewritten into a clear prompt
(by default with the session's selected model, reasoning disabled), previewed
with Accept/Reject before anything is sent.

```
make the loader thing not crash on syntax errs /ed
make the loader thing not crash on syntax errs /ed more formal, mention the file
/ed make the loader thing not crash on syntax errs
```

- Text before the `/ed` token is the draft; text after it is an optional editing
  instruction.
- The token is highlighted (animated pulse) in the prompt editor, with a dim
  `prettify` ghost hint while the draft ends with `/ed`.
- Abort/error restores exactly what you typed, token included. Reject restores
  the draft with the token stripped. Accept puts the rewrite in the editor for
  review — nothing is ever auto-sent, and `ctrl+-` undoes.
- Recent conversation turns are passed as context so references like "it" and
  "that file" resolve.

## Install

```sh
ln -s "$PWD/ed.ts" ~/.pi/agent/extensions/ed.ts
```

or per-project: `ln -s "$PWD/ed.ts" <project>/.pi/extensions/ed.ts`

## Config

| Env var | Default | |
|---|---|---|
| `ED_MODEL` | session model | `provider/model-id` for the rewrite (bare model id keeps the session provider) |
