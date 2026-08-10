import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, ProcessTerminal } from "@earendil-works/pi-tui";
import askUserQuestion from "../extensions/context-seeker.ts";
import { SafeEditor } from "../extensions/ask-user-question/tui-primitives.ts";

interface Tool {
	execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any): Promise<any>;
	renderCall?(args: any, theme: any): { render(width: number): string[] };
	renderResult?(result: any, options: any, theme: any): { render(width: number): string[] };
}

function register(events: Array<{ active: boolean; label?: string }> = []): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	askUserQuestion({
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {}, appendEntry() {},
		events: { emit(name: string, event: any) { if (name === "herdr:blocked") events.push(event); }, on() {} },
	} as unknown as ExtensionAPI);
	return tools;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const keybindings = { matches: () => false };
const UNSAFE_TERMINAL_CONTROL = /[\x00-\x08\x0b-\x0d\x0e-\x1f\x7f]|\x1b/;
const attack = {
	question: "Question line 1\nQuestion line 2\x1b[2J",
	details: "Details line 1\nDetails line 2\x1b]8;;https:\/\/evil.example\x07link\x1b]8;;\x07",
	option: "Option\x1b_Payload\x1b\\",
	description: "Description\bbackspace\roverwrite",
	answer: "Answer line 1\nAnswer line 2\x1b[31m",
	note: "Note line 1\nNote line 2\x00",
};

async function renderedUI(tool: Tool, params: any): Promise<string> {
	let output = "";
	await tool.execute("terminal-safety", params, undefined, undefined, {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: { custom: async (factory: any) => {
			const component = factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } }, theme, keybindings, () => {});
			output = component.render(80).join("\n");
			return null;
		} },
	});
	return output;
}

async function editorInputFrames(tool: Tool, params: any, inputs: string[]): Promise<{ focused: string; unfocused: string }> {
	let focused = "";
	let unfocused = "";
	await tool.execute("cursor-marker-provenance", params, undefined, undefined, {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: { custom: async (factory: any) => {
			const component = factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } }, theme, keybindings, () => {});
			component.focused = true;
			for (const input of inputs) component.handleInput(input);
			focused = component.render(80).join("\n");
			component.focused = false;
			unfocused = component.render(80).join("\n");
			return null;
		} },
	});
	return { focused, unfocused };
}

async function editorFrames(tool: Tool, params: any, prefix: string[], payload: string, moveHome = false): Promise<{ focused: string; unfocused: string }> {
	return editorInputFrames(tool, params, [...prefix, payload, ...(moveHome ? ["\x1b[H"] : [])]);
}

function markerCount(text: string): number {
	return text.split(CURSOR_MARKER).length - 1;
}

async function terminalDeliveries(rawChunks: string[]): Promise<string[]> {
	const terminal = new ProcessTerminal() as any;
	const delivered: string[] = [];
	terminal.inputHandler = (input: string) => delivered.push(input);
	terminal.setupStdinBuffer();
	try {
		for (const chunk of rawChunks) terminal.stdinDataHandler(chunk);
		await new Promise((resolve) => setTimeout(resolve, 20));
		return delivered;
	} finally {
		terminal.stdinBuffer.destroy();
	}
}

function safeEditor(): SafeEditor {
	return new SafeEditor(
		{ requestRender() {} } as any,
		{
			borderColor: (text: string) => text,
			selectList: {
				selectedPrefix: (text: string) => text,
				selectedText: (text: string) => text,
				description: (text: string) => text,
				scrollInfo: (text: string) => text,
				noMatch: (text: string) => text,
			},
		},
	);
}

