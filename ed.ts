/**
 * Ed Extension - explicit one-shot prompt rewriter
 *
 * Unlike mudpi (which rewrites your draft continuously while you type),
 * ed rewrites on demand. `/ed` works as a standalone token anywhere in the
 * message, so you can finish typing a draft and append it:
 *
 *   /ed make the loader thing not crash on syntax errs and log it
 *   make the loader thing not crash on syntax errs and log it /ed
 *   make the loader thing not crash on syntax errs /ed more formal, mention the file
 *
 * Text before the token is the rough draft; text after it is an optional
 * editing instruction applied to the draft.
 *
 * The rough prompt is rewritten once (using recent conversation context to
 * resolve references), shown as a preview, and you accept or dismiss it.
 * Accept puts the rewritten prompt in the editor for review before sending;
 * dismiss puts your original rough text back in the editor instead. Either
 * way nothing is sent and nothing is lost.
 *
 * `/ed` without arguments opens a multi-line editor to compose the rough
 * prompt.
 *
 * Config:
 *   ED_MODEL=provider/model-id   (default: openai-codex/gpt-5.5, no reasoning)
 *
 * Usage:
 * 1. Copy or symlink this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. /ed <rough prompt>
 */

import { stream, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL_ID = "gpt-5.5";
const MAX_TOKENS = 900;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_USER_TURNS = 6;

const SYSTEM_PROMPT = [
	"You rewrite an in-progress user prompt for a coding agent.",
	"Use recent conversation context only to resolve references, pronouns, and implied targets.",
	"Preserve the user's intent, constraints, technical details, paths, code, identifiers, and tone.",
	"Do not answer the prompt. Do not add requirements that are not implied by the draft or context.",
	"Return only the rewritten prompt text. No preamble, no explanation, no markdown fence.",
].join("\n");

function resolveModelOverride(): { provider: string; modelId: string } {
	const raw = process.env.ED_MODEL;
	if (!raw) return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID };
	const slash = raw.indexOf("/");
	if (slash === -1) return { provider: DEFAULT_PROVIDER, modelId: raw };
	return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`[tool call: ${block.name}]`);
		}
	}
	return parts.join("\n");
}

function buildRecentConversationText(entries: SessionEntry[]): string {
	const selected: string[] = [];
	let userTurns = 0;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "message" || !isRecord(entry.message)) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = contentToText(entry.message.content).trim();
		if (!content) continue;
		selected.push(`${role === "user" ? "User" : "Assistant"}: ${content}`);
		if (role === "user") {
			userTurns++;
			if (userTurns >= MAX_USER_TURNS) break;
		}
	}

	const text = selected.reverse().join("\n\n");
	if (text.length <= MAX_CONTEXT_CHARS) return text;
	return `${text.slice(0, MAX_CONTEXT_CHARS)}\n[truncated ${text.length - MAX_CONTEXT_CHARS} chars]`;
}

function buildRewritePrompt(draft: string, instruction: string, recentConversation: string): string {
	return [
		"Rewrite the draft prompt into a clearer prompt for the coding agent.",
		"Use the recent conversation only as context for references in the draft.",
		instruction
			? `Follow this editing instruction from the user: ${instruction}`
			: "If the draft is already clear, return it unchanged.",
		"",
		"<recent_conversation>",
		recentConversation || "(none)",
		"</recent_conversation>",
		"",
		"<draft_prompt>",
		draft,
		"</draft_prompt>",
	].join("\n");
}

/**
 * Find a standalone `/ed` token (whitespace-delimited, last occurrence wins).
 * Text before it is the draft; text after it is an optional editing instruction.
 */
function parseEdToken(text: string): { draft: string; instruction: string } | undefined {
	const re = /(^|\s)\/ed(?=\s|$)/g;
	let last: RegExpExecArray | undefined;
	for (let match = re.exec(text); match !== null; match = re.exec(text)) {
		last = match;
	}
	if (!last) return undefined;

	const tokenStart = last.index + last[1].length;
	const draft = text.slice(0, tokenStart).trim();
	const instruction = text.slice(tokenStart + "/ed".length).trim();
	if (!draft && !instruction) return undefined;
	// "/ed <text>" with nothing before the token: the trailing text is the draft.
	if (!draft) return { draft: instruction, instruction: "" };
	return { draft, instruction };
}

type EdPreviewResult = { type: "accept"; text: string } | { type: "reject" } | { type: "abort" };

/**
 * Title-less preview dialog that the rewrite streams into as it arrives.
 * While streaming, escape aborts. Once complete, the Accept/Reject selector
 * activates; escape rejects.
 */
