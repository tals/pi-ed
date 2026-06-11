# pi-ed

Type a rough prompt as you always do, add `/ed` with optional rewrite instructions, and watch the brainrot melt away!

Works on [pi](https://github.com/earendil-works/pi).


- Text before `/ed` is the draft.
- Text after `/ed` is an optional editing instruction.

## Installation

```sh
pi install npm:pi-ed-extension
```

Install from GitHub:

```sh
pi install https://github.com/tals/pi-ed
```

## Example

In
```text
lets build `ed`. what it does is quickly edit the prompts i type and make them better using instructiond igive u.
iot lets me accept and reject. if acept replace prompt cotenty othewise go back so i can try again /ed prettify and make bullets
```

Out:
```
Build `ed`: a tool that quickly edits the prompts I type and improves them based on instructions I
provide.

Requirements:
- Let me enter a prompt and editing instructions.
- Generate an improved version of the prompt according to those instructions.
- Let me accept or reject the improved version.
- If I accept, replace the original prompt content with the improved version.
- If I reject, return to the original prompt so I can try again.
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `ED_MODEL` | session model | Rewrite model. Use `provider/model-id`, or a bare model id to keep the session provider. |

Reasoning effort is disabled for the rewrite call.