async function abortChild(mode: "single" | "batch"): Promise<void> {
	const events: Array<{ active: boolean; label?: string }> = [];
	const tool = register(events).get(mode === "single" ? "ask_user_question" : "ask_questions")!;
	const controller = new AbortController();
	let closed = false;
	let opened!: () => void;
	const wasOpened = new Promise<void>((resolve) => { opened = resolve; });
	const execution = tool.execute(
		`abort-open-${mode}`,
		mode === "single"
			? { question: "Abort single", options: [{ label: "Yes" }] }
			: { questions: [{ question: "Abort batch", options: [{ label: "Yes" }] }] },
		controller.signal,
		undefined,
		{
			hasUI: true,
			mode: "tui",
			sessionManager: { getBranch: () => [] },
			ui: { custom: (factory: any) => new Promise((resolve) => {
				factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } }, theme, keybindings, (value: any) => {
					closed = true;
					resolve(value);
				});
				opened();
			}) },
		},
	);
	await wasOpened;
	assert.deepEqual(events, [{ active: true, label: mode === "single" ? "Waiting for your answer" : "Waiting for your answers" }]);
	controller.abort();
	const result = await Promise.race([
		execution,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${mode} execution did not settle within 150ms after abort`)), 150)),
	]);
	assert.equal(result.details.status, "cancelled");
	assert.equal(closed, true, "abort should close the open custom UI");
	assert.deepEqual(events.at(-1), { active: false }, "abort should clear herdr:blocked");

	// A following dialog proves the serialized UI lock was released.
	let nextOpened = false;
	const next = tool.execute(
		`after-abort-${mode}`,
		mode === "single"
			? { question: "After abort", options: [{ label: "Yes" }] }
			: { questions: [{ question: "After abort", options: [{ label: "Yes" }] }] },
		undefined, undefined,
		{ hasUI: true, mode: "tui", sessionManager: { getBranch: () => [] }, ui: { custom: async () => { nextOpened = true; return null; } } },
	);
	await Promise.race([next, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${mode} UI lock was not released within 150ms`)), 150))]);
	assert.equal(nextOpened, true);
}

