import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "../extensions/context-seeker.ts";
import { questionResultLabel } from "../extensions/ask-user-question/historical-labels.ts";

type Hook = (event: unknown, ctx: { sessionManager: { getEntries(): any[] } }) => void;
type LabelCall = { id: string; label: string };

function result(id: string, toolName: string, details: Record<string, unknown>): any {
	return { type: "message", id, message: { role: "toolResult", toolName, details } };
}

function standaloneDetails(question: string): Record<string, unknown> {
	return {
		status: "answered",
		question,
		mode: "text",
		answers: [{ type: "text", label: "Answer", value: "Answer" }],
	};
}

function register(): { hooks: Map<string, Hook>; labels: LabelCall[] } {
	const hooks = new Map<string, Hook>();
	const labels: LabelCall[] = [];
	askUserQuestion({
		on(name: string, hook: Hook) { hooks.set(name, hook); },
		setLabel(id: string, label: string) { labels.push({ id, label }); },
		registerTool() {},
		events: { emit() {} },
	} as unknown as ExtensionAPI);
	return { hooks, labels };
}

function fire(hooks: Map<string, Hook>, name: string, entries: any[]): void {
	const hook = hooks.get(name);
	assert.ok(hook, `${name} hook was registered`);
	hook(undefined, { sessionManager: { getEntries: () => entries } });
}

const tests: Array<[string, () => void]> = [
	["standalone answered results produce normalized, grapheme-safe labels", () => {
		assert.equal(questionResultLabel(result("single", "ask_user_question",
			standaloneDetails("  Which\n option\u0007 works?  "))), "Q: Which option works?");
		assert.equal(questionResultLabel(result("bidi", "ask_user_question",
			standaloneDetails("Approve \u202Egpj.exe?\u2069"))), "Q: Approve gpj.exe?");
		const family = "👨‍👩‍👧‍👦";
		const label = questionResultLabel(result("long", "ask_user_question", standaloneDetails(family.repeat(70))));
		assert.ok(label);
		assert.equal(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(label)).length, 64);
		assert.equal(label.endsWith("…"), true);
	}],
	["batch answered results use the first question and total count", () => {
		assert.equal(questionResultLabel(result("batch", "ask_questions", {
			status: "answered",
			questions: [{ question: "First choice?" }, { question: "Second choice?" }],
			answers: [{ questionIndex: 0, answer: "First answer" }, { questionIndex: 1, answer: null }],
		})), "Q×2: First choice?");
	}],
	["resume_questions answered results use the batch label format", () => {
		assert.equal(questionResultLabel(result("resume", "resume_questions", {
			status: "answered",
			questions: [{ question: "Continue here?" }],
			answers: [{ questionIndex: 0, answer: { type: "option", label: "Yes", value: "yes", index: 1 } }],
		})), "Q×1: Continue here?");
	}],
	["malformed and non-answered entries are excluded", () => {
		const excluded = [
			null,
			{ type: "message", id: "bad", message: { role: "assistant", toolName: "ask_user_question", details: {} } },
			result("unknown", "other_tool", { status: "answered", question: "No", answers: [] }),
			result("pending", "ask_user_question", { status: "cancelled", question: "No", answers: [] }),
			result("missing-answers", "ask_user_question", { status: "answered", question: "No", mode: "text" }),
			result("bad-answer", "ask_user_question", { status: "answered", question: "No", mode: "text", answers: [{}] }),
			result("bad-batch", "ask_questions", { status: "answered", questions: [], answers: [] }),
			result("missing-indexes", "ask_questions", { status: "answered", questions: [{ question: "No" }], answers: [] }),
			result("partial-answers", "ask_questions", {
				status: "answered",
				questions: [{ question: "One" }, { question: "Two" }],
				answers: [{ questionIndex: 0, answer: null }],
			}),
			result("bad-tab", "resume_questions", { status: "answered", questions: [{ question: "No" }], answers: [{ questionIndex: 2, answer: null }] }),
		];
		for (const entry of excluded) assert.equal(questionResultLabel(entry), undefined);
	}],
	["session start preserves entries that already have labels", () => {
		const { hooks, labels } = register();
		const answered = result("answered", "ask_user_question", standaloneDetails("Keep label?"));
		fire(hooks, "session_start", [answered, { type: "label", id: "label-1", targetId: "answered", label: "Custom" }]);
		assert.deepEqual(labels, []);
	}],
	["session start preserves cleared label history", () => {
		const { hooks, labels } = register();
		const answered = result("answered", "ask_user_question", standaloneDetails("Stay cleared?"));
		fire(hooks, "session_start", [answered, { type: "label", id: "label-1", targetId: "answered", label: undefined }]);
		assert.deepEqual(labels, []);
	}],
	["agent_settled labels answers added after session start", () => {
		const { hooks, labels } = register();
		const entries: any[] = [];
		fire(hooks, "session_start", entries);
		entries.push(result("future", "ask_user_question", standaloneDetails("New answer?")));
		fire(hooks, "agent_settled", entries);
		assert.deepEqual(labels, [{ id: "future", label: "Q: New answer?" }]);
	}],
	["session tree labels answers exposed by branch navigation", () => {
		const { hooks, labels } = register();
		fire(hooks, "session_tree", [result("branch", "ask_user_question", standaloneDetails("Branch answer?"))]);
		assert.deepEqual(labels, [{ id: "branch", label: "Q: Branch answer?" }]);
	}],
	["branch navigation preserves the global label for a shared result", () => {
		const { hooks, labels } = register();
		const answered = result("shared", "ask_user_question", standaloneDetails("Shared answer?"));
		fire(hooks, "agent_settled", [answered]);
		fire(hooks, "session_tree", [
			answered,
			{ type: "label", id: "branch-label", targetId: "shared", label: "Q: Shared answer?" },
		]);
		assert.deepEqual(labels, [{ id: "shared", label: "Q: Shared answer?" }]);
	}],
	["repeated scans are idempotent once label history is present", () => {
		const { hooks, labels } = register();
		const answered = result("once", "ask_user_question", standaloneDetails("Only once?"));
		const entries = [answered];
		fire(hooks, "agent_settled", entries);
		fire(hooks, "agent_settled", entries);
		entries.push({ type: "label", id: "generated-label", targetId: "once", label: labels[0].label });
		fire(hooks, "agent_settled", entries);
		fire(hooks, "session_start", entries);
		assert.deepEqual(labels, [{ id: "once", label: "Q: Only once?" }]);
	}],
];

let passed = 0;
for (const [name, test] of tests) {
	test();
	passed++;
	console.log(`✓ ${name}`);
}
console.log(`${passed} tests passed; ${passed} tests executed`);
