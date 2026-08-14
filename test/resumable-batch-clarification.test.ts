import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import askUserQuestion from "../extensions/context-seeker.ts";
import { renderSoftwareCaret } from "../extensions/ask-user-question/tui-primitives.ts";
import { validateToolArguments } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";

const CTRL_QUESTION = "\x1b[63;5u";
const CTRL_ENTER = "\x1b[13;5u";
const TAB = "\t";
const ESC = "\x1b";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => `[active:${text}]`, bold: (text: string) => text };
const plainTheme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const keybindings = { matches: (data: string, binding: string) =>
	(binding === "tui.select.confirm" && data === "\r")
	|| (binding === "tui.select.up" && (data === "\x1b[A" || data === "up"))
	|| (binding === "tui.select.down" && (data === "\x1b[B" || data === "down")) };

function register() {
	const tools = new Map<string, any>();
	askUserQuestion({
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {}, appendEntry() {},
		events: { emit() {}, on() {} },
	} as unknown as ExtensionAPI);
	return tools;
}

const questions = [
	{ question: "Choose database", details: "Primary durable store", options: [{ label: "Postgres", value: "pg" }, { label: "SQLite", value: "sqlite" }] },
	{ question: "Describe retention" },
	{ question: "Choose cache", options: [{ label: "Redis", value: "redis" }] },
	{ question: "Choose region", options: [{ label: "East" }] },
];
type Step = string | { rows: number; width: number };

async function hostValidatedInteract(tool: any, params: any, inputs: Step[], branch: any[] = [], rows = 40, width = 80, renderTheme = theme, toolCallId = "adaptive") {
	const validated = validateToolArguments(tool, { type: "toolCall", id: toolCallId, name: tool.name, arguments: params });
	return interact(tool, validated, inputs, branch, rows, width, renderTheme, toolCallId);
}

async function interact(tool: any, params: any, inputs: Step[], branch: any[] = [], rows = 40, width = 80, renderTheme = theme, toolCallId = "adaptive") {
	const frames: string[] = [];
	let submitted: any;
	const result = await tool.execute(toolCallId, params, undefined, undefined, {
		hasUI: true, mode: "tui", sessionManager: { getBranch: () => branch },
		ui: { custom: async (factory: any) => {
			const terminal = { rows, columns: width };
			const component = factory({ requestRender() {}, terminal }, renderTheme, keybindings, (value: any) => { submitted = value; });
			component.focused = true;
			frames.push(component.render(terminal.columns).join("\n"));
			for (const input of inputs) {
				if (typeof input === "string") component.handleInput(input);
				else { terminal.rows = input.rows; terminal.columns = input.width; }
				frames.push(component.render(terminal.columns).join("\n"));
			}
			return submitted;
		} },
	});
	return { result, frames };
}

function canonical(id: string) {
	return questions.map((question, index) => ({
		id: `${id}:q${index + 1}`, question: question.question, details: question.details,
		mode: question.options ? "single-select" : "text", options: question.options ?? [],
	}));
}
function cleanTabs(qs: any[]) {
	return qs.map((question, questionIndex) => ({ questionIndex, mode: question.mode, answer: null, textBuffer: "", otherText: "", selected: [], note: "" }));
}
function awaiting(id: string, state: any, revision = 1) {
	return [{ type: "message", message: { role: "toolResult", toolName: "ask_questions", details: { continuationId: id, revision, continuationState: "awaiting-response", continuation: state } } }];
}
function standaloneBranch(result: any) {
	return [{ type: "message", message: { role: "toolResult", toolName: "ask_user_question", details: result.details } }];
}
function state(id: string, origin = 0): any {
	const qs = canonical(id);
	return {
		questions: qs, tabs: cleanTabs(qs), activeQuestionIndex: origin, originQuestionId: qs[origin].id,
		clarificationTurns: [{ role: "user", content: "Why?" }],
		clarificationOpen: true, updatedQuestionIds: [],
	};
}
const resume = (id: string, revisions: any[] = [], response = "Because.", revision = 1) => ({ continuationId: id, revision, response, revisions });