async function streamRewritePreview(ctx: ExtensionContext, draft: string, instruction: string): Promise<EdPreviewResult> {
	const override = resolveModelOverride();
	const model = ctx.modelRegistry.find(override.provider, override.modelId) ?? ctx.model;
	if (!model) {
		ctx.ui.notify(`Model not found: ${override.provider}/${override.modelId} (and no session model)`, "error");
		return { type: "abort" };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		ctx.ui.notify(auth.ok ? `No API key for ${model.provider}/${model.id}` : auth.error, "error");
		return { type: "abort" };
	}
	const apiKey = auth.apiKey;
	const headers = auth.headers;

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: buildRewritePrompt(draft, instruction, buildRecentConversationText(ctx.sessionManager.getBranch())),
			},
		],
		timestamp: Date.now(),
	};

	return ctx.ui.custom<EdPreviewResult>((tui, theme, _kb, done) => {
		let text = "";
		let streaming = true;
		let acceptSelected = true;
		let cached: string[] | undefined;
		const controller = new AbortController();

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		const finishStreaming = (finalText: string) => {
			if (!finalText) {
				ctx.ui.notify("Rewrite returned no text", "error");
				done({ type: "abort" });
				return;
			}
			text = finalText;
			streaming = false;
			refresh();
		};

		(async () => {
			let streamed = "";
			try {
				const events = stream(
					model,
					{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey, headers, maxTokens: MAX_TOKENS, reasoningEffort: "none", signal: controller.signal },
				);
				for await (const event of events) {
					if (controller.signal.aborted) return;
					if (event.type === "text_delta") {
						streamed += event.delta;
						text = streamed;
						refresh();
					} else if (event.type === "done") {
						finishStreaming(streamed.trim() || contentToText(event.message.content).trim());
						return;
					} else if (event.type === "error") {
						ctx.ui.notify(`Rewrite failed: ${event.error.errorMessage ?? event.reason}`, "error");
						done({ type: "abort" });
						return;
					}
				}
				finishStreaming(streamed.trim());
			} catch (err) {
				if (controller.signal.aborted) return;
				ctx.ui.notify(`Rewrite failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				done({ type: "abort" });
			}
		})();

		function handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) {
				if (streaming) {
					controller.abort();
					done({ type: "abort" });
				} else {
					done({ type: "reject" });
				}
				return;
			}
			if (streaming) return;
			if (
				matchesKey(data, Key.left) ||
				matchesKey(data, Key.right) ||
				matchesKey(data, Key.tab) ||
				matchesKey(data, Key.up) ||
				matchesKey(data, Key.down)
			) {
				acceptSelected = !acceptSelected;
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(acceptSelected ? { type: "accept", text } : { type: "reject" });
			}
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
			const body = streaming ? `${text}▌` : text;
			for (const raw of body.split("\n")) {
				for (const line of wrapTextWithAnsi(raw.length > 0 ? raw : " ", Math.max(1, width - 2))) {
					add(` ${theme.fg("accent", line)}`);
				}
			}
			lines.push("");
			if (streaming) {
				add(theme.fg("dim", " rewriting… · esc abort"));
			} else {
				const accept = acceptSelected ? theme.fg("success", "▸ Accept") : theme.fg("muted", "  Accept");
				const reject = acceptSelected ? theme.fg("muted", "  Reject") : theme.fg("error", "▸ Reject");
				add(` ${accept}    ${reject}`);
				lines.push("");
				add(theme.fg("dim", " ←/→ switch · enter confirm · esc reject"));
			}
			add(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));

			cached = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
			dispose: () => {
				controller.abort();
			},
		};
	});
}

async function runEdFlow(ctx: ExtensionContext, draft: string, instruction: string, original: string): Promise<void> {
	const result = await streamRewritePreview(ctx, draft, instruction);
	if (result.type === "abort") {
		// Aborted or failed: restore exactly what the user typed, /ed token and
		// all, as if nothing happened.
		ctx.ui.setEditorText(original);
		return;
	}
	if (result.type === "reject") {
		ctx.ui.setEditorText(draft);
		ctx.ui.notify("Kept your original text", "info");
		return;
	}
	ctx.ui.setEditorText(result.text);
	ctx.ui.notify("Rewrite accepted · review and submit · undo: ctrl+-", "info");
}

// Same boundaries as parseEdToken, applied per rendered line. The lookahead
// also accepts ESC so the token stays highlighted while the cursor (rendered
// as an ANSI inverse-video block) sits directly behind it.
const ED_TOKEN_RENDER_RE = /(^|\s)(\/ed)(?=\s|$|\x1b)/g;
const ANSI_RESET = "\x1b[0m";

// Ghost hint shown after a trailing `/ed` token; any keypress changes the
// text and the condition below stops matching, which drops the ghost.
const ED_GHOST_TEXT = "prettify";
const ED_GHOST_COLOR = "\x1b[90m"; // dim gray
const ED_GHOST_CONDITION_RE = /(^|\s)\/ed$/;
/** How the Editor renders an end-of-text cursor: inverse-video space. */
const ED_CURSOR_AT_END = "\x1b[7m \x1b[0m";

/**
 * Insert the ghost right after the end-of-text cursor block, consuming an
 * equal run of padding spaces so the line width stays unchanged.
 */
function injectGhost(line: string): string {
	const cursorIdx = line.lastIndexOf(ED_CURSOR_AT_END);
	if (cursorIdx === -1) return line;
	const insertAt = cursorIdx + ED_CURSOR_AT_END.length;
	const tail = line.slice(insertAt);
	const paddingSpaces = /^ */.exec(tail)?.[0].length ?? 0;
	if (paddingSpaces < ED_GHOST_TEXT.length) return line;
	return `${line.slice(0, insertAt)}${ED_GHOST_COLOR}${ED_GHOST_TEXT}${ANSI_RESET}${tail.slice(ED_GHOST_TEXT.length)}`;
}
const ED_BASE_RGB: [number, number, number] = [230, 150, 80]; // orange
const ED_PULSE_FRAMES = 24;
const ED_FRAME_MS = 80;

function edTokenColor(frame: number): string {
	// Brightness pulses toward white on a sine wave (~2s period).
	const phase = (frame % ED_PULSE_FRAMES) / ED_PULSE_FRAMES;
	const factor = 0.3 + 0.3 * Math.sin(phase * 2 * Math.PI);
	const [r, g, b] = ED_BASE_RGB.map((c) => Math.round(c + (255 - c) * factor));
	return `\x1b[1;38;2;${r};${g};${b}m`;
}

/** Marks factories created by wrapEditorWithColorizer so re-runs don't stack wrappers. */
const ED_WRAPPED = Symbol("ed-colorized-editor");

function wrapEditorWithColorizer(ctx: ExtensionContext): void {
	const inner = ctx.ui.getEditorComponent();
	if (inner && ED_WRAPPED in inner) return;

	const wrapped: EditorFactory = (tui, theme, keybindings) => {
		const editor = inner ? inner(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
		const render = editor.render.bind(editor);
		let timer: ReturnType<typeof setInterval> | undefined;
		let frame = 0;
		let lastRenderAt = 0;

		const stopTimer = () => {
			if (!timer) return;
			clearInterval(timer);
			timer = undefined;
		};

		editor.render = (width: number) => {
			lastRenderAt = Date.now();
			let hasToken = false;
			const color = edTokenColor(frame);
			const showGhost = ED_GHOST_CONDITION_RE.test(editor.getText());
			const lines = render(width).map((line) => {
				const colorized = line.replace(ED_TOKEN_RENDER_RE, (_match, lead: string, token: string) => {
					hasToken = true;
					return `${lead}${color}${token}${ANSI_RESET}`;
				});
				return showGhost ? injectGhost(colorized) : colorized;
			});
			// The timer's lifecycle is driven by what's on screen: animate while
			// the token is visible, stop when it disappears. EditorComponent has
			// no dispose hook, so a replaced editor stops its own orphaned timer
			// once renders stop coming.
			if (hasToken && !timer) {
				timer = setInterval(() => {
					if (Date.now() - lastRenderAt > 2_000) {
						stopTimer();
						return;
					}
					frame++;
					tui.requestRender();
				}, ED_FRAME_MS);
			} else if (!hasToken) {
				stopTimer();
			}
			return lines;
		};
		return editor;
	};
	Object.defineProperty(wrapped, ED_WRAPPED, { value: true });
	ctx.ui.setEditorComponent(wrapped);
}

export default function edExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Defer one tick so this wraps whatever editor component other
		// extensions (e.g. mudpi) install during the same session_start.
		setTimeout(() => wrapEditorWithColorizer(ctx), 0);
	});

	// Catches `/ed` mid-message: "<draft> /ed" or "<draft> /ed <instruction>".
	// Such messages don't start with "/", so they arrive as regular input.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !ctx.hasUI) return { action: "continue" };
		const parsed = parseEdToken(event.text);
		if (!parsed) return { action: "continue" };
		if (event.images?.length) {
			ctx.ui.notify("Attached images are not carried through /ed; re-attach after accepting", "warning");
		}
		await runEdFlow(ctx, parsed.draft, parsed.instruction, event.text);
		return { action: "handled" };
	});

	pi.registerCommand("ed", {
		description: "Rewrite a rough prompt once, preview it, accept or dismiss",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			let draft = args.trim();
			let instruction = "";
			let original = draft ? `/ed ${draft}` : "";
			if (!draft) {
				const composed = await ctx.ui.editor("Rough prompt to rewrite");
				if (composed === undefined || !composed.trim()) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				draft = composed.trim();
				original = draft;
			} else {
				// Args may themselves contain a token: "/ed <draft> /ed <instruction>"
				// degenerates to the same parse as mid-message usage.
				const parsed = parseEdToken(draft);
				if (parsed) {
					draft = parsed.draft;
					instruction = parsed.instruction;
				}
			}

			await runEdFlow(ctx, draft, instruction, original);
		},
	});
}
