import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
// Pi loads every top-level extensions/*.ts file as a factory, so test modules
// must remain below this non-entry directory.
import askUserQuestion from "../extensions/context-seeker.ts";

interface RegisteredTool {
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: any,
	) => Promise<unknown>;
	renderCall?: (args: any, theme: any) => { render(width: number): string[] };
	renderResult?: (result: any, options: any, theme: any) => { render(width: number): string[] };
}

interface HerdrBlockedEvent {
	active: boolean;
	label?: string;
}

interface RenderScenario {
	inputs?: string[];
	widths?: number[];
	rows?: number | number[];
	focused?: boolean;
}

const WIDTH = 34;
const NARROW_WIDTH = 20;
const LABEL_END_MARKER = "LABEL_END";
const DESCRIPTION_END_MARKER = "DESCRIPTION_END";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const CTRL_ENTER = "\x1b[13;5u";
const CTRL_C = "\x03";
const CTRL_R = "\x12";
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

const longOption = {
	label: `A deliberately long option label whose final words are ${LABEL_END_MARKER}`,
	value: "long-option",
	description:
		`This descriptive paragraph is intentionally wider than the question panel so it must wrap cleanly.\n` +
		`Its second paragraph must remain readable through ${DESCRIPTION_END_MARKER}.`,
};

/**
 * Register the real extension against the smallest API surface needed by these
 * execution tests. Testing through the public tool execution seam catches both
 * standalone and tabbed custom UIs without exporting production-only internals.
 */