if (process.env.ABORT_DIALOG_MODE === "single" || process.env.ABORT_DIALOG_MODE === "batch") {
	await abortChild(process.env.ABORT_DIALOG_MODE);
	console.log(`PASS child: open ${process.env.ABORT_DIALOG_MODE} dialog aborts and releases lifecycle ownership`);
	process.exit(0);
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [
	{
		name: "terminal input buffering assembles fragmented cursor-marker input before SafeEditor strips it and preserves Escape",
		async run() {
			const raw = `${CURSOR_MARKER}tail`;
			const paste = `\x1b[200~${raw}\x1b[201~`;
			for (const [name, framed] of [["raw marker", raw], ["bracketed paste", paste]] as const) {
				for (let boundary = 1; boundary < framed.length; boundary++) {
					const delivered = await terminalDeliveries([framed.slice(0, boundary), framed.slice(boundary)]);
					assert.deepEqual(delivered, [framed], `${name} split ${boundary}/${framed.length} must be assembled before component delivery`);

					const editor = safeEditor();
					editor.handleInput(delivered[0]);
					assert.equal(editor.getText(), "tail", `${name} split ${boundary}/${framed.length} must not inject CURSOR_MARKER`);
				}
			}

			const escape = await terminalDeliveries(["\x1b"]);
			assert.deepEqual(escape, ["\x1b"], "a raw Escape key must still be delivered unchanged");
			const editor = safeEditor();
			editor.setText("kept");
			editor.handleInput(escape[0]);
			assert.equal(editor.getText(), "kept", "raw Escape must retain editor key behavior rather than becoming text");
		},
	},
	{
		name: "attacker cursor markers never gain trusted provenance in standalone or batch editable fields",
		async run() {
			const tools = register();
			const scenarios = [
				{ name: "standalone free text", tool: tools.get("ask_user_question")!, params: { question: "Describe" }, prefix: [] },
				{ name: "batch free text", tool: tools.get("ask_questions")!, params: { questions: [{ question: "Describe" }] }, prefix: [] },
				{ name: "standalone custom answer", tool: tools.get("ask_user_question")!, params: { question: "Choose", options: [{ label: "Preset" }] }, prefix: ["2"] },
				{ name: "batch custom answer", tool: tools.get("ask_questions")!, params: { questions: [{ question: "Choose", options: [{ label: "Preset" }] }] }, prefix: ["2"] },
				{ name: "standalone note", tool: tools.get("ask_user_question")!, params: { question: "Choose", options: [{ label: "Preset" }] }, prefix: ["\t"] },
				{ name: "batch note", tool: tools.get("ask_questions")!, params: { questions: [{ question: "Choose", options: [{ label: "Preset" }] }] }, prefix: ["\t"] },
				{ name: "standalone clarification", tool: tools.get("ask_user_question")!, params: { question: "Choose", options: [{ label: "Preset" }] }, prefix: ["\x1b[63;5u"] },
				{ name: "batch clarification", tool: tools.get("ask_questions")!, params: { questions: [{ question: "Choose", options: [{ label: "Preset" }] }] }, prefix: ["\x1b[63;5u"] },
			];
			const failures: string[] = [];
			for (const scenario of scenarios) {
				const beforeCaret = await editorFrames(scenario.tool, scenario.params, scenario.prefix, `${CURSOR_MARKER}tail`);
				const afterCaret = await editorFrames(scenario.tool, scenario.params, scenario.prefix, `${CURSOR_MARKER}tail`, true);
				for (const [position, frame, expectedOrder] of [
					["before real caret", beforeCaret.focused, `tail${CURSOR_MARKER}`],
					["after real caret", afterCaret.focused, `${CURSOR_MARKER}tail`],
				] as const) {
					const withoutSoftwareCaretStyle = frame.replace(/\x1b\[[0-9;]*m/g, "");
					if (markerCount(frame) !== 1 || !withoutSoftwareCaretStyle.includes(expectedOrder)) failures.push(`${scenario.name}, attacker marker ${position}: expected exactly one trusted marker at the real caret`);
				}
				if (markerCount(beforeCaret.unfocused) !== 0) failures.push(`${scenario.name}, unfocused: attacker marker was re-emitted as trusted`);
			}
			assert.deepEqual(failures, [], failures.join("\n"));
		},
	},
	{
		name: "external question, details, option, and description text cannot inject terminal controls while line breaks remain",
		async run() {
			const tools = register();
			for (const [tool, params] of [
				[tools.get("ask_user_question")!, { question: attack.question, details: attack.details, options: [{ label: attack.option, description: attack.description }] }],
				[tools.get("ask_questions")!, { questions: [{ question: attack.question, details: attack.details, options: [{ label: attack.option, description: attack.description }] }] }],
			] as const) {
				const output = await renderedUI(tool, params);
				assert.doesNotMatch(output, UNSAFE_TERMINAL_CONTROL);
				assert.match(output, /Question line 1[\s\S]*Question line 2/);
				assert.match(output, /Details line 1[\s\S]*Details line 2/);
			}
			const callRow = tools.get("ask_user_question")!.renderCall!({ question: attack.question }, theme).render(80).join("\n");
			assert.doesNotMatch(callRow, UNSAFE_TERMINAL_CONTROL);
			assert.match(callRow, /Question line 1[\s\S]*Question line 2/);
		},
	},
	{
		name: "answer and note tool rows cannot inject terminal controls while line breaks remain",
		async run() {
			const tools = register();
			const single = tools.get("ask_user_question")!.renderResult!({ details: { status: "answered", mode: "single-select", answers: [{ label: attack.answer }], note: attack.note } }, {}, theme).render(80).join("\n");
			const batch = tools.get("ask_questions")!.renderResult!({ details: { status: "answered", questions: [{ question: attack.question }], answers: [{ questionIndex: 0, answer: attack.answer, note: attack.note }] } }, {}, theme).render(80).join("\n");
			for (const output of [single, batch]) {
				assert.doesNotMatch(output, UNSAFE_TERMINAL_CONTROL);
				assert.match(output, /Answer line 1[\s\S]*Answer line 2/);
				assert.match(output, /Note line 1[\s\S]*Note line 2/);
			}
		},
	},
	{
		name: "aborting already-open single and batch dialogs cancels, closes UI, clears blocked state, and releases the UI lock",
		async run() {
			const file = fileURLToPath(import.meta.url);
			const failures: string[] = [];
			for (const mode of ["single", "batch"] as const) {
				try {
					await new Promise<void>((resolve, reject) => {
						const child = execFile(process.execPath, ["--import", "tsx", file], { env: { ...process.env, ABORT_DIALOG_MODE: mode }, timeout: 1000 }, (error, stdout, stderr) => {
							if (error) reject(new Error(`${mode} abort regression failed:\n${stdout}${stderr}${error.message}`));
							else resolve();
						});
						child.unref();
					});
				} catch (error) {
					failures.push(String(error));
				}
			}
			assert.deepEqual(failures, [], failures.join("\n\n"));
		},
	},
];

let passed = 0;
let failed = 0;
for (const test of cases) {
	try {
		await test.run();
		passed++;
		console.log(`PASS ${test.name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${test.name}`);
		console.error(error);
	}
}
console.log(`Executed ${cases.length} focused regression tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