const cases: Array<[string, () => Promise<void>]> = [
	["software caret styles one complete grapheme without replacing the trusted marker", async () => {
		assert.equal(renderSoftwareCaret(`${CURSOR_MARKER}👩🏽‍💻tail`), `${CURSOR_MARKER}\x1b[7m👩🏽‍💻\x1b[27mtail`);
	}],
	["new batch starts on Q1 detail without an overview", async () => {
		const viewed = await interact(register().get("ask_questions"), { questions }, [ESC]);
		assert.match(viewed.frames[0], /Q1: Choose database/);
		assert.match(viewed.frames[0], /Primary durable store/);
		assert.match(viewed.frames[0], /Postgres/);
		assert.doesNotMatch(viewed.frames[0], /Question overview|Enter Open/);
		assert.equal(viewed.result.details.status, "cancelled");
	}],
	["Ask agent reuses normal question context without ordinary controls", async () => {
		const id = "shared-renderer";
		const s = state(id);
		s.questions[0].options[0].recommended = true;
		s.questions[0].options[0].description = "Preferred durable choice";
		s.tabs[0].answer = { type: "option", label: "Postgres", value: "pg", index: 1 };
		s.tabs[0].selected = [{ type: "option", label: "Postgres", value: "pg", index: 1 }];
		s.tabs[0].note = "Keep replicas nearby";
		s.clarificationOpen = true;
		const viewed = await interact(register().get("resume_questions"), resume(id), [ESC, CTRL_QUESTION, ESC], awaiting(id, s));
		const normal = viewed.frames[1].split("\n");
		const compose = viewed.frames[2].split("\n");
		for (const token of ["Q1", "Choose database", "Primary durable store", "Postgres", "Recommended", "Preferred durable choice", "Keep replicas nearby"]) assert.match(compose.join("\n"), new RegExp(token));
		assert.doesNotMatch(compose.join("\n"), /Enter Next|Tab Add note|←→ Questions/);
		assert.match(compose.join("\n"), /Tab Preview · Enter Send · Esc Back/);
		assert.match(compose.join("\n"), /Clean later questions may update\./);
	}],
	["Compose gives its three mandatory rows priority at heights 4–7, including blank feedback", async () => {
		for (const rows of [4, 5, 6, 7]) {
			const viewed = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, "\r"], [], rows, 80);
			for (const [stateName, frame] of [["compose", viewed.frames[1]], ["blank feedback", viewed.frames[2]]] as const) {
				const lines = frame.split("\n");
				assert.equal(lines.length, rows, `rows ${rows} ${stateName}: every available row is allocated`);
				assert.ok(lines.every((line) => visibleWidth(line) <= 80), `rows ${rows} ${stateName}: columns fit`);
				assert.match(frame, /Q1|Choose database/, `rows ${rows} ${stateName}: context identity remains`);
				assert.ok(frame.includes(CURSOR_MARKER), `rows ${rows} ${stateName}: caret remains`);
				assert.match(frame, /Tab Preview · Enter Send · Esc Back/, `rows ${rows} ${stateName}: controls remain truthful`);
				assert.match(frame, /Clean later questions may update\./, `rows ${rows} ${stateName}: mandatory notice remains`);
			}
			assert.match(viewed.frames[2], /Question required\./, `rows ${rows}: blank feedback remains visible`);
		}
	}],
	["constrained multi-select Compose retains question identity and active answer state", async () => {
		const multi = [{ question: "Choose\nsafeguards", options: [{ label: "Backups" }, { label: "Monitoring" }, { label: "Failover" }], multiSelect: true }];
		for (const rows of [8, 9, 10]) {
			const viewed = await interact(register().get("ask_questions"), { questions: multi }, [CTRL_QUESTION], [], rows, 80, plainTheme);
			const frame = viewed.frames[1];
			assert.match(frame, /Q1: Choose safeguards/, `rows ${rows}: multiline question identity stays on one row`);
			assert.match(frame, /Select options below|Backups/, `rows ${rows}: active answer state remains`);
			assert.ok(frame.includes(CURSOR_MARKER), `rows ${rows}: Ask agent caret remains`);
			assert.match(frame, /Tab Preview · Enter Send · Esc Back/);
			assert.match(frame, /Clean later questions may update\./);
			assert.ok(frame.split("\n").length <= rows, `rows ${rows}: frame fits`);
		}
	}],
	["Compose and Preview suppress ordinary actions and empty note affordances", async () => {
		const viewed = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, TAB], [], 20, 80);
		for (const frame of viewed.frames.slice(1)) {
			assert.doesNotMatch(frame, /Enter (?:Next|Select)|Tab Add note|\+ Add note|←→ Questions|←\/→ Questions/);
		}
		assert.match(viewed.frames[1], /Tab Preview · Enter Send · Esc Back/);
	}],
	["narrow batch controls remain truthful and blank feedback shares the row", async () => {
		for (const width of [12, 18, 24, 34]) {
			const viewed = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, "\r"], [], 4, width, plainTheme);
			const frame = viewed.frames[2];
			assert.ok(frame.split("\n").every((line) => visibleWidth(line) <= width), `width ${width}: frame fits`);
			assert.ok(frame.includes(CURSOR_MARKER), `width ${width}: caret remains`);
			assert.match(frame, /Required|!/, `width ${width}: blank feedback remains`);
			assert.match(frame, /Tab|⇥/, `width ${width}: Preview key remains`);
			assert.match(frame, /Enter|↵/, `width ${width}: Send key remains`);
			assert.match(frame, /Esc/, `width ${width}: Back key remains`);
		}
	}],
	["standalone clarification reopens the ordinary form with drafts preserved", async () => {
		const tool = register().get("ask_user_question");
		const params = { question: "Explain the policy" };
		const paused = await interact(tool, params, ["draft answer", TAB, "draft note", CTRL_QUESTION, "What does policy mean?", "\r"]);
		assert.equal(paused.result.details.status, "clarification_requested");
		const reopened = await interact(tool, params, [], standaloneBranch(paused.result), 30, 60, plainTheme);
		assert.match(reopened.frames[0], /draft answer/);
		assert.match(reopened.frames[0], /draft note/);
		assert.match(reopened.frames[0], /Enter submit|Ctrl\+\/ Ask agent/, "the ordinary standalone form reopens");
		assert.doesNotMatch(reopened.frames[0], /Ask agent[\s\S]*Enter Send/, "clarification compose stays closed");

		const choiceParams = { question: "Choose policy", options: [{ label: "Preset" }] };
		const choicePaused = await interact(tool, choiceParams, ["2", "custom draft", CTRL_QUESTION, "Why?", "\r"]);
		const choiceReopened = await interact(tool, choiceParams, [], standaloneBranch(choicePaused.result), 30, 60, plainTheme);
		assert.match(choiceReopened.frames[0], /custom draft/);
		assert.match(choiceReopened.frames[0], /Typing|Enter save/, "custom edit state is restored");

		const fresh = await interact(tool, choiceParams, [], [...standaloneBranch(choicePaused.result), ...standaloneBranch(choiceReopened.result)], 30, 60, plainTheme);
		assert.doesNotMatch(fresh.frames[0], /custom draft|Typing/, "a terminal retry supersedes the consumed clarification state");

		const multiParams = { question: "Choose safeguards", options: [{ label: "Backups" }], multiSelect: true };
		const multiPaused = await interact(tool, multiParams, ["1", "2", CTRL_QUESTION, "Why?", "\r"]);
		const multiReopened = await interact(tool, multiParams, [TAB, CTRL_ENTER], standaloneBranch(multiPaused.result), 30, 60, plainTheme);
		assert.match(multiReopened.frames.at(-1)!, /Typing|Enter save/, "a pending blank custom answer still blocks submit after resume");
	}],
	["assistant clarification stays in chat while the preserved ordinary batch form reopens", async () => {
		const id = "response-layout";
		const s = state(id);
		s.tabs[0].note = "preserved note";
		const response = `COMPLETE_RESPONSE ${"LONG_RESPONSE ".repeat(20)}TAIL_SECRET`;
		const viewed = await interact(register().get("resume_questions"), resume(id, [], response), [], awaiting(id, s), 40, 40, plainTheme);
		assert.match(viewed.frames[0], /preserved note/, "saved form state is restored");
		assert.match(viewed.frames[0], /Enter Select|Ctrl\+\/ Follow up with agent/, "the ordinary question form reopens");
		assert.doesNotMatch(viewed.frames[0], /Agent:|COMPLETE_RESPONSE|TAIL_SECRET|Enter Send/, "the assistant message is not duplicated or capped inside the form");
		assert.equal(viewed.result.details.status, "cancelled");
	}],
	["empty and short Compose drafts stay compact at realistic terminal heights", async () => {
		for (const rows of [20, 30, 40]) {
			const viewed = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, "short draft"], [], rows, 80, plainTheme);
			for (const [name, frame] of [["empty", viewed.frames[1]], ["short", viewed.frames[2]]] as const) {
				const lines = frame.split("\n");
				const heading = lines.findIndex((line) => line.includes("Ask agent"));
				assert.ok(heading >= 0, `${rows} rows ${name}: heading remains visible`);
				const panel = lines.slice(heading);
				let blanks = 0;
				let maxBlanks = 0;
				for (const line of panel) {
					blanks = line === "" ? blanks + 1 : 0;
					maxBlanks = Math.max(maxBlanks, blanks);
				}
				assert.ok(maxBlanks <= 1, `${rows} rows ${name}: editor has no padded blank block`);
				assert.ok(panel.length <= 6, `${rows} rows ${name}: one-line editor panel stays compact`);
				assert.ok(lines.length < rows, `${rows} rows ${name}: compact frame does not manufacture terminal-height whitespace`);
				assert.ok(frame.includes(CURSOR_MARKER), `${rows} rows ${name}: caret remains visible`);
				assert.match(frame, /Tab Preview · Enter Send · Esc Back/);
				assert.match(frame, /Clean later questions may update\./);
			}
		}
	}],
	["Compose grows for wrapped drafts and viewports a long draft around its caret", async () => {
		const wrapped = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, "wrapped words ".repeat(12)], [], 30, 40, plainTheme);
		const wrappedLines = wrapped.frames[2].split("\n");
		const heading = wrappedLines.findIndex((line) => line.includes("Ask agent"));
		const borders = wrappedLines.map((line, index) => /^─+$/.test(line) ? index : -1).filter((index) => index > heading);
		assert.ok(borders.length >= 2 && borders[1]! - borders[0]! > 2, "wrapped draft renders multiple editor body rows");

		const long = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, `PREFIX ${"x".repeat(900)} TAIL`], [], 20, 40, plainTheme);
		const frame = long.frames[2];
		assert.ok(frame.includes(CURSOR_MARKER), "long draft keeps the caret in its viewport");
		assert.match(frame, /TAIL/, "viewport follows the caret to the draft tail");
		assert.doesNotMatch(frame, /PREFIX/, "off-screen draft head yields to the caret viewport");
		assert.ok(frame.split("\n").length <= 20, "long draft remains terminal-height bounded");
	}],
	["Preview choice paging never mutates the ordinary per-question cursor or window", async () => {
		const manyChoices = [{ question: "Pick a deployment", options: Array.from({ length: 12 }, (_, index) => ({ label: `OPTION_${index + 1}` })) }];
		const viewed = await interact(register().get("ask_questions"), { questions: manyChoices }, [DOWN, DOWN, CTRL_QUESTION, TAB, PAGE_DOWN, TAB, ESC], [], 12, 34);
		assert.equal(viewed.frames[2], viewed.frames[7], "Escape must restore the ordinary cursor/window byte-for-byte");
		assert.match(viewed.frames[6], /→ \( \) 3\. OPTION_3/, "Tab back renders the unchanged ordinary cursor");
		assert.notEqual(viewed.frames[4], viewed.frames[5], "Preview paging must move its isolated window");
		const reopened = await interact(register().get("ask_questions"), { questions: manyChoices }, [DOWN, DOWN, CTRL_QUESTION, TAB, PAGE_DOWN, TAB, ESC, CTRL_QUESTION, TAB], [], 12, 34);
		assert.equal(reopened.frames[4], reopened.frames.at(-1), "a fresh clarification reseeds Preview from the unchanged ordinary cursor");
	}],
	["clarification preserves note-focused visual layout but owns the only caret", async () => {
		const viewed = await interact(register().get("ask_questions"), { questions: [{ question: "Explain policy" }] }, [TAB, "note text", CTRL_QUESTION, ESC], [], 30, 50);
		const focusedPanel = viewed.frames[2];
		const compose = viewed.frames[3];
		assert.match(compose, /Explain policy|note text/);
		assert.doesNotMatch(compose, /Note · Tab Back|Tab Add note/);
		assert.equal(compose.split(CURSOR_MARKER).length - 1, 1, "only clarification retains the trusted hardware caret");
		assert.match(compose, new RegExp(`${CURSOR_MARKER}\\x1b\\[7m`), "only the clarification caret is painted");
		assert.equal(viewed.frames[4], focusedPanel, "Escape restores note ownership and its real caret");
	}],
	["extreme clarification widths reserve a visible editor caret before labels", async () => {
		for (const width of [1, 2, 3]) {
			const viewed = await interact(register().get("ask_questions"), { questions: [{ question: "Narrow" }] }, [CTRL_QUESTION], [], 8, width, plainTheme);
			const frame = viewed.frames[1];
			const lines = frame.split("\n");
			assert.ok(lines.length <= 8, `width ${width}: frame fits rows`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}: every line fits columns`);
			assert.ok(frame.includes(CURSOR_MARKER), `width ${width}: trusted marker remains`);
			assert.match(frame, /\x1b\[7m.\x1b\[27m/, `width ${width}: inverse software caret remains visible`);
		}
	}],
	["Preview browses one question with wrap and restores the compose draft and cursor", async () => {
		const viewed = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, "abc", LEFT, TAB, LEFT, RIGHT, RIGHT, "ignored", "\r", TAB, "X", "\r"]);
		assert.match(viewed.frames[1], /Q1: Choose database/);
		assert.ok(viewed.frames[2].includes(CURSOR_MARKER), "Compose has the trusted cursor marker");
		assert.match(viewed.frames[2], /abc[\s\S]*\x1b\[7m \x1b\[27m/);
		assert.match(viewed.frames[5], /Q4: Choose region/, "Left from Q1 wraps to the last question");
		assert.doesNotMatch(viewed.frames[5], /Choose database|Describe retention|Choose cache/);
		assert.match(viewed.frames[6], /Q1: Choose database/, "Right from the last question wraps to Q1");
		assert.match(viewed.frames[7], /Q2: Describe retention/);
		assert.doesNotMatch(viewed.frames[7], /Q1: Choose database|Q3: Choose cache/);
		assert.doesNotMatch(viewed.frames.slice(4, 10).join("\n"), new RegExp(CURSOR_MARKER), "Preview has no active caret");
		assert.match(viewed.frames[10], /Ask agent| Ask /);
		assert.match(viewed.frames[10], /Q1: Choose database/, "Compose returns to the original question");
		assert.match(viewed.frames[10], /ab[\s\S]*\x1b\[7mc\x1b\[27m/, "Tab restores the caret before c");
		assert.equal(viewed.frames[10].split(CURSOR_MARKER).length - 1, 1, "Compose shows only the clarification caret");
		assert.equal(viewed.result.details.status, "clarification_requested");
		assert.equal(viewed.result.details.continuation.originQuestionId, viewed.result.details.continuation.questions[0].id);
		assert.equal(viewed.result.details.continuation.activeQuestionIndex, 0);
		assert.equal(viewed.result.details.continuation.clarificationTurns.at(-1).content, "abXc");
		assert.ok(viewed.result.details.continuation.tabs.every((tab: any) => tab.answer === null));
	}],
	["different origins append one shared transcript and latest submission updates the boundary", async () => {
		const id = "threads";
		const s = state(id);
		const viewed = await interact(register().get("resume_questions"), resume(id), [RIGHT, CTRL_QUESTION, "Second question", "\r"], awaiting(id, s));
		assert.doesNotMatch(viewed.frames.join("\n"), /You: Why\?|Agent: Because\./, "clarification transcript stays in normal chat and the model payload");
		const next = viewed.result.details.continuation;
		assert.deepEqual(next.clarificationTurns.map((turn: any) => turn.content), ["Why?", "Because.", "Second question"]);
		assert.equal(next.originQuestionId, `${id}:q2`);
		assert.equal(next.activeQuestionIndex, 1);
		assert.ok(!("clarificationTarget" in next) && !("clarificationThreads" in next));
	}],
	["clarification result gives shared-thread wording, public definitions, and exact eligibility without IDs", async () => {
		const paused = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, "Can later questions adapt?", "\r"]);
		const text = paused.result.content[0].text;
		assert.match(text, /paused at Q1/);
		assert.match(text, /batch's shared clarification thread/);
		assert.match(text, /Q1 is the origin only.*not a reference restriction/);
		assert.match(text, /full batch and every current answer, draft, custom answer, and note/);
		assert.match(text, /Q1: \{"question":"Choose database"/);
		assert.match(text, /Eligibility: protected — clarification origin/);
		assert.match(text, /Eligibility: eligible for revision/);
		assert.match(text, /one atomic resume_questions call/);
		assert.doesNotMatch(text, /scope|target|adaptive:q\d|"id"|questionId/i);
		assert.ok(paused.result.details.questions.every((q: any) => q.id === undefined && q.mode === undefined));
	}],
	["valid sparse revisions preserve IDs and protected/omitted state and resume inline", async () => {
		const id = "sparse";
		const s = state(id);
		s.tabs[2].answer = { type: "option", label: "Redis", value: "redis", index: 1 };
		s.tabs[2].selected = [{ type: "option", label: "Redis", value: "redis", index: 1 }];
		const old = structuredClone(s);
		const viewed = await interact(register().get("resume_questions"), resume(id, [{ questionNumber: 2, question: "Revised retention", details: "New policy" }]), [CTRL_QUESTION, "follow up", "\r"], awaiting(id, s));
		const next = viewed.result.details.continuation;
		assert.match(viewed.frames[0], /Q1: Choose database/);
		assert.doesNotMatch(viewed.frames[0], /Agent: Because\.|Enter Send/);
		assert.match(viewed.frames[0], /Follow up with agent/);
		assert.equal(next.questions[1].question, "Revised retention");
		assert.equal(next.questions[1].id, old.questions[1].id);
		assert.deepEqual(next.questions[0], old.questions[0]);
		assert.deepEqual(next.questions[2], old.questions[2]);
		assert.deepEqual(next.questions[3], old.questions[3]);
		assert.deepEqual(next.tabs[0], old.tabs[0]);
		assert.deepEqual(next.tabs[2], old.tabs[2]);
		assert.deepEqual(next.updatedQuestionIds, [old.questions[1].id]);
	}],
	["invalid sparse revisions are atomic and a corrected same-revision retry succeeds", async () => {
		const tools = register();
		const tool = tools.get("resume_questions");
		const id = "atomic";
		const s = state(id);
		s.tabs[2].note = "protect me";
		const branch = awaiting(id, s);
		const sessionManager = { getBranch: () => branch };
		const ctx = { hasUI: true, mode: "tui", sessionManager, ui: { custom: async () => [] } };
		for (const [name, revisions, pattern] of [
			["duplicate", [{ questionNumber: 2, question: "A" }, { questionNumber: 2, question: "B" }], /duplicate/],
			["range", [{ questionNumber: 9, question: "A" }], /out of range/],
			["origin", [{ questionNumber: 1, question: "A" }], /protected/],
			["protected", [{ questionNumber: 3, question: "A" }], /protected/],
			["blank", [{ questionNumber: 2, question: "  " }], /nonblank/],
			["mode", [{ questionNumber: 2, question: "A", multiSelect: true }], /without options/],
			["invalid mode", [{ questionNumber: 2, question: "A", multiSelect: "yes" }], /invalid selection mode/],
			["empty options", [{ questionNumber: 2, question: "A", options: [] }], /at least one non-empty option/],
			["recommendation", [{ questionNumber: 2, question: "A", options: [{ label: "x", recommended: true }, { label: "y", recommended: true }] }], /at most one/],
		] as any[]) await assert.rejects(() => tool.execute(name, resume(id, revisions), undefined, undefined, ctx), pattern);
		assert.equal(s.questions[1].question, "Describe retention", "failed sets do not mutate canonical branch state");
		await assert.doesNotReject(() => tool.execute("corrected", resume(id, [{ questionNumber: 2, question: "Corrected" }]), undefined, undefined, ctx));
	}],
	["Updated persists through navigation and follow-up, then clears only on interaction", async () => {
		const id = "updated";
		const first = await interact(register().get("resume_questions"), resume(id, [{ questionNumber: 2, question: "Updated retention" }]), [RIGHT, LEFT, RIGHT, CTRL_QUESTION, "follow", "\r"], awaiting(id, state(id)));
		assert.match(first.frames[1], /Updated retention  Updated/);
		assert.match(first.frames[4], /Updated retention  Updated/, "navigation does not clear Updated");
		const next = first.result.details.continuation;
		assert.ok(next.updatedQuestionIds.includes(`${id}:q2`));
		const second = await interact(register().get("resume_questions"), resume(id, [], "Follow-up answer", 2), ["x", ESC, ESC], awaiting(id, next, 2));
		assert.match(second.frames[0], /Updated/);
		assert.doesNotMatch(second.frames[2], /Updated retention  Updated|Q2 Updated/, "typing clears the Updated marker on first interaction");
	}],
	["a custom draft keeps its real owner while Preview changes the composed question", async () => {
		const viewed = await interact(register().get("ask_questions"), { questions }, ["3", "owner draft", CTRL_QUESTION, TAB, RIGHT, RIGHT, TAB, "clarify", "\r"]);
		const next = viewed.result.details.continuation;
		assert.equal(next.originQuestionId, next.questions[0].id);
		assert.equal(next.activeQuestionIndex, 0);
		assert.equal(next.editingOtherQuestionId, next.questions[0].id);
		assert.equal(next.tabs[0].otherText, "owner draft");
		assert.equal(next.tabs[2].otherText, "");
	}],
	["drafts notes selections and custom edit state survive follow-up", async () => {
		const id = "state";
		const s = state(id, 1);
		s.tabs[0].answer = { type: "option", label: "Postgres", value: "pg", index: 1 };
		s.tabs[0].selected = [{ type: "option", label: "Postgres", value: "pg", index: 1 }];
		s.tabs[0].note = "durable";
		s.tabs[1].textBuffer = "draft retention";
		s.tabs[1].answer = "draft retention";
		s.tabs[2].otherText = "custom cache";
		s.editingOtherQuestionId = s.questions[1].id;
		const viewed = await interact(register().get("resume_questions"), resume(id), [CTRL_QUESTION, "again", "\r"], awaiting(id, s));
		const next = viewed.result.details.continuation;
		assert.deepEqual(next.tabs, s.tabs);
		assert.equal(next.editingOtherQuestionId, s.editingOtherQuestionId);
	}],
	["short narrow Preview and Context fit while only Compose shows a caret", async () => {
		for (const [rows, width] of [[8, 20], [9, 38]]) {
			const viewed = await interact(register().get("ask_questions"), { questions }, [CTRL_QUESTION, "x", TAB, PAGE_DOWN, TAB, "\r"], [], rows, width);
			for (const frame of viewed.frames.slice(1, -1)) assert.ok(frame.split("\n").length <= rows, `${rows}x${width} fits`);
			assert.ok(viewed.frames[2].includes(CURSOR_MARKER));
			assert.doesNotMatch(viewed.frames[3] + viewed.frames[4], new RegExp(CURSOR_MARKER), "Preview is visibly unfocused");
			assert.ok(viewed.frames[5].includes(CURSOR_MARKER), "Compose restores its caret");
			assert.equal(viewed.result.details.status, "clarification_requested");
		}
	}],
	["reopening clarification starts Preview at the newly active question", async () => {
		const viewed = await interact(register().get("ask_questions"), { questions }, [
			CTRL_QUESTION, TAB, RIGHT, ESC,
			CTRL_QUESTION, TAB,
		], [], 14, 38);
		assert.match(viewed.frames.at(-2)!, /Q1: Choose database/, "Escape returns to the original question");
		assert.match(viewed.frames.at(-1)!, /Q1: Choose database/, "fresh Preview starts at the unchanged origin");
		assert.doesNotMatch(viewed.frames.at(-1)!, /Q4: Choose region/);
	}],
	["one-question Preview paging reaches every wrapped line without mutating state", async () => {
		const id = "paged-context";
		const optionTokens = ["OPTION_ONE", "OPTION_TWO", "OPTION_THREE", "OPTION_FOUR", "OPTION_FIVE"];
		const question = { id: `${id}:q1`, question: "Viewport identity question", details: "DETAIL_ALPHA has deliberately wrapped explanatory words. DETAIL_BETA closes the explanation.", mode: "multi-select", options: optionTokens.map((label) => ({ label, value: label, ...(label === "OPTION_THREE" ? { recommended: true } : {}) })) };
		const second = { id: `${id}:q2`, question: "SECOND_QUESTION", details: "SECOND_DETAILS", mode: "single-select", options: [{ label: "SECOND_OPTION", value: "SECOND_OPTION" }] };
		const continuation: any = {
			questions: [question, second],
			tabs: [{ questionIndex: 0, mode: "multi-select", answer: [{ type: "option", label: "OPTION_TWO", value: "OPTION_TWO", index: 2 }, { type: "other", label: "CUSTOM_OMEGA", value: "CUSTOM_OMEGA" }], textBuffer: "", otherText: "CUSTOM_OMEGA", selected: [{ type: "option", label: "OPTION_TWO", value: "OPTION_TWO", index: 2 }, { type: "other", label: "CUSTOM_OMEGA", value: "CUSTOM_OMEGA" }], note: "NOTE_SIGMA" }, { questionIndex: 1, mode: "single-select", answer: null, textBuffer: "", otherText: "", selected: [], note: "SECOND_NOTE" }],
			activeQuestionIndex: 0, originQuestionId: question.id, clarificationTurns: [{ role: "user", content: "TRANSCRIPT" }], clarificationOpen: true, updatedQuestionIds: [],
		};
		const inputs = [CTRL_QUESTION, TAB, ...Array(3).fill(PAGE_DOWN), ...Array(3).fill(PAGE_UP), RIGHT, LEFT, TAB, "draft", "\r"];
		const viewed = await interact(register().get("resume_questions"), resume(id), inputs, awaiting(id, continuation), 14, 38);
		for (const frame of viewed.frames.slice(1, -1)) assert.ok(frame.split("\n").length <= 14);
		assert.match(viewed.frames.slice(2, 9).join("\n"), /OPTION_FIVE/, "read-only paging moves the real choice window");
		assert.match(viewed.frames[9], /SECOND_QUESTION/, "Preview navigation uses the normal second-question panel");
		assert.doesNotMatch(viewed.frames.join("\n"), /TRANSCRIPT/, "transcript is never rendered");
		const next = viewed.result.details.continuation;
		assert.equal(next.originQuestionId, question.id);
		assert.equal(next.activeQuestionIndex, 0);
		assert.deepEqual(next.tabs.slice(0, 2), continuation.tabs);
		assert.equal(next.clarificationTurns.at(-1).content, "draft");
	}],
	["continuation and internal question IDs are independent opaque UUIDs and branch resume still resolves", async () => {
		const recognizableToolCallId = "TOOL_SESSION_SECRET_8675309";
		const tools = register();
		const paused = await interact(
			tools.get("ask_questions"),
			{ questions },
			[CTRL_QUESTION, "Why?", "\r"],
			[], 40, 80, theme, recognizableToolCallId,
		);
		const continuationId = paused.result.details.continuationId;
		const questionIds = paused.result.details.continuation.questions.map((question: any) => question.id);
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		assert.match(continuationId, uuid);
		assert.equal(new Set([continuationId, ...questionIds]).size, questionIds.length + 1, "all canonical IDs are independent and unique");
		for (const id of questionIds) {
			assert.match(id, uuid);
			assert.doesNotMatch(JSON.stringify(paused.result.content), new RegExp(id), "model text omits internal question IDs");
			assert.doesNotMatch(JSON.stringify(paused.result.details.questions), new RegExp(id), "public questions omit internal question IDs");
		}
		assert.doesNotMatch(JSON.stringify({
			continuationId,
			questionIds,
			content: paused.result.content,
			publicQuestions: paused.result.details.questions,
		}), new RegExp(recognizableToolCallId));
		assert.ok(paused.result.details.questions.every((question: any) => !("id" in question)), "public questions omit internal IDs");

		const branch = [{ type: "message", message: { role: "toolResult", toolName: "ask_questions", details: paused.result.details } }];
		const resumed = await interact(tools.get("resume_questions"), resume(continuationId), [ESC], branch);
		assert.equal(resumed.result.details.continuationId, continuationId, "opaque continuation still resolves on the active branch");
		assert.equal(resumed.result.details.continuationState, "cancelled");
	}],
	["stale ask_questions alias passes host validation, resumes the UI, and records terminal lifecycle", async () => {
		const tools = register();
		const id = "stale-alias";
		const viewed = await hostValidatedInteract(tools.get("ask_questions"), resume(id), [" ", CTRL_ENTER, "\r"], awaiting(id, state(id)));
		assert.match(viewed.frames[0], /Q1: Choose database/);
		assert.match(viewed.frames[0], /Follow up with agent/);
		assert.equal(viewed.result.details.continuationId, id);
		assert.equal(viewed.result.details.revision, 1);
		assert.equal(viewed.result.details.continuationState, "completed");
	}],
	["ask_questions rejects mixed, partial, and empty modes after host validation", async () => {
		const tool = register().get("ask_questions");
		for (const [name, params, pattern] of [
			["mixed", { questions, ...resume("mixed") }, /exactly one complete mode.*do not mix/i],
			["partial", { continuationId: "partial", revision: 1 }, /resume fields are incomplete.*exactly one complete mode/i],
			["neither", {}, /neither questions nor complete resume fields.*exactly one complete mode/i],
		] as const) {
			await assert.rejects(() => hostValidatedInteract(tool, params, [], [], 40, 80, theme, name), pattern);
		}
	}],
	["schemas remain Google-compatible and canonical resume fields stay strict", async () => {
		const tools = register();
		const askSchema = tools.get("ask_questions").parameters;
		const resumeSchema = tools.get("resume_questions").parameters;
		assert.deepEqual(resumeSchema.required, ["continuationId", "revision", "response", "revisions"]);
		assert.equal(askSchema.required, undefined);
		for (const schema of [askSchema, resumeSchema]) {
			const serialized = JSON.stringify(schema);
			assert.doesNotMatch(serialized, /"(?:anyOf|oneOf|const)"/);
		}
	}],
	["resume schema requires revisions and lifecycle replay remains rejected", async () => {
		const tools = register();
		const schema = tools.get("resume_questions").parameters;
		assert.ok(schema.required.includes("revisions"));
		const id = "lifecycle";
		const terminal = awaiting(id, state(id));
		terminal[0].message.details.continuationState = "completed";
		const ctx = { hasUI: true, mode: "tui", sessionManager: { getBranch: () => terminal }, ui: { custom: async () => null } };
		await assert.rejects(() => tools.get("resume_questions").execute("replay", resume(id), undefined, undefined, ctx), /stale continuation/i);
	}],
	["concurrent duplicate resume opens only one UI", async () => {
		const tool = register().get("resume_questions");
		const id = "concurrent";
		const branch = awaiting(id, state(id));
		const sessionManager = { getBranch: () => branch };
		let opened = 0;
		let release!: () => void;
		const ctx = (custom: () => Promise<any>) => ({ hasUI: true, mode: "tui", sessionManager, ui: { custom } });
		const first = tool.execute("first", resume(id), undefined, undefined, ctx(async () => { opened++; await new Promise<void>((resolve) => { release = resolve; }); return []; }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = tool.execute("second", resume(id), undefined, undefined, ctx(async () => { opened++; return []; }));
		release();
		await first;
		await assert.rejects(second, /already resumed/);
		assert.equal(opened, 1);
	}],
];

let failed = 0;
for (const [name, run] of cases) {
	try { await run(); console.log(`PASS ${name}`); }
	catch (error) { failed++; console.error(`FAIL ${name}`); console.error(error); }
}
console.log(`${cases.length} cases: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