function registerTools(
	blockedEvents: HerdrBlockedEvent[] = [],
	persistedEntries: any[] = [],
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, any>();
	const messageRenderers = new Map<string, any>();
	const sentMessages: any[] = [];
	let sendMessageError: Error | undefined;
	const pi = {
		registerTool(tool: RegisteredTool & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerMessageRenderer(customType: string, renderer: any) { messageRenderers.set(customType, renderer); },
		on(name: string, handler: any) { hooks.set(name, handler); },
		sendMessage(message: any, options: any) {
			if (sendMessageError) throw sendMessageError;
			sentMessages.push({ message, options });
		},
		appendEntry(customType: string, data: unknown) {
			persistedEntries.push({ type: "custom", customType, data });
		},
		events: {
			emit(name: string, data: HerdrBlockedEvent) {
				if (name === "herdr:blocked") blockedEvents.push(data);
			},
			on() {
				// This extension only emits shared events.
			},
		},
	} as unknown as ExtensionAPI;

	askUserQuestion(pi);
	Object.assign(tools, {
		commands,
		hooks,
		messageRenderers,
		sentMessages,
		setSendMessageError(error: Error | undefined) { sendMessageError = error; },
	});
	return tools;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A tiny adapter for the exact injected keybinding interface used by the list. */
const keybindings = {
	matches(data: string, binding: string): boolean {
		switch (binding) {
			case "tui.select.up":
				return data === "\x1b[A" || data === "k";
			case "tui.select.down":
				return data === DOWN || data === "j";
			case "tui.select.confirm":
				return data === "\r";
			case "tui.select.cancel":
				return data === "\x1b";
			default:
				return false;
		}
	},
};

/**
 * Render with real ANSI styling, optionally drive input, then render at every
 * requested width. Returning each snapshot lets tests inspect cursor/window
 * transitions rather than merely checking the initial frame.
 */
async function captureToolRender(
	tool: RegisteredTool,
	params: unknown,
	scenario: RenderScenario = {},
): Promise<string[][]> {
	const snapshots: string[][] = [];
	const widths = scenario.widths ?? [WIDTH];
	const rowHeights = Array.isArray(scenario.rows) ? scenario.rows : widths.map(() => scenario.rows ?? 80);
	const style = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
	const colorCodes: Record<string, number> = {
		text: 37,
		muted: 90,
		dim: 2,
		accent: 35,
		success: 32,
		warning: 33,
		borderMuted: 90,
	};
	const theme = {
		fg: (color: string, text: string) => style(colorCodes[color] ?? 37, text),
		bg: (_color: string, text: string) => style(44, text),
		bold: (text: string) => style(1, text),
	};
	const tui = {
		requestRender() {},
		terminal: { rows: rowHeights[0] ?? 80, columns: Math.max(...widths) },
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: {
			async custom(factory: any) {
				const component = factory(tui, theme, keybindings, () => {});
				if (scenario.focused) component.focused = true;
				snapshots.push(component.render(widths[0]));
				for (const input of scenario.inputs ?? []) {
					component.handleInput(input);
					snapshots.push(component.render(widths[0]));
				}
				for (let index = 1; index < widths.length; index++) {
					tui.terminal.rows = rowHeights[index] ?? rowHeights[0] ?? 80;
					snapshots.push(component.render(widths[index]!));
				}
				return null;
			},
		},
	};

	await tool.execute("render-regression", params, undefined, undefined, ctx);
	assert.ok(snapshots.length > 0, "the tool should render a custom question UI");
	return snapshots;
}

function plainText(lines: string[]): string {
	return lines.join("\n").replace(ANSI_SGR, "").replaceAll(CURSOR_MARKER, "");
}

function assertStableFrameGeometry(frames: string[][], anchor: (line: string) => boolean, scenario: string): void {
	const lineCounts = frames.map((frame) => frame.length);
	assert.ok(lineCounts.every((count) => count === lineCounts[0]), `${scenario}: frame line count should stay fixed`);
	const anchorRows = frames.map((frame) => frame.map((line) => line.replace(ANSI_SGR, "")).findLastIndex(anchor));
	assert.ok(anchorRows.every((row) => row >= 0), `${scenario}: stable anchor should remain visible`);
	assert.ok(anchorRows.every((row) => row === anchorRows[0]), `${scenario}: stable anchor should keep its vertical position`);
}

/** Drive a real custom UI to completion and retain frames for focus assertions. */
async function executeCustomUI(tool: RegisteredTool, params: unknown, inputs: string[]) {
	const snapshots: string[][] = [];
	const submissions: unknown[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui = {
		requestRender() {},
		terminal: { rows: 40, columns: WIDTH },
	};
	const result = await tool.execute("note-interaction", params, undefined, undefined, {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: {
			custom: async (factory: any) => {
				let value: unknown;
				const component = factory(tui, theme, keybindings, (submitted: unknown) => {
					value = submitted;
					submissions.push(submitted);
				});
				snapshots.push(component.render(WIDTH));
				for (const input of inputs) {
					component.handleInput(input);
					snapshots.push(component.render(WIDTH));
				}
				return value;
			},
		},
	});
	return { result: result as any, snapshots, submissions };
}

function assertLongContentIsReadable(lines: string[], width: number, scenario: string): void {
	assert.ok(
		lines.every((line) => visibleWidth(line) <= width),
		`${scenario}: every rendered line must fit the UI width`,
	);
	const compact = plainText(lines).replace(/\s/g, "");
	assert.ok(compact.includes(LABEL_END_MARKER), `${scenario}: the complete option label should be visible after wrapping`);
	assert.ok(compact.includes(DESCRIPTION_END_MARKER), `${scenario}: the complete multi-paragraph description should be visible after wrapping`);
}

function fillerOptions(count: number): Array<{ label: string; value: string; description: string }> {
	return Array.from({ length: count }, (_, index) => ({
		label: `Filler option ${index + 1}`,
		value: `filler-${index + 1}`,
		description: `Description for filler option ${index + 1}`,
	}));
}

const tools = registerTools();
const askOne = tools.get("ask_user_question");
const askMany = tools.get("ask_questions");
assert.ok(askOne, "ask_user_question should be registered");
assert.ok(askMany, "ask_questions should be registered");

const singleContract = askOne as any;
const batchContract = askMany as any;
assert.match(singleContract.promptGuidelines.join("\n"), /distinct viable options/i);
assert.match(singleContract.promptGuidelines.join("\n"), /exactly one.*recommended/i);
assert.match(batchContract.promptGuidelines.join("\n"), /distinct viable options/i);
assert.match(batchContract.promptGuidelines.join("\n"), /at most one.*recommended/i);
assert.match(JSON.stringify(singleContract.parameters), /at most one[^"}]*recommended/i);
assert.match(JSON.stringify(batchContract.parameters), /at most one[^"}]*recommended/i);

for (const scenario of [
	{
		name: "single",
		tool: askOne,
		params: { question: "Invalid recommendations", options: [{ label: "First", recommended: true }, { label: "Second (Recommended)" }] },
		error: /ask_user_question.*at most one recommended option.*retry/i,
	},
	{
		name: "batch",
		tool: askMany,
		params: { questions: [{ question: "Valid", options: [{ label: "Only", recommended: true }] }, { question: "Invalid", options: [{ label: "First", recommended: true }, { label: "Second", recommended: true }] }] },
		error: /ask_questions question 2.*at most one recommended option.*retry/i,
	},
] as const) {
	let uiOpened = false;
	await assert.rejects(
		scenario.tool.execute("multiple-recommendations", scenario.params, undefined, undefined, {
			hasUI: true,
			mode: "tui",
			ui: { custom: async () => { uiOpened = true; return null; } },
		}),
		scenario.error,
	);
	assert.equal(uiOpened, false, `${scenario.name}: malformed recommendations must be rejected before opening the UI`);
}

await assert.rejects(
	askOne.execute(
		"empty-option",
		{ question: "Invalid", options: [{ label: "   " }] },
		undefined,
		undefined,
		{ hasUI: true },
	),
	/requires at least one non-empty option/,
);
await assert.rejects(
	askMany.execute(
		"empty-batch-option",
		{ questions: [{ question: "Invalid", options: [{ label: "   " }] }] },
		undefined,
		undefined,
		{ hasUI: true },
	),
	/question 1 requires at least one non-empty option/,
);

const transcriptTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const singleCallTranscript = askOne.renderCall!(
	{ question: "Which approach?", options: [{ label: "Native" }] },
	transcriptTheme,
).render(80).join("\n").trimEnd();
assert.equal(singleCallTranscript, "? Which approach?");
assert.doesNotMatch(singleCallTranscript, /ask_user_question|\[single\]|Options:/);

const singleResultTranscript = askOne.renderResult!(
	{
		details: {
			status: "answered",
			question: "Which approach?",
			mode: "single-select",
			answers: [{ type: "other", label: "Keep it native", value: "Keep it native" }],
		},
	},
	{},
	transcriptTheme,
).render(80).join("\n").trimEnd();
assert.equal(singleResultTranscript, "✓ Keep it native");
assert.doesNotMatch(singleResultTranscript, /Other:|Which approach\?/);

const batchCallTranscript = askMany.renderCall!(
	{ questions: [{ question: "First?" }, { question: "Second?" }] },
	transcriptTheme,
).render(80).join("\n").trimEnd();
assert.match(batchCallTranscript, /^\? 2 questions for you/);
assert.doesNotMatch(batchCallTranscript, /ask_questions|Single Choice|Multi-Choice/);

const batchModelResult = await askMany.execute(
	"batch-model-context",
	{
		questions: [
			{ question: "Pick one", options: [{ label: "Alpha" }] },
			{ question: "Explain", options: [{ label: "Because it is simpler" }] },
		],
	},
	undefined,
	undefined,
	{
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: {
			custom: async () => [
				{
					questionIndex: 0,
					answer: { type: "option", label: "Alpha", value: "Alpha", index: 1 },
					note: "Preferred",
				},
				{
					questionIndex: 1,
					answer: { type: "option", label: "Because it is simpler", value: "Because it is simpler", index: 1 },
					note: "",
				},
			],
		},
	},
) as { content: Array<{ type: string; text: string }> };
assert.match(batchModelResult.content[0]!.text, /Q1: Pick one\nAnswer: 1\. Alpha\nNote: Preferred/);
assert.match(batchModelResult.content[0]!.text, /Q2: Explain\nAnswer: 1\. Because it is simpler/);

// Omitting options opens the same native multiline editor used throughout the
// questionnaire instead of forcing narrative answers into a choice list.
const standaloneFreeForm = await executeCustomUI(
	askOne,
	{ question: "Tell me about a time you changed your mind", details: "Share as much detail as is useful." },
	["I started with one approach.", "\n", "Then evidence changed my mind.", "\r"],
);
assert.equal(standaloneFreeForm.result.details.mode, "text");
assert.deepEqual(standaloneFreeForm.result.details.answers[0], {
	type: "text",
	label: "I started with one approach.\nThen evidence changed my mind.",
	value: "I started with one approach.\nThen evidence changed my mind.",
});
assert.match(standaloneFreeForm.result.content[0]!.text, /User answered: I started with one approach\.\nThen evidence changed my mind\./);
const freeFormFrame = plainText(standaloneFreeForm.snapshots.at(-2)!);
assert.match(freeFormFrame, /Shift\+Enter new/);
assert.ok(freeFormFrame.split("\n").every((line) => visibleWidth(line) <= WIDTH));

const blankFreeForm = await executeCustomUI(
	askOne,
	{ question: "A required answer" },
	["   ", "\r", "Now answered", "\r"],
);
assert.match(plainText(blankFreeForm.snapshots[2]!), /Answer required\./);
assert.equal(blankFreeForm.submissions.length, 1);

const constrainedFreeForm = await captureToolRender(
	askOne,
	{ question: "Describe a long experience" },
	{
		inputs: ["one", "\n", "two", "\n", "three", "\n", "four", "\n", "five"],
		rows: 8,
		focused: true,
	},
);
const constrainedFreeFormFrame = constrainedFreeForm.at(-1)!;
assert.ok(constrainedFreeFormFrame.length <= 8);
assert.ok(constrainedFreeFormFrame.some((line) => line.includes(CURSOR_MARKER)));
assert.match(plainText(constrainedFreeFormFrame), /Enter submit/);

const narrowFreeForm = await captureToolRender(
	askOne,
	{ question: "Describe" },
	{ inputs: ["x"], widths: [2, 1], focused: true },
);
assert.match(plainText(narrowFreeForm[1]!), /x/);
assert.ok(narrowFreeForm[1]!.some((line) => line.includes(CURSOR_MARKER)));
// At width 1, the native Editor's end cursor needs a second visible cell, so
// neither that cursor cell nor its hardware marker can validly fit in the frame.
assert.ok(!narrowFreeForm.at(-1)!.some((line) => line.includes(CURSOR_MARKER)));
assert.ok(narrowFreeForm.at(-1)!.every((line) => visibleWidth(line) <= 1));

const batchFreeForm = await executeCustomUI(
	askMany,
	{
		questions: [
			{ question: "Describe your experience", label: "Experience" },
			{ question: "Choose a follow-up", label: "Follow-up", options: [{ label: "Continue" }] },
		],
	},
	["First part", "\n", "Second part", "\r", "\r", "\r", "\r"],
);
assert.equal(batchFreeForm.result.details.questions[0].mode, undefined, "public question definitions omit internal tab mode");
assert.equal(batchFreeForm.result.details.answers[0].answer, "First part\nSecond part");
assert.match(batchFreeForm.result.content[0]!.text, /Q1: Describe your experience\nAnswer: First part\nSecond part/);

const narrowBatchFreeForm = await captureToolRender(
	askMany,
	{ questions: [{ question: "Describe" }] },
	{ inputs: ["x"], widths: [2, 1], focused: true },
);
assert.match(plainText(narrowBatchFreeForm[1]!), /x/);
assert.ok(narrowBatchFreeForm[1]!.some((line) => line.includes(CURSOR_MARKER)));
assert.ok(narrowBatchFreeForm.at(-1)!.every((line) => visibleWidth(line) <= 1));

const largeFreeFormPaste = "p".repeat(1001);
const bracketedFreeFormPaste = `\x1b[200~${largeFreeFormPaste}\x1b[201~`;
const standalonePastedFreeForm = await executeCustomUI(
	askOne,
	{ question: "Describe the full log" },
	[bracketedFreeFormPaste, "\r"],
);
assert.equal(standalonePastedFreeForm.result.details.answers[0].value, largeFreeFormPaste);

const batchPastedFreeForm = await executeCustomUI(
	askMany,
	{ questions: [{ question: "Describe the full log" }] },
	[bracketedFreeFormPaste, "\r", "\r"],
);
assert.equal(batchPastedFreeForm.result.details.answers[0].answer, largeFreeFormPaste);

// Optional notes use one native Editor across standalone modes. Tab visibly moves
// focus to the note and Ctrl+Enter submits without sacrificing the typed draft.
const standaloneNote = await executeCustomUI(
	askOne,
	{ question: "Choose with a note", options: [{ label: "Native" }] },
	[TAB, "Keep this inline", CTRL_ENTER],
);
assert.match(plainText(standaloneNote.snapshots[1]!), /Note \(optional\):/);
assert.match(plainText(standaloneNote.snapshots[2]!), /Keep this[\s\S]*inline/);
assert.match(plainText(standaloneNote.snapshots[2]!), /→ \( \) 1\. Native/);
assert.match(standaloneNote.result.content[0]!.text, /User selected: 1\. Native\nNote: Keep this inline/);
assert.equal(standaloneNote.result.details.note, "Keep this inline");
const singleNoteFrame = plainText(standaloneNote.snapshots[2]!);
const singleNoteLabelLine = singleNoteFrame.split("\n").findIndex((line) => line.includes("Note (optional):"));
const singleNoteTextLine = singleNoteFrame.split("\n").findIndex((line) => line.includes("Keep this"));
assert.equal(singleNoteTextLine, singleNoteLabelLine, "note text should begin on its label line");
assert.match(singleNoteFrame.split("\n")[singleNoteTextLine]!, /^ {3}Note \(optional\): Keep this/);
assert.match(singleNoteFrame.split("\n").find((line) => line.includes("inline"))!, /^ {20}inline/, "wrapped note text aligns beneath its content");

// Plain Enter is harmless inside notes; Shift+Enter/Ctrl+J creates a newline,
// and Ctrl+Enter submits the complete multiline value.
const multilineNote = await executeCustomUI(
	askOne,
	{ question: "Add multiline context", options: [{ label: "Native" }] },
	[TAB, "first", "\r", " line", "\n", "second", CTRL_ENTER],
);
assert.equal(multilineNote.result.details.note, "first line\nsecond");
assert.match(multilineNote.result.content[0]!.text, /Note: first line\nsecond/);

const standaloneMultiNote = await executeCustomUI(
	askOne,
	{ question: "Choose several", options: [{ label: "Alpha" }], multiSelect: true },
	[" ", TAB, "Multi note", CTRL_ENTER],
);
assert.match(standaloneMultiNote.result.content[0]!.text, /User selected:\n- 1\. Alpha\nNote: Multi note/);
assert.equal(standaloneMultiNote.result.details.note, "Multi note");
const multiNoteFrame = plainText(standaloneMultiNote.snapshots[3]!);
const multiNoteTextLine = multiNoteFrame.split("\n").find((line) => line.includes("Note (optional):"));
assert.match(multiNoteTextLine!, /^ {7}Note \(optional\): Multi/);
assert.match(multiNoteFrame.split("\n").find((line) => line.includes("note"))!, /^ {24}note/);

const noEmptyMultiSubmit = await executeCustomUI(
	askOne,
	{ question: "Require a selection", options: [{ label: "Alpha" }], multiSelect: true },
	[CTRL_ENTER, " ", CTRL_ENTER],
);
assert.match(plainText(noEmptyMultiSubmit.snapshots[1]!), /Select an answer\./);
assert.equal(noEmptyMultiSubmit.submissions.length, 1, "Ctrl+Enter must not submit an empty multi-selection");
assert.equal((noEmptyMultiSubmit.result.details.answers[0] as any).label, "Alpha");

// Moving from inline Other to the note commits the custom-answer draft before
// Ctrl+Enter, so neither the answer nor the note is dropped.
for (const multiSelect of [false, true]) {
	const otherWithNote = await executeCustomUI(
		askOne,
		{ question: "Other with note", options: [{ label: "Preset" }], multiSelect },
		["2", "Custom answer", TAB, "Keep note", CTRL_ENTER],
	);
	assert.equal(otherWithNote.result.details.answers.at(-1)!.label, "Custom answer");
	assert.equal(otherWithNote.result.details.note, "Keep note");
}

// Submitting from a note while Other is still empty returns keyboard focus to
// the custom editor rather than leaving a visually active but unreachable row.
const stagedOptionBeatsCachedOther = await executeCustomUI(
	askOne,
	{ question: "Keep the staged option", options: [{ label: "Preset" }] },
	["2", "old custom", "\r", "\x1b", "1", DOWN, TAB, CTRL_ENTER],
);
assert.equal(stagedOptionBeatsCachedOther.result.details.answers[0].label, "Preset");

const emptyOtherAfterNote = await executeCustomUI(
	askOne,
	{ question: "Fill Other after note", options: [{ label: "Preset" }] },
	["2", TAB, "Note first", CTRL_ENTER, "Custom after note", "\r", "\r"],
);
assert.equal(emptyOtherAfterNote.result.details.answers[0].label, "Custom after note");
assert.equal(emptyOtherAfterNote.result.details.note, "Note first");

const emptyMultiOtherAfterNote = await executeCustomUI(
	askOne,
	{ question: "Fill multi Other after note", options: [{ label: "Preset" }], multiSelect: true },
	["2", TAB, "Note first", CTRL_ENTER, "Custom after note", "\r", CTRL_ENTER],
);
assert.equal(emptyMultiOtherAfterNote.result.details.answers[0].label, "Custom after note");
assert.equal(emptyMultiOtherAfterNote.result.details.note, "Note first");

const abandonedMultiOther = await executeCustomUI(
	askOne,
	{ question: "Abandon multi Other", options: [{ label: "Preset" }], multiSelect: true },
	["2", "abandoned", "\x1b", "\x1b[A", " ", TAB, "Normal option note", CTRL_ENTER],
);
assert.deepEqual(abandonedMultiOther.result.details.answers.map((answer: any) => answer.label), ["Preset"]);
assert.equal(abandonedMultiOther.result.details.note, "Normal option note");

// Escape returns to the primary control instead of cancelling a note draft;
// the next Tab restores the same draft and its focused visual treatment.
const noteEscapeSnapshots = await captureToolRender(
	askOne,
	{ question: "Preserve note", options: [{ label: "Keep focus" }] },
	{ inputs: [TAB, "draft note", "\x1b", TAB] },
);
assert.match(plainText(noteEscapeSnapshots.at(-1)!), /Note \(optional\):\s+draft note/);

const batchNote = await executeCustomUI(
	askMany,
	{ questions: [{ question: "Batch choice", options: [{ label: "Alpha" }] }] },
	[TAB, "Batch note", TAB, "\r", "\r", "\r"],
);
assert.match(plainText(batchNote.snapshots[1]!), /Note \(optional\):/);
assert.match(plainText(batchNote.snapshots[3]!), /→ \( \) 1\. Alpha/);
assert.match(plainText(batchNote.snapshots[4]!), /→ \(●\) 1\. Alpha/);
assert.match(plainText(batchNote.snapshots[5]!), /Review your answers[\s\S]*Note: Batch note/);
assert.match(plainText(batchNote.snapshots[5]!), /Enter Submit/);
assert.match(batchNote.result.content[0]!.text, /Q1: Batch choice\nAnswer: 1\. Alpha\nNote: Batch note/);
assert.equal(batchNote.result.details.answers[0].note, "Batch note");

// Tab and Shift+Tab both provide a reversible answer ↔ note focus cycle.
const reverseFocus = await captureToolRender(
	askOne,
	{ question: "Reverse focus", options: [{ label: "Primary" }] },
	{ inputs: [SHIFT_TAB, "draft", SHIFT_TAB], widths: [80] },
);
assert.match(plainText(reverseFocus[1]!), /Note \(optional\):/);
assert.doesNotMatch(plainText(reverseFocus.at(-1)!), /Note \(optional\):/);
assert.match(plainText(reverseFocus.at(-1)!), /draft/);
assert.match(plainText(reverseFocus.at(-1)!), /→ \( \) 1\. Primary/);

// Focusing and typing one-line inline fields must not move the footer or any
// following row. Newlines and wrapping remain free to expand naturally.
for (const scenario of [
	{
		name: "standalone single-select",
		tool: askOne,
		params: { question: "Stable fields", options: [{ label: "Preset" }] },
	},
	{
		name: "standalone multi-select",
		tool: askOne,
		params: { question: "Stable fields", options: [{ label: "Preset" }], multiSelect: true },
	},
	{
		name: "batch single-select",
		tool: askMany,
		params: { questions: [{ question: "Stable fields", options: [{ label: "Preset" }] }] },
	},
	{
		name: "batch multi-select",
		tool: askMany,
		params: { questions: [{ question: "Stable fields", options: [{ label: "Preset" }], multiSelect: true }] },
	},
]) {
	const customFrames = await captureToolRender(scenario.tool, scenario.params, {
		inputs: ["2", "one line"],
		widths: [80],
	});
	assertStableFrameGeometry(
		customFrames,
		(line) => line.includes("+ Add note (optional)"),
		`${scenario.name} custom answer`,
	);
	assert.match(plainText(customFrames[1]!), /Something else…[\s\S]*(?:Typing|Editing)/);
	assert.doesNotMatch(plainText(customFrames[1]!), /Editing custom answer/);

	const noteFrames = await captureToolRender(scenario.tool, scenario.params, {
		inputs: [TAB, "one line"],
		widths: [80],
	});
	assertStableFrameGeometry(noteFrames, (line) => /^─+$/.test(line), `${scenario.name} context note`);
	assert.match(plainText(noteFrames[1]!), /Note \(optional\):/);
	assert.match(plainText(noteFrames[2]!), /Note \(optional\):\s+one line/);

	const narrowCustomFrames = await captureToolRender(scenario.tool, scenario.params, {
		inputs: ["2", "short"],
		widths: [NARROW_WIDTH],
		focused: true,
	});
	assertStableFrameGeometry(
		narrowCustomFrames,
		(line) => /^─+$/.test(line),
		`${scenario.name} narrow custom answer`,
	);
	assert.ok(
		narrowCustomFrames.every((frame) => frame.every((line) => visibleWidth(line) <= NARROW_WIDTH)),
		`${scenario.name}: narrow custom rows must honor the width`,
	);
	assert.match(plainText(narrowCustomFrames[2]!), /short/);
	assert.ok(
		narrowCustomFrames[2]!.some((line) => line.includes("short") && line.includes(CURSOR_MARKER)),
		`${scenario.name}: narrow custom editor must retain the IME cursor marker`,
	);

	const narrowNoteFrames = await captureToolRender(scenario.tool, scenario.params, {
		inputs: [TAB, "ok"],
		widths: [NARROW_WIDTH],
		focused: true,
	});
	assertStableFrameGeometry(narrowNoteFrames, (line) => /^─+$/.test(line), `${scenario.name} narrow context note`);
	const activeNarrowNote = narrowNoteFrames[2]!;
	const noteTextRow = activeNarrowNote.find((line) => line.includes("ok"));
	assert.ok(noteTextRow, `${scenario.name}: narrow context must show typed text`);
	assert.ok(noteTextRow.includes(CURSOR_MARKER), `${scenario.name}: narrow context must retain the IME cursor marker`);
	assert.ok(
		activeNarrowNote.every((line) => visibleWidth(line) <= NARROW_WIDTH),
		`${scenario.name}: narrow context rows must honor the width`,
	);
	assert.match(plainText(activeNarrowNote), /(?:Note|N):\s+ok/);
}

const extremeCustomFrames = await captureToolRender(
	askOne,
	{ question: "Tiny custom", options: [{ label: "Preset" }] },
	{ inputs: ["2", "x"], widths: [9], focused: true },
);
assertStableFrameGeometry(extremeCustomFrames, (line) => /^─+$/.test(line), "extremely narrow custom answer");
const extremeCustomRow = extremeCustomFrames[2]!.find((line) => line.includes("x"));
assert.ok(extremeCustomRow?.includes(CURSOR_MARKER), "extremely narrow custom input and IME cursor must remain visible");
assert.ok(extremeCustomFrames.every((frame) => frame.every((line) => visibleWidth(line) <= 9)));

// Multiline context may consume the body budget, but height clipping must keep
// the active editor cursor and footer visible in every question host.
for (const scenario of [
	{
		name: "standalone single-select",
		tool: askOne,
		params: { question: "Constrained context", options: [{ label: "Preset" }] },
	},
	{
		name: "standalone multi-select",
		tool: askOne,
		params: { question: "Constrained context", options: [{ label: "Preset" }], multiSelect: true },
	},
	{
		name: "batch single-select",
		tool: askMany,
		params: { questions: [{ question: "Constrained context", options: [{ label: "Preset" }] }] },
	},
	{
		name: "batch multi-select",
		tool: askMany,
		params: { questions: [{ question: "Constrained context", options: [{ label: "Preset" }], multiSelect: true }] },
	},
]) {
	const frames = await captureToolRender(scenario.tool, scenario.params, {
		inputs: [TAB, "first", "\n", "second", "\n", "cursor tail"],
		widths: [20],
		rows: 12,
		focused: true,
	});
	const activeFrame = frames.at(-1)!;
	assert.ok(
		activeFrame.some((line) => line.includes(CURSOR_MARKER)),
		`${scenario.name}: constrained multiline context must retain its active cursor row`,
	);
	assert.match(plainText(activeFrame), /cursor\s+tail/, `${scenario.name}: the final context line must remain visible`);
	assert.ok(activeFrame.length <= 12, `${scenario.name}: multiline context must fit the terminal height`);
	assert.ok(
		plainText(activeFrame).split("\n").some((line) => /(?:Note\s+[•·]|Editing\s+[•·])/.test(line)),
		`${scenario.name}: context footer must remain visible after clipping`,
	);
}

// Single-select Enter stages a choice. A second Enter advances. The final
// confirmed answer opens Review, where Submit is visible but has not happened.
const readinessFrames = await captureToolRender(
	askMany,
	{
		questions: [
			{ question: "First readiness", options: [{ label: "One" }] },
			{ question: "Second readiness", options: [{ label: "Two" }] },
		],
	},
	{ inputs: ["\r", "\r", TAB, "context", TAB, "\r", "\r"], widths: [80] },
);
assert.match(plainText(readinessFrames[0]!), /Enter Select/);
assert.doesNotMatch(plainText(readinessFrames[0]!), /\d+ (?:unanswered|left)|Regenerate unanswered/);
assert.match(plainText(readinessFrames[0]!), /Tab Add note[\s\S]*←→ Questions/);
assert.doesNotMatch(plainText(readinessFrames[0]!), /Ctrl\+Enter|jump to review/i);
assert.match(plainText(readinessFrames[1]!), /\(●\) 1\. One[\s\S]*Enter Next[\s\S]*Ctrl\+Enter Review answered[\s\S]*Ctrl\+R Regenerate unanswered/);
assert.match(plainText(readinessFrames[2]!), /Q2: Second readiness[\s\S]*Ctrl\+Enter Review answered[\s\S]*Ctrl\+R Regenerate unanswered/);
assert.match(plainText(readinessFrames.at(-1)!), /Review your answers[\s\S]*Note: context/);
assert.match(plainText(readinessFrames.at(-1)!), /Enter Submit/);

// A one-question batch still requires Review and a second explicit Enter.
const enterToSubmit = await executeCustomUI(
	askMany,
	{ questions: [{ question: "Enter submit", options: [{ label: "Selected answer" }] }] },
	["\r", "\r", "\r"],
);
assert.match(plainText(enterToSubmit.snapshots[1]!), /\(●\) 1\. Selected answer/);
assert.match(plainText(enterToSubmit.snapshots[2]!), /Review your answers[\s\S]*Enter Submit/);
assert.equal((enterToSubmit.result.details.answers[0].answer as any).label, "Selected answer");

// Selection state is independent from cursor position and survives Back.
const radioState = await captureToolRender(
	askMany,
	{
		questions: [
			{ question: "Choose a radio", options: [{ label: "Chosen" }] },
			{ question: "Second", options: [{ label: "Next" }] },
		],
	},
	{ inputs: ["\r", "\r", LEFT, DOWN], widths: [80] },
);
const radioFrame = plainText(radioState.at(-1)!);
assert.match(radioFrame, /  \(●\) 1\. Chosen/);
assert.match(radioFrame, /→ \( \) 2\. Something else…/);

// Standalone single choices stage before they submit. Moving the cursor does
// not move the radio, and Enter on another row replaces the staged answer.
const standaloneTwoStep = await executeCustomUI(
	askOne,
	{ question: "Two-step choice", options: [{ label: "Alpha" }, { label: "Beta" }] },
	["\r", DOWN, "\r", "\r"],
);
assert.equal(standaloneTwoStep.submissions.length, 1);
assert.match(plainText(standaloneTwoStep.snapshots[1]!), /→ \(●\) 1\. Alpha/);
assert.match(plainText(standaloneTwoStep.snapshots[2]!), /  \(●\) 1\. Alpha[\s\S]*→ \( \) 2\. Beta/);
assert.match(plainText(standaloneTwoStep.snapshots[3]!), /  \( \) 1\. Alpha[\s\S]*→ \(●\) 2\. Beta/);
assert.equal(standaloneTwoStep.result.details.answers[0].label, "Beta");

const standaloneEscapeClear = await executeCustomUI(
	askOne,
	{ question: "Clear a choice", options: [{ label: "Alpha" }] },
	["1", "\x1b", "1", "1"],
);
assert.match(plainText(standaloneEscapeClear.snapshots[1]!), /\(●\) 1\. Alpha/);
assert.match(plainText(standaloneEscapeClear.snapshots[2]!), /\( \) 1\. Alpha/);
assert.equal(standaloneEscapeClear.submissions.length, 1);

const standaloneStagedToCustomEscape = await captureToolRender(
	askOne,
	{ question: "Replace staged with custom", options: [{ label: "Alpha" }] },
	{ inputs: ["1", DOWN, "\r", "retained draft", "\x1b", "\r"], widths: [80] },
);
const standaloneStagedToCustomEscapeFrame = plainText(standaloneStagedToCustomEscape.at(-1)!);
assert.match(standaloneStagedToCustomEscapeFrame, /\( \) 1\. Alpha/);
assert.doesNotMatch(standaloneStagedToCustomEscapeFrame, /\(●\)/);
assert.match(standaloneStagedToCustomEscapeFrame, /retained draft/);

const batchStagedToCustomEscape = await captureToolRender(
	askMany,
	{ questions: [{ question: "Batch replace staged", options: [{ label: "Alpha" }] }] },
	{ inputs: ["1", DOWN, "\r", "retained batch draft", "\x1b", "\r"], widths: [80] },
);
const batchStagedToCustomEscapeFrame = plainText(batchStagedToCustomEscape.at(-1)!);
assert.match(batchStagedToCustomEscapeFrame, /\( \) 1\. Alpha/);
assert.doesNotMatch(batchStagedToCustomEscapeFrame, /\(●\)/);
assert.match(batchStagedToCustomEscapeFrame, /retained batch draft/);

const standaloneCustomTwoStep = await executeCustomUI(
	askOne,
	{ question: "Custom two-step", options: [{ label: "Preset" }] },
	["2", "retained draft", "\x1b", "\r", "\r", "\x1b", "\r", "\r", "\r"],
);
assert.match(plainText(standaloneCustomTwoStep.snapshots[4]!), /retained draft/);
assert.match(plainText(standaloneCustomTwoStep.snapshots[5]!), /\(●\) 2\. Something else… —[\s\S]*retained draft/);
assert.match(plainText(standaloneCustomTwoStep.snapshots[6]!), /\( \) 2\. Something else…/);
assert.match(plainText(standaloneCustomTwoStep.snapshots[7]!), /retained draft/);
assert.equal(standaloneCustomTwoStep.result.details.answers[0].label, "retained draft");

// Ctrl+C clears active answer editors without closing them. This applies to
// standalone and batch custom answers and to the shared open-text editor path.
for (const scenario of [
	{ name: "standalone custom", tool: askOne, params: { question: "Standalone custom", options: [{ label: "Preset" }] }, inputs: ["2"] },
	{ name: "standalone multi custom", tool: askOne, params: { question: "Standalone multi custom", options: [{ label: "Preset" }], multiSelect: true }, inputs: ["2"] },
	{ name: "batch custom", tool: askMany, params: { questions: [{ question: "Batch custom", options: [{ label: "Preset" }] }] }, inputs: ["2"] },
	{ name: "batch multi custom", tool: askMany, params: { questions: [{ question: "Batch multi custom", options: [{ label: "Preset" }], multiSelect: true }] }, inputs: ["2"] },
	{ name: "standalone text", tool: askOne, params: { question: "Standalone text" }, inputs: [] },
	{ name: "batch text", tool: askMany, params: { questions: [{ question: "Batch text" }, { question: "Second", options: [{ label: "Next" }] }] }, inputs: [] },
]) {
	const frames = await captureToolRender(scenario.tool, scenario.params, {
		inputs: [...scenario.inputs, "UNIQUE_CLEAR_DRAFT", CTRL_C],
		widths: [80],
		focused: true,
	});
	const cleared = plainText(frames.at(-1)!);
	assert.doesNotMatch(cleared, /UNIQUE_CLEAR_DRAFT/, `${scenario.name}: Ctrl+C clears the editor`);
	assert.ok(frames.at(-1)!.some((line) => line.includes(CURSOR_MARKER)), `${scenario.name}: editor remains active after clear`);
}

// Open text answers expose and support both advancing and direct question navigation.
const textNavigation = await captureToolRender(
	askMany,
	{ questions: [{ question: "First open" }, { question: "Second choice", options: [{ label: "Next" }] }] },
	{ inputs: ["preserved answer", RIGHT, LEFT], widths: [34], focused: true },
);
assert.match(plainText(textNavigation[0]!), /Enter Next[\s\S]*Tab Add note[\s\S]*←→\s+Questions/);
assert.match(plainText(textNavigation[2]!), /Enter Review/, "the last question advances to Review rather than Next");
assert.match(plainText(textNavigation[2]!), /Q2: Second choice/);
assert.match(plainText(textNavigation.at(-1)!), /Q1: First open[\s\S]*preserved answer/);

const simplifiedChoices = plainText((await captureToolRender(
	askMany,
	{ questions: [{ question: "Only concrete choices", options: [{ label: "Preset" }] }] },
))[0]!);
assert.match(simplifiedChoices, /1\. Preset[\s\S]*2\. Something else…/);
assert.doesNotMatch(simplifiedChoices, /Ask the agent|What do you think\?|Give me more options/);

// Esc cancels an untouched batch immediately. Once work exists, cancellation
// requires two consecutive Esc presses; any other key clears the warning.
const cancellationEntries: any[] = [];
const cancellationTools: any = registerTools([], cancellationEntries);
const untouchedBatchCancel = await executeCustomUI(
	cancellationTools.get("ask_questions")!,
	{ questions: [{ question: "Untouched cancel", options: [{ label: "Alpha" }] }] },
	["\x1b", "\x1b"],
);
assert.equal(untouchedBatchCancel.result.details.status, "cancelled");
assert.equal(untouchedBatchCancel.submissions.length, 1);
assert.equal(cancellationTools.commands.has("resume-questions"), false);
assert.equal(cancellationTools.messageRenderers.has("ask-questions-resumed"), false);
assert.deepEqual(cancellationEntries, [], "cancelled batches should not persist hidden resume state");

const armedBatchCancel = await executeCustomUI(
	askMany,
	{ questions: [{ question: "Confirm cancel", options: [{ label: "Alpha" }] }] },
	["1", "\x1b", "\x1b"],
);
assert.match(plainText(armedBatchCancel.snapshots[2]!), /Esc again to cancel/);
assert.equal(armedBatchCancel.result.details.status, "cancelled");
assert.equal(armedBatchCancel.submissions.length, 1);

for (const [name, inputs] of [
	["note", [TAB, "cancel note", "\x1b", "\x1b", "\x1b"]],
	["custom draft", ["2", "cancel draft", "\x1b", "\x1b", "\x1b"]],
] as const) {
	const cancelled = await executeCustomUI(
		askMany,
		{ questions: [{ question: `Cancel ${name}`, options: [{ label: "Alpha" }] }] },
		[...inputs, "\x1b"],
	);
	assert.equal(cancelled.result.details.status, "cancelled", `${name} should preserve two-step cancellation after work`);
}

// Enter on a saved custom multi-answer reopens it for in-place editing; Space
// remains the explicit remove/toggle action.
const reeditCustom = await captureToolRender(
	askMany,
	{
		questions: [{
			question: "Re-edit custom",
			options: [{ label: "Preset" }],
			multiSelect: true,
		}],
	},
	{ inputs: ["2", "saved custom", "\r", "\r"], widths: [80] },
);
assert.match(plainText(reeditCustom.at(-1)!), /(?:Typing\s+•\s+Enter save|Editing\s+·\s+Enter Save)/);
assert.match(plainText(reeditCustom.at(-1)!), /saved custom/);
assert.match(plainText(reeditCustom.at(-1)!), /\[x\] 2\. Something else…/);

// Space removes and reselects a saved custom value without unexpectedly
// opening its editor; Enter remains the dedicated re-edit gesture.
const toggleSavedCustom = await captureToolRender(
	askMany,
	{
		questions: [{
			question: "Toggle saved custom",
			options: [{ label: "Preset" }],
			multiSelect: true,
		}],
	},
	{ inputs: ["2", "cached custom", "\r", " ", " "], widths: [80] },
);
const toggledCustomFrame = plainText(toggleSavedCustom.at(-1)!);
assert.match(toggledCustomFrame, /\[x\] 2\. Something else…/);
assert.match(toggledCustomFrame, /cached custom/);
assert.doesNotMatch(toggledCustomFrame, /(?:Typing\s+•\s+Enter save|Editing\s+·\s+Enter Save)/);

const customRowHint = await captureToolRender(
	askMany,
	{
		questions: [{
			question: "Custom hint",
			options: [{ label: "Preset" }],
			multiSelect: true,
		}],
	},
	{ inputs: [DOWN], widths: [80] },
);
assert.match(plainText(customRowHint.at(-1)!), /Space Edit · Enter Edit/);

const standaloneCustomRowHint = await captureToolRender(
	askOne,
	{ question: "Standalone custom hint", options: [{ label: "Preset" }], multiSelect: true },
	{ inputs: [DOWN], widths: [80] },
);
assert.match(plainText(standaloneCustomRowHint.at(-1)!), /Space edit • Enter edit/);

// The active tab and status stay visible when a narrow viewport can show only
// a small moving window of a larger batch.
const narrowTabWindow = await captureToolRender(
	askMany,
	{
		questions: Array.from({ length: 8 }, (_, index) => ({
			question: `Window ${index + 1}`,
			options: [{ label: `Choice ${index + 1}` }],
		})),
	},
	{ inputs: Array.from({ length: 7 }, () => RIGHT), widths: [20] },
);
const finalTabWindow = plainText(narrowTabWindow.at(-1)!);
assert.match(finalTabWindow, /‹/);
assert.match(finalTabWindow, /○ Q8/);
assert.doesNotMatch(finalTabWindow, /Q1/);

const semanticProgress = await captureToolRender(
	askMany,
	{
		questions: Array.from({ length: 6 }, (_, index) => ({
			label: ["Auth", "Data", "API", "UI", "Tests", "Deploy"][index],
			question: `Semantic ${index + 1}`,
			options: [{ label: "Yes" }],
		})),
	},
	{ inputs: Array.from({ length: 5 }, () => RIGHT), widths: [36] },
);
const semanticFrame = plainText(semanticProgress.at(-1)!);
assert.match(semanticFrame, /Deploy/);
assert.match(semanticFrame, /Review/);
assert.match(semanticFrame, /‹/);
assert.doesNotMatch(semanticFrame.split("\n").slice(0, 3).join("\n"), /Q6/);

// Semantic progress labels use available width adaptively: ordinary terminals
// retain complete two-word labels, while constrained terminals compact inactive
// questions instead of taking space away from the active label.
const adaptiveLabels = ["Custom answer", "Narrow terminal", "Multiline input"];
const adaptiveProgress = await captureToolRender(
	askMany,
	{
		questions: adaptiveLabels.map((label, index) => ({
			label,
			question: `Adaptive ${index + 1}`,
			options: [{ label: "Yes" }],
		})),
	},
	{ inputs: [RIGHT, RIGHT], widths: [80, 34, 15] },
);
for (const [index, label] of adaptiveLabels.entries()) {
	const progressLine = plainText(adaptiveProgress[index]!).split("\n")[1]!;
	assert.match(progressLine, new RegExp(label), `${label} should remain complete when active at normal width`);
}
const constrainedProgressLine = plainText(adaptiveProgress.at(-2)!).split("\n")[1]!;
assert.match(constrainedProgressLine, /○2/);
assert.match(constrainedProgressLine, /Multiline input/);
assert.match(constrainedProgressLine, /Review/);
assert.ok(visibleWidth(adaptiveProgress.at(-2)![1]!) <= 34);

const veryNarrowProgressLine = plainText(adaptiveProgress.at(-1)!).split("\n")[1]!;
assert.match(veryNarrowProgressLine, /Mult…/);
assert.doesNotMatch(veryNarrowProgressLine, /\.\.\./);
assert.match(veryNarrowProgressLine, /Review/);
assert.ok(visibleWidth(adaptiveProgress.at(-1)![1]!) <= 15);

const extremeProgress = await captureToolRender(
	askMany,
	{
		questions: [
			{ label: "🇺🇸 setup", question: "Unicode label", options: [{ label: "Yes" }] },
			{ label: "Second step", question: "Second label", options: [{ label: "Yes" }] },
		],
	},
	{ inputs: [TAB, "active note", TAB], widths: [80, 11] },
);
const extremeProgressLine = plainText(extremeProgress.at(-1)!).split("\n")[1]!;
assert.match(extremeProgressLine, /○ … ○Review/);
assert.doesNotMatch(extremeProgressLine, /•/, "active note chrome yields to the active step and Review at extreme widths");
assert.equal(visibleWidth(extremeProgress.at(-1)![1]!), 11);

const extremeWidths = [8, 7, 6, 5, 4, 3, 2, 1];
const minimumProgress = await captureToolRender(
	askMany,
	{
		questions: [
			{ label: "Active semantic label", question: "First", options: [{ label: "Yes" }] },
			{ label: "Later", question: "Second", options: [{ label: "Yes" }] },
		],
	},
	{ widths: extremeWidths },
);
for (const [index, width] of extremeWidths.entries()) {
	const frame = minimumProgress[index]!;
	const progressLine = plainText(frame).split("\n")[1]!;
	assert.ok(frame.every((line) => visibleWidth(line) <= width), `width ${width} lines must fit the terminal`);
	assert.doesNotMatch(progressLine, /Active/, `width ${width} drops the semantic label before a status`);
	if (width >= 2) {
		assert.equal(progressLine.match(/○/g)?.length, 2, `width ${width} keeps active and Review statuses`);
	} else {
		assert.equal(progressLine, "○", "a one-column terminal keeps the active status when both cannot fit");
	}
}
assert.equal(plainText(minimumProgress[0]!).split("\n")[1], "○○Review");
assert.equal(plainText(minimumProgress.at(-2)!).split("\n")[1], "○○");

const tinyReview = await captureToolRender(
	askMany,
	{ questions: [{ question: "Finish", options: [{ label: "Yes" }] }] },
	{ inputs: ["\r"], widths: [3, 2, 1] },
);
for (const [frame, width] of tinyReview.slice(1).map((frame, index) => [frame, 3 - index] as const)) {
	assert.ok(frame.every((line) => visibleWidth(line) <= width), `active Review lines fit width ${width}`);
	assert.match(plainText(frame).split("\n")[1]!, /^✓/, `active Review keeps its status at width ${width}`);
}

const graphemeProgress = await captureToolRender(
	askMany,
	{ questions: [{ label: "🇺🇸 setup", question: "Unicode label", options: [{ label: "Yes" }] }] },
	{ widths: [14] },
);
assert.match(plainText(graphemeProgress[0]!).split("\n")[1]!, /🇺🇸 …/);

// Optional context is collapsed until focused, while low terminal height limits
// the number of option rows retained in the viewport.
const constrained = await captureToolRender(
	askOne,
	{ question: "Height aware", options: fillerOptions(10) },
	{ rows: 12, widths: [32] },
);
const constrainedFrame = plainText(constrained[0]!);
assert.match(constrainedFrame, /\+ Add note \(optional\)/);
assert.doesNotMatch(constrainedFrame, /Note \(optional\):/);
assert.ok((constrainedFrame.match(/Filler option/g) ?? []).length <= 3, "terminal rows should constrain the option viewport");
assert.ok(constrained[0]!.length <= 12, "standalone chrome and choices fit short terminals");
assert.ok(constrained[0]!.every((line) => visibleWidth(line) <= 32));

for (const multiSelect of [false, true]) {
	const longFrame = await captureToolRender(
		askOne,
		{
			question: "A deliberately wrapped standalone question that consumes several lines before choices",
			details: "Long details also wrap across the narrow panel and must be included in the host line budget.",
			options: [longOption, ...fillerOptions(4)],
			multiSelect,
		},
		{ rows: 14, widths: [24] },
	);
	assert.ok(longFrame[0]!.length <= 14, `standalone ${multiSelect ? "multi" : "single"} full frame fits terminal rows`);
}

for (const multiSelect of [false, true]) {
	const longBatchFrame = await captureToolRender(
		askMany,
		{
			questions: [{
				question: "A wrapped batch question consuming host chrome",
				details: "Long batch details wrap before descriptions and still leave the footer inside the terminal.",
				options: [longOption, ...fillerOptions(4)],
				multiSelect,
			}],
		},
		{ rows: 14, widths: [24] },
	);
	assert.ok(longBatchFrame[0]!.length <= 14, `batch ${multiSelect ? "multi" : "single"} full frame fits terminal rows`);
}

const constrainedBatchQuestion = await captureToolRender(
	askMany,
	{ questions: [{ question: "Short batch", options: fillerOptions(8) }] },
	{ rows: 12, widths: [32] },
);
assert.ok(constrainedBatchQuestion[0]!.length <= 12, "batch question chrome and choices fit short terminals");
assert.match(plainText(constrainedBatchQuestion[0]!), /Enter Sele/);

const twentyFourRows = await captureToolRender(
	askOne,
	{ question: "Wrapped at 24 rows", options: fillerOptions(8) },
	{ rows: [80, 24], widths: [24, 24] },
);
assert.ok(twentyFourRows[1]!.length <= 24, "height-only resize recomputes the 24-row option viewport");
assert.match(plainText(twentyFourRows[1]!), /↓ more/);

const reviewViewport = await captureToolRender(
	askMany,
	{
		questions: Array.from({ length: 5 }, (_, index) => ({
			question: `Review item ${index + 1}`,
			options: [{ label: `Answer ${index + 1}` }],
		})),
	},
	{ rows: 12, inputs: [...Array.from({ length: 10 }, () => "\r"), ...Array.from({ length: 30 }, () => DOWN)], widths: [36] },
);
const firstReview = plainText(reviewViewport[10]!);
assert.match(firstReview, /Review your answers/);
assert.match(firstReview, /↓ more/);
assert.match(firstReview, /Enter Submit/);
assert.ok(reviewViewport[10]!.length <= 12, "Review keeps its Submit footer visible within terminal rows");
assert.match(plainText(reviewViewport.at(-1)!), /Review item 5|Answer 5/);

const veryShortReview = await captureToolRender(
	askMany,
	{ questions: [{ question: "Tiny review", options: [{ label: "Confirmed" }] }] },
	{ rows: [6, 7, 8, 9], inputs: ["\r", "\r"], widths: [24, 24, 24, 24] },
);
for (const [index, frame] of veryShortReview.slice(-4).entries()) {
	const rows = index + 6;
	assert.ok(frame.length <= rows, `${rows}-row review must fit the terminal height`);
	assert.ok(frame.every((line) => visibleWidth(line) <= 24), `${rows}-row review lines must fit the terminal width`);
	assert.match(plainText(frame), /Enter Submit/, `${rows}-row review should preserve the submit affordance`);
}

// Ctrl+Enter explicitly reviews answered questions and marks the rest skipped.
const partialSubmission = await executeCustomUI(
	askMany,
	{
		questions: [
			{ question: "Open answer", options: undefined },
			{ question: "Needs an answer", options: [{ label: "Two" }] },
		],
	},
	["draft response", CTRL_ENTER, "\r"],
);
const partialReviewFrame = plainText(partialSubmission.snapshots.at(-1)!);
assert.match(partialReviewFrame, /Review 1 answer · 1 skipped/);
assert.match(partialReviewFrame, /draft response/);
assert.match(partialReviewFrame, /\(skipped\)/);
assert.match(partialReviewFrame, /Enter Submit/);
assert.equal(partialSubmission.result.details.status, "answered");
assert.deepEqual(partialSubmission.result.details.skippedQuestionIndexes, [1]);
assert.match(partialSubmission.result.content[0].text, /User submitted 1 answer and skipped 1 question/);
assert.match(partialSubmission.result.content[0].text, /Q2: Needs an answer\nAnswer: \(skipped by user\)/);
const partialTranscript = askMany.renderResult!(partialSubmission.result, {}, transcriptTheme).render(80).join("\n");
assert.match(partialTranscript, /✓ 1 answer · 1 skipped/);
assert.match(partialTranscript, /Needs an answer\s+\(skipped\)/);

const whitespacePartialSubmission = await executeCustomUI(
	askMany,
	{ questions: [{ question: "Answered text" }, { question: "Whitespace draft" }] },
	["kept", "\r", "   ", CTRL_ENTER, "\r"],
);
assert.match(plainText(whitespacePartialSubmission.snapshots.at(-1)!), /Whitespace draft[\s\S]*\(skipped\)/);
assert.deepEqual(whitespacePartialSubmission.result.details.skippedQuestionIndexes, [1]);
const whitespacePartialTranscript = askMany.renderResult!(whitespacePartialSubmission.result, {}, transcriptTheme).render(80).join("\n");
assert.match(whitespacePartialTranscript, /Whitespace draft\s+\(skipped\)/);
assert.doesNotMatch(whitespacePartialTranscript, /empty response/);

const emptyPartialReview = await captureToolRender(
	askMany,
	{ questions: [{ question: "Still unanswered" }, { question: "Also unanswered" }] },
	{ inputs: [CTRL_ENTER], widths: [80] },
);
assert.match(plainText(emptyPartialReview.at(-1)!), /Still unanswered[\s\S]*Answer a question first\./);
assert.doesNotMatch(plainText(emptyPartialReview.at(-1)!), /Review \d+ answers/);

const partialReviewBack = await captureToolRender(
	askMany,
	{ questions: [{ question: "Answered first" }, { question: "First skipped" }, { question: "Also skipped" }] },
	{ inputs: ["ready", CTRL_ENTER, "\x1b"], widths: [80] },
);
assert.match(plainText(partialReviewBack.at(-1)!), /Q2: First skipped/);
assert.doesNotMatch(plainText(partialReviewBack.at(-1)!), /Review 1 answer/);

const batchNoteTranscript = askMany.renderResult!(batchNote.result, {}, transcriptTheme).render(80).join("\n");
assert.match(batchNoteTranscript, /1  Batch choice\s+Alpha\s+Note\s+Batch note/);
assert.doesNotMatch(batchNoteTranscript, /ask_questions/);

const wrappedBatchTranscript = askMany.renderResult!(
	{
		details: {
			status: "answered",
			questions: [{ question: "Question lead words that wrap onto Q_CONT" }],
			answers: [{
				questionIndex: 0,
				answer: "Answer lead words that wrap onto A_CONT",
				note: "Note lead words that wrap onto N_CONT",
			}],
		},
	},
	{},
	transcriptTheme,
).render(24).join("\n");
const wrappedTranscriptLines = wrappedBatchTranscript.split("\n");
assert.match(wrappedTranscriptLines.find((line) => line.includes("Q_CONT"))!, /^ {5}/);
assert.match(wrappedTranscriptLines.find((line) => line.includes("A_CONT"))!, /^ {5}/);
assert.match(wrappedTranscriptLines.find((line) => line.includes("N_CONT"))!, /^ {7}/);

const wrappedReview = await captureToolRender(
	askMany,
	{ questions: [{ question: "Review question lead words wrapping onto QR_CONT" }] },
	{ inputs: ["Review answer lead words wrapping onto AR_CONT", "\r"], widths: [24], focused: true },
);
const wrappedReviewLines = plainText(wrappedReview.at(-1)!).split("\n");
assert.match(wrappedReviewLines.find((line) => line.includes("QR_CONT"))!, /^ {3}/);
assert.match(wrappedReviewLines.find((line) => line.includes("AR_CONT"))!, /^ {3}/);

// Each batch tab owns its own note draft while sharing the same focus cycle.
const batchTabNotes = await executeCustomUI(
	askMany,
	{
		questions: [
			{ question: "First", options: [{ label: "One" }] },
			{ question: "Second", options: [{ label: "Two" }] },
		],
	},
	[TAB, "first note", TAB, "\r", "\r", TAB, "second note", TAB, "\r", "\r", "\r"],
);
assert.equal(batchTabNotes.result.details.answers[0].note, "first note");
assert.equal(batchTabNotes.result.details.answers[1].note, "second note");
assert.match(batchTabNotes.result.content[0]!.text, /Note: first note/);
assert.match(batchTabNotes.result.content[0]!.text, /Note: second note/);

const batchOtherNotes = await executeCustomUI(
	askMany,
	{
		questions: [
			{ question: "Single Other", options: [{ label: "Preset" }] },
			{ question: "Multi Other", options: [{ label: "Preset" }], multiSelect: true },
		],
	},
	[TAB, "First note", TAB, "2", "First custom", "\r", "\r", TAB, "Second note", TAB, "2", "Second custom", "\r", "\x1b[A", "\r", "\r"],
);
assert.equal((batchOtherNotes.result.details.answers[0].answer as any).label, "First custom");
assert.equal((batchOtherNotes.result.details.answers[1].answer as any)[0].label, "Second custom");
assert.equal(batchOtherNotes.result.details.answers[0].note, "First note");
assert.equal(batchOtherNotes.result.details.answers[1].note, "Second note");

const regenerateEntries: any[] = [];
const regenerateBatch = registerTools([], regenerateEntries).get("ask_questions")!;
const regenerateParams = {
	questions: [
		{ question: "Resolved choice", options: [{ label: "Alpha" }] },
		{ question: "Needs regeneration", details: "Original context", options: [{ label: "Beta" }] },
	],
};
const regenerated = await executeCustomUI(regenerateBatch, regenerateParams, ["\r", TAB, "important note", CTRL_R]);
assert.equal(regenerated.result.details.status, "regenerate");
assert.equal(regenerated.result.details.answers.length, 1);
assert.equal(regenerated.result.details.answers[0].questionIndex, 0);
assert.equal(regenerated.result.details.answers[0].note, "important note");
assert.deepEqual(regenerated.result.details.unansweredQuestions, [{
	question: "Needs regeneration",
	details: "Original context",
	options: [{ label: "Beta" }],
}]);
assert.match(regenerated.result.content[0].text, /Do not repeat resolved questions/);
assert.match(regenerated.result.content[0].text, /Immediately call ask_questions again with regenerated unanswered questions only/);
assert.match(regenerated.result.content[0].text, /Unanswered Q2: Needs regeneration/);
assert.match(regenerated.result.content[0].text, /Details: Original context/);
assert.match(regenerated.result.content[0].text, /Answer mode: single-select \(choose one choice\)/);
assert.match(regenerated.result.content[0].text, /Choices:\n- Beta/);

const regenerateActionFrames = await captureToolRender(regenerateBatch, regenerateParams, {
	inputs: ["\r", TAB, TAB, TAB],
	widths: [80],
});
assert.match(plainText(regenerateActionFrames[1]!), /Ctrl\+R Regenerate unanswered/);
assert.doesNotMatch(plainText(regenerateActionFrames.at(-1)!), /→ .*Regenerate unanswered|Tab action|Enter activate/);
assert.ok(regenerateActionFrames.flat().every((line) => visibleWidth(line) <= 80));

const responsiveWidths = [80, 50, 34, 20];
const responsiveActionFrames = await captureToolRender(regenerateBatch, regenerateParams, {
	inputs: ["\r"],
	widths: responsiveWidths,
	rows: responsiveWidths.map(() => 40),
});
for (const [index, width] of responsiveWidths.entries()) {
	const frame = responsiveActionFrames[index + 1]!;
	const text = plainText(frame);
	assert.ok(frame.every((line) => visibleWidth(line) <= width), `action bar must fit width ${width}`);
	assert.doesNotMatch(text, /1 (?:left|unanswered)/, `remaining count must not duplicate top progress at width ${width}`);
	assert.match(text, /Ctrl\+R Regenerate(?: unanswered)?/, `Regenerate action must stay visible at width ${width}`);
	assert.match(text, /Add note/, `Add note must stay visible at width ${width}`);
	assert.match(text, /←→\s+Questions/, `question navigation must stay visible at width ${width}`);
	assert.ok(/^─+$/.test(plainText([frame.at(-1)!])), `batch UI needs a distinct bottom edge at width ${width}`);
}

const shortNarrowAction = await captureToolRender(regenerateBatch, regenerateParams, {
	inputs: ["\r"],
	widths: [20],
	rows: 8,
});
const shortNarrowFrame = shortNarrowAction.at(-1)!;
assert.ok(shortNarrowFrame.length <= 8);
assert.ok(shortNarrowFrame.every((line) => visibleWidth(line) <= 20));
assert.match(plainText(shortNarrowFrame), /Enter Next[\s\S]*Ctrl\+R Regenerate(?: unanswered)?/);
assert.match(plainText(shortNarrowFrame), /Add\s+note[\s\S]*←→\s+Questions|←→\s+Questions[\s\S]*Add\s+note/);
assert.ok(/^─+$/.test(plainText([shortNarrowFrame.at(-1)!])), "short batch UI keeps its bottom edge");

const boundaryWidths = [21, 23, 24, 25, 28, 32, 33];
for (const scenario of [
	{
		name: "normal",
		params: regenerateParams,
		inputs: [] as string[],
		expected: [/Enter Select/, /Tab Add note/, /←→ Questions/],
	},
	{
		name: "staged",
		params: regenerateParams,
		inputs: ["\r"],
		expected: [/Enter Next/, /Ctrl\+R Regenerate(?: unanswered)?/, /Tab Add note/, /←→ Questions/],
	},
	{
		name: "editing",
		params: { questions: [{ question: "Edit", options: [{ label: "Preset" }] }] },
		inputs: ["2"],
		expected: [/Editing/, /Enter Save/, /Ctrl\+C Clear/, /Esc Back/],
	},
	{
		name: "note",
		params: regenerateParams,
		inputs: [TAB],
		expected: [/Note/, /Tab Back/, /Esc Back/],
	},
	{
		name: "detail cancel warning",
		params: regenerateParams,
		inputs: ["\r", "\x1b"],
		expected: [/Answers entered/, /Esc again to cancel/],
	},
	{
		name: "review",
		params: { questions: [{ question: "Review", options: [{ label: "Ready" }] }] },
		inputs: ["\r", "\r"],
		expected: [/Enter Submit/, /↑↓ Scroll/, /Esc Back/],
	},
]) {
	const frames = await captureToolRender(regenerateBatch, scenario.params, {
		inputs: scenario.inputs,
		widths: boundaryWidths,
		rows: boundaryWidths.map(() => 40),
	});
	const finalStateFrames = frames.slice(scenario.inputs.length);
	for (const [index, frame] of finalStateFrames.entries()) {
		const width = boundaryWidths[index]!;
		const text = plainText(frame);
		assert.ok(frame.every((line) => visibleWidth(line) <= width), `${scenario.name}: frame fits width ${width}`);
		assert.ok(
			text.split("\n").every((line) => !/^(?:unanswered|Questions|cancel)$/.test(line.trim()) && !line.trim().endsWith("·")),
			`${scenario.name}: action tokens stay whole at width ${width}`,
		);
		for (const expected of scenario.expected) assert.match(text, expected, `${scenario.name}: action remains visible at width ${width}`);
	}
}

const regeneratedWithRemainingNote = await executeCustomUI(
	regenerateBatch,
	regenerateParams,
	["\r", "\r", TAB, "regenerate around this", CTRL_R],
);
assert.deepEqual(regeneratedWithRemainingNote.result.details.unansweredNotes, [
	{ questionIndex: 1, note: "regenerate around this" },
]);
assert.match(
	regeneratedWithRemainingNote.result.content[0].text,
	/Unanswered Q2: Needs regeneration[\s\S]*Choices:\n- Beta\nNote: regenerate around this/,
);

const directCustomRegenerate = await executeCustomUI(
	regenerateBatch,
	regenerateParams,
	[DOWN, "\r", "drafted custom answer", CTRL_R],
);
assert.equal(directCustomRegenerate.result.details.status, "regenerate");
assert.deepEqual(directCustomRegenerate.result.details.answers[0].answer, {
	type: "other",
	label: "drafted custom answer",
	value: "drafted custom answer",
});

const regenerateTranscript = regenerateBatch.renderResult!(regenerated.result, {}, transcriptTheme).render(80).join("\n");
assert.match(regenerateTranscript, /Regenerate 1 unanswered/);

const invalidRegenerate = await captureToolRender(regenerateBatch, regenerateParams, { inputs: [CTRL_R] });
assert.match(plainText(invalidRegenerate.at(-1)!), /Answer a question first\./);
assert.doesNotMatch(plainText(invalidRegenerate.at(-1)!), /Ctrl\+R Regenerate unanswered/);
const completeRegenerate = await captureToolRender(regenerateBatch, regenerateParams, { inputs: ["\r", "\r", "\r", "\r", CTRL_R] });
assert.match(plainText(completeRegenerate.at(-1)!), /Review your answers/);
assert.doesNotMatch(plainText(completeRegenerate.at(-1)!), /Regenerate unanswered|All answered\. Use Review\./);
const allAnsweredFeedback = await captureToolRender(regenerateBatch, regenerateParams, {
	inputs: ["\r", "\r", "\r", "\r", "\x1b", CTRL_R],
});
assert.match(plainText(allAnsweredFeedback.at(-1)!), /All answered\. Use Review\./);

const basicScenarios: Array<{
	name: string;
	tool: RegisteredTool;
	params: unknown;
}> = [
	{
		name: "standalone single-select",
		tool: askOne,
		params: { question: "Which option should we use?", options: [longOption] },
	},
	{
		name: "standalone multi-select",
		tool: askOne,
		params: { question: "Which options should we use?", options: [longOption], multiSelect: true },
	},
	{
		name: "tabbed single-select",
		tool: askMany,
		params: {
			questions: [{ question: "Which option should we use?", options: [longOption] }],
		},
	},
	{
		name: "tabbed multi-select",
		tool: askMany,
		params: {
			questions: [{ question: "Which options should we use?", options: [longOption], multiSelect: true }],
		},
	},
];

for (const scenario of basicScenarios) {
	const snapshots = await captureToolRender(scenario.tool, scenario.params);
	assertLongContentIsReadable(snapshots.at(-1)!, WIDTH, scenario.name);
}

const recommendationSnapshots = await captureToolRender(
	askOne,
	{
		question: "Recommended option",
		options: [
			{ label: "Ordinary first" },
			{ label: "Modern", value: "modern", recommended: true, description: "Preferred modern path" },
			{ label: "Ordinary second" },
		],
	},
	{ inputs: [DOWN, "\r", DOWN] },
);
const recommendedFrame = plainText(recommendationSnapshots[0]!);
assert.ok(recommendedFrame.indexOf("Modern") < recommendedFrame.indexOf("Ordinary first"));
assert.ok(recommendedFrame.indexOf("Ordinary first") < recommendedFrame.indexOf("Ordinary second"));
assert.match(recommendedFrame, /Modern  Recommended/);
const recommendationRaw = recommendationSnapshots[0]!.join("\n");
assert.match(recommendationRaw, /\x1b\[35m→ \x1b\[0m\x1b\[35m\( \) 1\. \x1b\[0m\x1b\[32mModern\x1b\[0m\x1b\[32m  Recommended/);
assert.match(recommendationRaw, /\x1b\[37m\( \) 2\. \x1b\[0m\x1b\[37mOrdinary first/);
const selectedThenMovedRaw = recommendationSnapshots.at(-1)!.join("\n");
assert.match(selectedThenMovedRaw, /\x1b\[32m\(●\) 2\. \x1b\[0m\x1b\[32mOrdinary first/);
assert.match(selectedThenMovedRaw, /\x1b\[35m→ \x1b\[0m\x1b\[35m\( \) 3\. \x1b\[0m\x1b\[35mOrdinary second/);

const describedSpacing = plainText(recommendationSnapshots[0]!).split("\n");
const descriptionRow = describedSpacing.findIndex((line) => line.includes("Preferred modern path"));
assert.notEqual(describedSpacing[descriptionRow + 1], "", "ordinary option descriptions do not gain extra spacing");
const otherDescriptionRow = describedSpacing.findIndex((line) => line.includes("Write your own answer."));
assert.equal(describedSpacing[otherDescriptionRow + 1], "", "the built-in custom-answer description has one following blank line");

const standaloneHeadingAndText = await captureToolRender(
	askOne,
	{ question: "Accent standalone heading" },
	{ inputs: ["typed standalone answer"], focused: true },
);
const standaloneAccentRaw = standaloneHeadingAndText.at(-1)!.join("\n");
assert.match(standaloneAccentRaw, /\x1b\[35m Accent standalone heading/);
assert.match(standaloneAccentRaw, /\x1b\[35m[^\n]*typed standalone answer/);

const standaloneSavedCustom = await captureToolRender(
	askOne,
	{ question: "Save custom", options: [{ label: "Preset" }] },
	{ inputs: ["2", "saved custom", "\r"], focused: true },
);
const standaloneSavedCustomRaw = standaloneSavedCustom.at(-1)!.join("\n");
assert.match(standaloneSavedCustomRaw, /\x1b\[35m — saved/);
assert.match(standaloneSavedCustomRaw, /\x1b\[35mcustom/);

const batchHeadingAndCustom = await captureToolRender(
	askMany,
	{ questions: [{ question: "Accent batch heading", options: [{ label: "Preset" }] }] },
	{ inputs: ["2", "typed custom answer", "\r"], focused: true },
);
const batchAccentRaw = batchHeadingAndCustom.at(-1)!.join("\n");
assert.match(batchAccentRaw, /\x1b\[35m\x1b\[1mQ1: Accent batch heading/);
assert.match(batchAccentRaw, /\x1b\[35m[^\n]*typed/);
assert.match(batchAccentRaw, /\x1b\[35mcustom answer/);

const batchOpenText = await captureToolRender(
	askMany,
	{ questions: [{ question: "Batch open text" }] },
	{ inputs: ["typed batch text"], focused: true },
);
assert.match(batchOpenText.at(-1)!.join("\n"), /\x1b\[35m[^\n]*typed batch text/);

for (const scenario of [
	{ name: "standalone open text", tool: askOne, params: { question: "Cursor color" }, prefix: [] },
	{ name: "standalone custom text", tool: askOne, params: { question: "Cursor color", options: [{ label: "Preset" }] }, prefix: ["2"] },
	{ name: "batch open text", tool: askMany, params: { questions: [{ question: "Cursor color" }] }, prefix: [] },
	{ name: "batch custom text", tool: askMany, params: { questions: [{ question: "Cursor color", options: [{ label: "Preset" }] }] }, prefix: ["2"] },
]) {
	const frames = await captureToolRender(scenario.tool, scenario.params, {
		inputs: [...scenario.prefix, "prefix suffix", ...Array.from({ length: 6 }, () => LEFT)],
		focused: true,
	});
	const raw = frames.at(-1)!.join("\n");
	const suffixIndex = raw.indexOf("suffix");
	assert.ok(suffixIndex >= 0, `${scenario.name} renders text after the cursor`);
	assert.ok(raw.lastIndexOf("\x1b[35m", suffixIndex) > raw.lastIndexOf("\x1b[0m", suffixIndex), `${scenario.name} keeps the suffix accent-colored`);
}

const semanticFooter = await captureToolRender(
	askMany,
	{ questions: [{ question: "Footer semantics", options: [{ label: "Ready choice" }] }] },
	{ inputs: ["\r", "\r"], widths: [80] },
);
const initialFooterRaw = semanticFooter[0]!.join("\n");
assert.match(initialFooterRaw, /\x1b\[35m[^\n]*Enter Select/);
assert.match(initialFooterRaw, /\x1b\[90m[^\n]*Ctrl\+\/ Ask agent/);
assert.match(initialFooterRaw, /\x1b\[90m[^\n]*Esc Cancel/);
const readyFooterRaw = semanticFooter[1]!.join("\n");
assert.match(readyFooterRaw, /\x1b\[32m[^\n]*Enter Review/);
assert.match(readyFooterRaw, /\x1b\[90m[^\n]*Ctrl\+\/ Ask agent/);
const reviewFooterRaw = semanticFooter.at(-1)!.join("\n");
assert.match(reviewFooterRaw, /\x1b\[32m[^\n]*✓ Ready/);
assert.match(reviewFooterRaw, /\x1b\[32m[^\n]*Enter Submit/);
assert.match(reviewFooterRaw, /\x1b\[90m[^\n]*Esc Back/);
assert.match(reviewFooterRaw, /\x1b\[90mFooter semantics/);
assert.doesNotMatch(reviewFooterRaw, /\x1b\[35mFooter semantics/, "review question headings remain muted");
assert.match(reviewFooterRaw, /\x1b\[35mReady choice/, "review answer summaries retain accent");

const spaceToggleSnapshots = await captureToolRender(
	askOne,
	{
		question: "Toggle with Space",
		options: [{ label: "Selected by Space", value: "space-choice" }],
		multiSelect: true,
	},
	{ inputs: [" "] },
);
assert.match(plainText(spaceToggleSnapshots.at(-1)!), /✓ 1 selected/);

// A cursor moved beyond the visible cap must move the owned item window with it.
const manyOptions = fillerOptions(12);
manyOptions[11] = { ...longOption, description: longOption.description };
for (const multiSelect of [false, true]) {
	const snapshots = await captureToolRender(
		askOne,
		{
			question: "Navigate to the final real option",
			options: manyOptions,
			multiSelect,
		},
		{ inputs: Array.from({ length: 11 }, () => DOWN) },
	);
	const finalFrame = snapshots.at(-1)!;
	assertLongContentIsReadable(
		finalFrame,
		WIDTH,
		`standalone ${multiSelect ? "multi" : "single"} navigation window`,
	);
	assert.doesNotMatch(plainText(finalFrame), /Filler option 1\n/, "off-window choices should not remain rendered");
}

// Opening Other keeps the option list in place and types directly inside the
// selected row instead of replacing it with a separate editor box.
const editSnapshots = await captureToolRender(
	askOne,
	{ question: "Choose or write", options: [longOption] },
	{ inputs: ["2", "native answer"] },
);
const inlineEditFrame = plainText(editSnapshots.at(-1)!);
assertLongContentIsReadable(editSnapshots.at(-1)!, WIDTH, "custom-answer edit mode");
assert.match(inlineEditFrame, /→ \( \) 2\. Something else…/);
assert.match(inlineEditFrame, /native answer/);
assert.match(inlineEditFrame.split("\n").find((line) => line.includes("native answer"))!, /^ {9}/);
assert.doesNotMatch(inlineEditFrame, /Write your own answer\./);
assert.match(inlineEditFrame, /(?:Typing\s+•\s+Enter save|Editing\s+·\s+Enter Save)/);
assert.doesNotMatch(inlineEditFrame, /Write your custom answer:/);

// Long custom answers wrap beneath Other while typing, then replace the generic
// row after save instead of appearing in a detached "Selected" banner.
const longCustomAnswer =
	"BEGINNING stays visible while this custom response wraps naturally across the available width through ENDING";
const expandedCustomSnapshots = await captureToolRender(
	askMany,
	{ questions: [{ question: "Write a detailed custom answer", options: [{ label: "Preset" }] }] },
	{ inputs: ["2", longCustomAnswer, "\r", "\r"] },
);
const typingCustomFrame = plainText(expandedCustomSnapshots.at(-3)!);
assert.match(typingCustomFrame, /BEGINNING/);
assert.match(typingCustomFrame, /ENDING/);
const savedCustomFrame = plainText(expandedCustomSnapshots.at(-1)!);
assert.match(savedCustomFrame, /Review your answers/);
assert.match(savedCustomFrame, /BEGINNING/);
assert.match(savedCustomFrame, /ENDING/);
assert.match(savedCustomFrame, /Enter Submit/);

// Ctrl+Enter commits an in-progress custom answer before opening Review.
const customCtrlSubmit = await captureToolRender(
	askMany,
	{ questions: [
		{ question: "Custom and submit", options: [{ label: "Preset" }] },
		{ question: "Skip this one", options: [{ label: "Later" }] },
	] },
	{ inputs: ["2", "Keep editing this custom answer", CTRL_ENTER], widths: [80] },
);
assert.match(plainText(customCtrlSubmit.at(-2)!), /Editing[\s\S]*Ctrl\+Enter Review answered/);
assert.match(plainText(customCtrlSubmit.at(-1)!), /Review 1 answer · 1 skipped/);
assert.match(plainText(customCtrlSubmit.at(-1)!), /Keep editing this custom answer/);
assert.match(plainText(customCtrlSubmit.at(-1)!), /Enter Submit/);

for (const scenario of [
	{
		name: "standalone multi-select inline answer",
		tool: askOne,
		params: { question: "Choose or write", options: [longOption], multiSelect: true },
		expectedIndent: 9,
	},
	{
		name: "tabbed single-select inline answer",
		tool: askMany,
		params: { questions: [{ question: "Choose or write", options: [longOption] }] },
		expectedIndent: 9,
	},
	{
		name: "tabbed multi-select inline answer",
		tool: askMany,
		params: { questions: [{ question: "Choose or write", options: [longOption], multiSelect: true }] },
		expectedIndent: 9,
	},
]) {
	const snapshots = await captureToolRender(scenario.tool, scenario.params, {
		inputs: ["2", "native answer"],
	});
	const frame = plainText(snapshots.at(-1)!);
	assert.match(frame, /(?:Typing\s+•\s+Enter (?:save|submit)|Editing\s+·\s+Enter (?:Save|Submit))/, `${scenario.name}: the footer should identify typing state`);
	assert.match(frame, /native answer/, `${scenario.name}: typed text should stay inside the choices`);
	const customTextLine = frame.split("\n").find((line) => line.includes("native answer"));
	assert.match(
		customTextLine!,
		new RegExp(`^ {${scenario.expectedIndent}}`),
		`${scenario.name}: custom text should align beneath its option label`,
	);
	assert.doesNotMatch(frame, /Write your custom answer:/);
}

// Custom-answer drafts belong to their tabs rather than leaking through the
// shared input component when the user switches between questions.
const independentDraftSnapshots = await captureToolRender(
	askMany,
	{
		questions: [
			{ question: "First custom answer", options: [{ label: "Preset A" }] },
			{ question: "Second custom answer", options: [{ label: "Preset B" }] },
		],
	},
	{ inputs: ["2", "first draft", "\x1b", RIGHT, "2", "second draft", "\x1b", LEFT, "2"] },
);
const abandonedFirstDraft = plainText(independentDraftSnapshots[3]!);
assert.doesNotMatch(abandonedFirstDraft, /—\s+first draft/, "Esc preserves a draft without selecting it");
const restoredFirstDraft = plainText(independentDraftSnapshots.at(-1)!);
assert.match(restoredFirstDraft, /first draft/);
assert.doesNotMatch(restoredFirstDraft, /second draft/);

// Width-aware caching must reflow existing content when the terminal narrows.
const resizeSnapshots = await captureToolRender(
	askOne,
	{ question: "Resize this question", options: [longOption] },
	{ widths: [WIDTH, NARROW_WIDTH] },
);
assertLongContentIsReadable(resizeSnapshots.at(-1)!, NARROW_WIDTH, "narrow resized UI");

// Cursor state belongs to each batch tab and must survive switching away/back.
const tabSnapshots = await captureToolRender(
	askMany,
	{
		questions: [
			{ question: "First tab", options: fillerOptions(4) },
			{ question: "Second tab", options: fillerOptions(2) },
		],
	},
	{ inputs: [DOWN, DOWN, RIGHT, LEFT] },
);
assert.match(plainText(tabSnapshots.at(-1)!), /→ \( \) 3\. Filler option 3/);

// Cursor identity is positional, so duplicate and reserved values do not move
// the highlight back to the first matching value.
const duplicateSnapshots = await captureToolRender(
	askOne,
	{
		question: "Which duplicate?",
		options: [
			{ label: "Duplicate first", value: "same" },
			{ label: "Duplicate second", value: "same" },
			{ label: "Reserved-looking value", value: "__other__" },
		],
	},
	{ inputs: [DOWN] },
);
assert.match(plainText(duplicateSnapshots.at(-1)!), /→ \( \) 2\. Duplicate second/);

const lifecycleEvents: HerdrBlockedEvent[] = [];
const lifecycleTools = registerTools(lifecycleEvents);
const lifecycleAskOne = lifecycleTools.get("ask_user_question")!;
const editorAnswer = deferred<unknown>();
const singleExecution = lifecycleAskOne.execute(
	"single-lifecycle",
	{ question: "Approve this?", options: [{ label: "Yes" }] },
	undefined,
	undefined,
	{
		hasUI: true,
		mode: "tui",
		ui: { custom: () => editorAnswer.promise },
	},
);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(lifecycleEvents, [{ active: true, label: "Waiting for your answer" }]);
editorAnswer.resolve({
	answer: { type: "option", label: "Yes", value: "Yes", index: 1 },
	note: "",
});
await singleExecution;
assert.deepEqual(lifecycleEvents, [
	{ active: true, label: "Waiting for your answer" },
	{ active: false },
]);

lifecycleEvents.length = 0;
const lifecycleAskMany = lifecycleTools.get("ask_questions")!;
const batchAnswer = deferred<unknown>();
const batchExecution = lifecycleAskMany.execute(
	"batch-lifecycle",
	{ questions: [{ question: "First?", options: [{ label: "Yes" }] }] },
	undefined,
	undefined,
	{
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: { custom: () => batchAnswer.promise },
	},
);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(lifecycleEvents, [{ active: true, label: "Waiting for your answers" }]);
batchAnswer.resolve(null);
await batchExecution;
assert.deepEqual(lifecycleEvents, [
	{ active: true, label: "Waiting for your answers" },
	{ active: false },
]);

lifecycleEvents.length = 0;
await assert.rejects(
	lifecycleAskOne.execute(
		"single-error",
		{ question: "Will this fail?", options: [{ label: "Yes" }] },
		undefined,
		undefined,
		{
			hasUI: true,
		mode: "tui",
			ui: { custom: async () => { throw new Error("question UI failed"); } },
		},
	),
	/question UI failed/,
);
assert.deepEqual(lifecycleEvents, [
	{ active: true, label: "Waiting for your answer" },
	{ active: false },
]);

lifecycleEvents.length = 0;
const aborted = new AbortController();
aborted.abort();
for (const [tool, params] of [
	[lifecycleAskOne, { question: "Single?", options: [{ label: "Yes" }] }],
	[lifecycleAskMany, { questions: [{ question: "Batch?", options: [{ label: "Yes" }] }] }],
] as const) {
	await tool.execute("headless", params, undefined, undefined, { hasUI: false });
	await tool.execute("aborted", params, aborted.signal, undefined, {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
	});
}
assert.deepEqual(lifecycleEvents, []);

let rpcCustomCalled = false;
const rpcResult = await lifecycleAskOne.execute(
	"rpc-mode",
	{ question: "RPC?", options: [{ label: "No custom TUI" }] },
	undefined,
	undefined,
	{ hasUI: true, mode: "rpc", ui: { custom: async () => { rpcCustomCalled = true; } } },
) as any;
assert.equal(rpcResult.details.status, "unavailable");
assert.equal(rpcCustomCalled, false);

// Ctrl+/ opens Ask agent in either question UI without
// discarding semantic state. Blank submissions stay in place; Esc backs out.
const CTRL_QUESTION = "\x1b[63;5u";
const standaloneClarification = await executeCustomUI(
	askOne,
	{ question: "Choose runtime", details: "For production", options: [{ label: "Node", value: "node", recommended: true }] },
	["\r", CTRL_QUESTION, "\r", "\x1b", CTRL_QUESTION, "Why is this best?", "\r"],
);
assert.match(plainText(standaloneClarification.snapshots[0]!), /Ctrl\+\/ Ask agent/);
assert.match(plainText(standaloneClarification.snapshots[2]!), /Ask agent/);
assert.match(plainText(standaloneClarification.snapshots[3]!), /Question required\./);
assert.match(plainText(standaloneClarification.snapshots[4]!), /Choose runtime/);
assert.equal(standaloneClarification.result.details.status, "clarification_requested");
assert.match(standaloneClarification.result.content[0].text, /Why is this best\?/);
assert.match(standaloneClarification.result.content[0].text, /Original question: Choose runtime/);
assert.match(standaloneClarification.result.content[0].text, /Details: For production/);
assert.match(standaloneClarification.result.content[0].text, /Node \[value: node\].*recommended/);
assert.match(standaloneClarification.result.content[0].text, /normal assistant text.*immediately call ask_user_question again/);

// Standalone Ask agent owns its controls and note affordance in every mode.
for (const scenario of [
	{ name: "text", params: { question: "Explain" } },
	{ name: "single", params: { question: "Choose", options: [{ label: "One" }] } },
	{ name: "multi", params: { question: "Choose several", options: [{ label: "One" }], multiSelect: true } },
]) {
	const frames = await captureToolRender(askOne, scenario.params, {
		inputs: [CTRL_QUESTION], focused: true, widths: [18, 24, 34], rows: [40, 40, 40],
	});
	for (const [index, frame] of frames.slice(1).entries()) {
		const width = [18, 24, 34][index]!;
		const text = plainText(frame);
		assert.ok(frame.every((line) => visibleWidth(line) <= width), `${scenario.name} Ask agent fits width ${width}`);
		assert.ok(frame.join("\n").includes(CURSOR_MARKER), `${scenario.name} Ask agent keeps its caret at width ${width}`);
		assert.doesNotMatch(text, /\+ Add note|Tab note|Enter (?:submit|select)|↑↓|Space toggle/, `${scenario.name} hides ordinary actions at width ${width}`);
		assert.match(text, /Tab|⇥/, `${scenario.name} Preview remains discoverable at width ${width}`);
		assert.match(text, /Enter|↵/, `${scenario.name} Send remains discoverable at width ${width}`);
		assert.match(text, /Esc/, `${scenario.name} Back remains discoverable at width ${width}`);
		assert.doesNotMatch(text, /Clean later questions may update\./);
	}
}

for (const scenario of [
	{ name: "text", params: { question: "Explain" } },
	{ name: "single", params: { question: "Choose", options: [{ label: "One" }] } },
	{ name: "multi", params: { question: "Choose several", options: [{ label: "One" }], multiSelect: true } },
]) {
	const frames = await captureToolRender(askOne, scenario.params, { inputs: [TAB, "KEEP_NOTE", TAB, CTRL_QUESTION], focused: true });
	const compose = plainText(frames.at(-1)!);
	assert.match(compose, /KEEP_NOTE/, `${scenario.name} keeps populated note as read-only context`);
	assert.doesNotMatch(compose, /\+ Add note|Tab note/, `${scenario.name} does not expose note editing during Ask agent`);
}

const standalonePreview = await captureToolRender(askOne, { question: "Preview question" }, {
	inputs: [CTRL_QUESTION, TAB], focused: true, widths: [50],
});
const standalonePreviewText = plainText(standalonePreview.at(-1)!);
assert.match(standalonePreviewText, /Read-only preview · Tab Back · Esc Close/);
assert.doesNotMatch(standalonePreviewText, /Q1\/1|Clean later questions|←|→|\+ Add note|Tab note/);

// Opening and backing out of clarification must not commit an Other draft that
// was still being edited. The interaction should match a plain editor Escape.
for (const scenario of [
	{ name: "single", multiSelect: false, key: CTRL_QUESTION, unselected: /\( \) 2\./ },
	{ name: "multi", multiSelect: true, key: "\x1b[47;5u", unselected: /\[ \] 2\./ },
]) {
	const backedOut = await executeCustomUI(
		askMany,
		{ questions: [{
			question: `${scenario.name} custom answer`,
			options: [{ label: "Preset" }],
			...(scenario.multiSelect ? { multiSelect: true } : {}),
		}] },
		["2", "UNCOMMITTED_OTHER", scenario.key, "\x1b", "\x1b"],
	);
	const finalFrame = plainText(backedOut.snapshots.at(-1)!);
	assert.match(finalFrame, scenario.unselected, `${scenario.name}: Other remains unselected after Ask agent/Esc`);
	assert.doesNotMatch(finalFrame, /— UNCOMMITTED_OTHER/, `${scenario.name}: draft was not committed by Ask agent`);
}

const batchClarification = await executeCustomUI(
	askMany,
	{ questions: [
		{ question: "Pick database", options: [{ label: "Postgres" }] },
		{ question: "Pick cache", details: "For sessions", options: [{ label: "Redis" }] },
	] },
	["\r", TAB, "Keep durable", TAB, "\r", CTRL_QUESTION, "Can Redis be omitted?", "\r"],
);
assert.match(plainText(batchClarification.snapshots[0]!), /Ctrl\+\/ Ask agent/);
assert.equal(batchClarification.result.details.status, "clarification_requested");
assert.equal(batchClarification.result.details.activeQuestionIndex, 1);
assert.equal((batchClarification.result.details.answers[0].answer as any).label, "Postgres");
assert.equal(batchClarification.result.details.answers[0].note, "Keep durable");
assert.equal(batchClarification.result.details.continuation.activeQuestionIndex, 1);
assert.equal(batchClarification.result.details.continuation.tabs[0].note, "Keep durable");
assert.match(batchClarification.result.content[0].text, /one atomic resume_questions call/);
assert.match(batchClarification.result.content[0].text, /revisions: \[\]/);

// The current tab remains the question to revisit even if it already has a
// staged answer; its semantic draft is returned instead of being called resolved.
const answeredBatchClarification = await executeCustomUI(
	askMany,
	{ questions: [{ question: "Only question", options: [{ label: "Draft choice" }] }] },
	["\r", CTRL_QUESTION, "Can you explain the tradeoff?", "\r"],
);
assert.match(plainText(answeredBatchClarification.snapshots[1]!), /Ctrl\+\/ Ask agent/);
assert.equal(answeredBatchClarification.result.details.status, "clarification_requested");
assert.equal(answeredBatchClarification.result.details.answers[0].answer.label, "Draft choice");
assert.equal(answeredBatchClarification.result.details.continuation.tabs[0].answer.label, "Draft choice");
assert.match(answeredBatchClarification.result.content[0].text, /Continuation ID:/);
