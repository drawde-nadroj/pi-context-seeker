import { Type } from "typebox";

export interface AskOption {
	label: string;
	value: string;
	description?: string;
	recommended?: boolean;
}

export interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

export interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

export interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

export type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
export type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable" | "regenerate" | "clarification_requested";
export type AskUserQuestionMode = "text" | "single-select" | "multi-select";

export interface PublicQuestionDef {
	question: string;
	label?: string;
	details?: string;
	options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
	multiSelect?: boolean;
}

export interface QuestionDef {
	id?: string;
	question: string;
	label?: string;
	details?: string;
	mode: AskUserQuestionMode;
	options: AskOption[];
}

export interface TabAnswer {
	questionIndex: number;
	answer: AskAnswer | AskAnswer[] | string | null;
	note?: string;
}

export interface ClarificationTurn {
	role: "user" | "assistant";
	content: string;
}

export interface SerializedTabState {
	questionIndex: number;
	mode: AskUserQuestionMode;
	answer: AskAnswer | AskAnswer[] | string | null;
	textBuffer: string;
	otherText: string;
	selected: AskAnswer[];
	note: string;
}

export interface BatchContinuation {
	questions: QuestionDef[];
	tabs: SerializedTabState[];
	activeQuestionIndex: number;
	originQuestionId: string;
	editingOtherQuestionId?: string;
	clarificationTurns: ClarificationTurn[];
	clarificationOpen?: boolean;
	updatedQuestionIds: string[];
}

export interface BatchQuestionResultDetails {
	status: AskUserQuestionStatus;
	questions: PublicQuestionDef[];
	answers: TabAnswer[];
	unansweredQuestions?: PublicQuestionDef[];
	unansweredNotes?: Array<{ questionIndex: number; note: string }>;
	skippedQuestionIndexes?: number[];
	clarification?: string;
	activeQuestionIndex?: number;
	questionIndex?: number;
	activeDraft?: TabAnswer;
	message?: string;
	continuationId?: string;
	revision?: number;
	continuation?: BatchContinuation;
	continuationState?: "awaiting-response" | "completed" | "cancelled" | "regenerated" | "unavailable";
}

export interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	options?: AskOption[];
	clarification?: string;
	continuation?: StandaloneContinuation;
	note?: string;
	message?: string;
}

export interface AnswerWithNote<T> {
	answer: T;
	note: string;
}

export interface StandaloneContinuation {
	answerText?: string;
	otherText?: string;
	selected?: AskAnswer[];
	stagedAnswer?: AskAnswer | null;
	editingOther?: boolean;
	noteFocused?: boolean;
	note: string;
}

export interface ClarificationRequest {
	action: "clarification";
	clarification: string;
	continuation: StandaloneContinuation;
}

export interface TabState {
	questionIndex: number;
	mode: AskUserQuestionMode;
	answer: AskAnswer | AskAnswer[] | string | null;
	textBuffer: string;
	otherText: string;
	selected: Map<string, AskAnswer>;
	note: string;
}

export const OptionSchema = Type.Object({
	label: Type.String({
		description: "Display label for the option. Must contain non-whitespace text; use recommended instead of changing this label.",
		pattern: "\\S",
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
	recommended: Type.Optional(
		Type.Boolean({ description: "Marks this as the singular best option. Set this on at most one option per question; do not change the label or value." }),
	),
});

export const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Distinct viable choices for a decision question. Mark at most one option as recommended. Omit this field for an open-ended prompt that should use a multiline free-form response. When provided, the UI also offers Something else….",
			minItems: 1,
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

export const BatchQuestionSchema = Type.Object({
	question: Type.String({ description: "The question text to display." }),
	label: Type.Optional(Type.String({ description: "Short semantic label used in batch progress, such as Database or Auth." })),
	details: Type.Optional(Type.String({ description: "Optional extra context or instructions shown under the question." })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Distinct viable choices. Mark at most one option as recommended. Omit for free text.", minItems: 1 })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple answers." })),
});

const BatchQuestionsSchema = Type.Array(BatchQuestionSchema, {
	description: "Questions to display in the tabbed interface.",
	minItems: 1,
});
const ContinuationIdSchema = Type.String({ description: "Opaque continuation ID returned by a clarification result." });
const ContinuationRevisionSchema = Type.Integer({ description: "Exact awaiting-response revision returned by that result.", minimum: 1 });
const ContinuationResponseSchema = Type.String({ description: "The assistant's answer to the user's clarification." });
const QuestionRevisionsSchema = Type.Array(Type.Object({
	questionNumber: Type.Integer({ description: "Public one-based question number to replace.", minimum: 1 }),
	question: Type.String({ description: "Complete replacement question text." }),
	label: Type.Optional(Type.String({ description: "Optional short semantic label." })),
	details: Type.Optional(Type.String({ description: "Optional extra context." })),
	options: Type.Optional(Type.Array(OptionSchema, { minItems: 1 })),
	multiSelect: Type.Optional(Type.Boolean()),
}), { description: "Sparse complete replacements for eligible later questions. Use [] when no question changes are needed." });

// The optional resume fields keep pre-reload ask_questions contracts executable.
// execute() enforces exactly one complete mode without Google-incompatible unions.
export const AskQuestionsParams = Type.Object({
	questions: Type.Optional(BatchQuestionsSchema),
	continuationId: Type.Optional(ContinuationIdSchema),
	revision: Type.Optional(ContinuationRevisionSchema),
	response: Type.Optional(ContinuationResponseSchema),
	revisions: Type.Optional(QuestionRevisionsSchema),
});

export const ResumeQuestionsParams = Type.Object({
	continuationId: ContinuationIdSchema,
	revision: ContinuationRevisionSchema,
	response: ContinuationResponseSchema,
	revisions: QuestionRevisionsSchema,
});

export function countRecommendedOptions(options: Array<{ label: string; recommended?: boolean }> | undefined): number {
	return (options ?? []).filter((option) => option.recommended === true || /\s*\(Recommended\)$/i.test(option.label.trim())).length;
}

export function normalizeOptions(options: Array<{ label: string; value?: string; description?: string; recommended?: boolean }> | undefined): AskOption[] {
	const normalized = (options || [])
		.map((option) => {
			const rawLabel = option.label.trim();
			const legacyRecommended = /\s*\(Recommended\)$/i.test(rawLabel);
			const label = legacyRecommended ? rawLabel.replace(/\s*\(Recommended\)$/i, "").trim() : rawLabel;
			return {
				label,
				value: option.value?.trim() || label,
				description: option.description?.trim() || undefined,
				recommended: option.recommended || legacyRecommended || undefined,
			};
		})
		.filter((option) => option.label.length > 0);
	return [
		...normalized.filter((option) => option.recommended),
		...normalized.filter((option) => !option.recommended),
	];
}

export function getOtherLabel(options: AskOption[]): string {
	const label = "Something else…";
	return options.some((option) => option.label.toLowerCase() === label.toLowerCase())
		? `${label} (custom)`
		: label;
}

export function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Custom answer: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

export function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 2;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

export function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

export function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
	note?: string,
) {
	return {
		status,
		question,
		context,
		mode,
		answers,
		note,
		message,
	} as AskUserQuestionResultDetails;
}

export function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

export function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

export function toPublicQuestions(questions: QuestionDef[]): PublicQuestionDef[] {
	return questions.map((question) => ({
		question: question.question,
		...(question.label ? { label: question.label } : {}),
		...(question.details ? { details: question.details } : {}),
		...(question.mode === "text" ? {} : {
			options: question.options.map(({ label, value, description, recommended }) => ({
				label,
				...(value !== label ? { value } : {}),
				...(description ? { description } : {}),
				...(recommended ? { recommended: true } : {}),
			})),
			...(question.mode === "multi-select" ? { multiSelect: true } : {}),
		}),
	}));
}

function withoutInternalIds(questions: QuestionDef[]): PublicQuestionDef[] {
	return toPublicQuestions(questions);
}

export function batchCancelledResult(questions: QuestionDef[]) {
	const publicQuestions = withoutInternalIds(questions);
	const message = "Questions cancelled.";
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "cancelled" as const, questions: publicQuestions, answers: [], message } as BatchQuestionResultDetails,
	};
}

export function batchUnavailableResult(questions: QuestionDef[]) {
	const publicQuestions = withoutInternalIds(questions);
	const message = "ask_questions requires interactive TUI mode";
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "unavailable" as const, questions: publicQuestions, answers: [] } as BatchQuestionResultDetails,
	};
}

export function buildBatchResult(questions: QuestionDef[], answers: TabAnswer[]) {
	const publicQuestions = withoutInternalIds(questions);
	const isAnswered = (entry: TabAnswer | undefined) => {
		if (typeof entry?.answer === "string") return entry.answer.trim().length > 0;
		return entry?.answer !== null && entry?.answer !== undefined && (!Array.isArray(entry.answer) || entry.answer.length > 0);
	};
	const skippedQuestionIndexes = publicQuestions
		.map((_question, index) => index)
		.filter((index) => !isAnswered(answers.find((answer) => answer.questionIndex === index)));
	const answeredCount = publicQuestions.length - skippedQuestionIndexes.length;
	const lines = skippedQuestionIndexes.length > 0
		? [`User submitted ${answeredCount} ${answeredCount === 1 ? "answer" : "answers"} and skipped ${skippedQuestionIndexes.length} ${skippedQuestionIndexes.length === 1 ? "question" : "questions"}.`]
		: [`User answered all ${publicQuestions.length} questions.`];

	publicQuestions.forEach((question, questionIndex) => {
		const tabAnswer = answers.find((answer) => answer.questionIndex === questionIndex);
		let answerText = "(skipped by user)";
		if (typeof tabAnswer?.answer === "string" && tabAnswer.answer.trim()) {
			answerText = tabAnswer.answer.trim();
		} else if (Array.isArray(tabAnswer?.answer) && tabAnswer.answer.length > 0) {
			answerText = tabAnswer.answer.map(formatAnswerForModel).join(", ");
		} else if (tabAnswer?.answer && typeof tabAnswer.answer !== "string" && !Array.isArray(tabAnswer.answer)) {
			answerText = formatAnswerForModel(tabAnswer.answer);
		}

		lines.push(`Q${questionIndex + 1}: ${question.question}`);
		lines.push(`Answer: ${answerText}`);
		if (tabAnswer?.note?.trim()) lines.push(`Note: ${tabAnswer.note.trim()}`);
	});

	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			status: "answered" as const,
			questions: publicQuestions,
			answers,
			...(skippedQuestionIndexes.length > 0 ? { skippedQuestionIndexes } : {}),
		} as BatchQuestionResultDetails,
	};
}

export function buildRegenerateResult(questions: QuestionDef[], answers: TabAnswer[]) {
	const publicQuestions = withoutInternalIds(questions);
	const answered = answers.filter((entry): entry is TabAnswer & { answer: Exclude<TabAnswer["answer"], null> } => {
		if (typeof entry.answer === "string") return entry.answer.trim().length > 0;
		return entry.answer !== null && (!Array.isArray(entry.answer) || entry.answer.length > 0);
	});
	const answeredIndexes = new Set(answered.map((entry) => entry.questionIndex));
	const unansweredQuestions = publicQuestions.filter((_question, index) => !answeredIndexes.has(index));
	const unansweredNotes = answers
		.filter((entry) => !answeredIndexes.has(entry.questionIndex) && entry.note?.trim())
		.map((entry) => ({ questionIndex: entry.questionIndex, note: entry.note!.trim() }));
	const unansweredNoteByIndex = new Map(unansweredNotes.map((entry) => [entry.questionIndex, entry.note]));
	const lines = [
		"Regenerate the remaining batch questions now using the user's new understanding below.",
		"Do not repeat resolved questions. Immediately call ask_questions again with regenerated unanswered questions only.",
	];
	for (const entry of answered) {
		const question = questions[entry.questionIndex];
		const values = typeof entry.answer === "string"
			? entry.answer.trim()
			: (Array.isArray(entry.answer) ? entry.answer : [entry.answer]).map(formatAnswerForModel).join(", ");
		lines.push(`Q${entry.questionIndex + 1}: ${question.question}`, `Answer: ${values}`);
		if (entry.note?.trim()) lines.push(`Note: ${entry.note.trim()}`);
	}
	questions.forEach((question, questionIndex) => {
		if (answeredIndexes.has(questionIndex)) return;
		const semantics = question.mode === "multi-select"
			? "multi-select (choose one or more choices)"
			: question.mode === "single-select"
				? "single-select (choose one choice)"
				: "text (free-text answer)";
		lines.push(`Unanswered Q${questionIndex + 1}: ${question.question}`);
		if (question.details) lines.push(`Details: ${question.details}`);
		lines.push(`Answer mode: ${semantics}`);
		if (question.options?.length) {
			lines.push("Choices:", ...question.options.map((option) => `- ${option.label}${option.description ? ` — ${option.description}` : ""}`));
		}
		const note = unansweredNoteByIndex.get(questionIndex);
		if (note) lines.push(`Note: ${note}`);
	});
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			status: "regenerate" as const,
			questions: publicQuestions,
			answers: answered,
			unansweredQuestions,
			unansweredNotes,
			message: lines.slice(0, 2).join(" "),
		} as BatchQuestionResultDetails,
	};
}

export function buildClarificationResult(
	question: string,
	context: string | undefined,
	mode: AskUserQuestionMode,
	options: AskOption[],
	clarification: string,
	continuation: StandaloneContinuation,
) {
	const semantics = mode === "text" ? "text (free-text answer)" : mode === "multi-select" ? "multi-select (choose one or more choices)" : "single-select (choose one choice)";
	const lines = [
		`The user paused this question to ask: ${clarification}`,
		"Answer the clarification in normal assistant text, then immediately call ask_user_question again before continuing work.",
		`Original question: ${question}`,
	];
	if (context) lines.push(`Details: ${context}`);
	lines.push(`Answer mode: ${semantics}`);
	if (options.length) lines.push("Choices:", ...options.map((option) => `- ${option.label}${option.value !== option.label ? ` [value: ${option.value}]` : ""}${option.description ? ` — ${option.description}` : ""}${option.recommended ? " (recommended)" : ""}`));
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: { ...buildStructuredResult("clarification_requested", question, mode, [], context, lines[1]), clarification, options, continuation },
	};
}

export function revisionProtectionReason(continuation: BatchContinuation, index: number): string | undefined {
	const originIndex = continuation.questions.findIndex((question) => question.id === continuation.originQuestionId);
	if (index <= originIndex) return index === originIndex ? "clarification origin" : "at or before clarification origin";
	const tab = continuation.tabs[index];
	if (!tab) return "missing state";
	const committed = typeof tab.answer === "string" ? tab.answer.trim().length > 0 : tab.answer !== null && (!Array.isArray(tab.answer) || tab.answer.length > 0);
	if (committed) return "has a committed answer";
	if (tab.textBuffer.trim()) return "has a text draft";
	if (tab.otherText.trim()) return "has a custom draft";
	if (tab.note.trim()) return "has a note";
	if (tab.selected.length > 0) return "has a tentative selection";
	return undefined;
}

export function buildBatchClarificationResult(continuationId: string, revision: number, continuation: BatchContinuation, clarification: string) {
	const originIndex = continuation.questions.findIndex((question) => question.id === continuation.originQuestionId);
	const lines = [
		`The user paused at Q${originIndex + 1} to ask: ${clarification}`,
		`This is the batch's shared clarification thread. Interpret the request using the full batch and every current answer, draft, custom answer, and note. Q${originIndex + 1} is the origin only for revision eligibility and resume position, not a reference restriction.`,
		"Questions and revision eligibility:",
	];
	toPublicQuestions(continuation.questions).forEach((question, index) => {
		const reason = revisionProtectionReason(continuation, index);
		const tab = continuation.tabs[index];
		lines.push(`Q${index + 1}: ${JSON.stringify(question)}`);
		if (tab) {
			const answer = typeof tab.answer === "string"
				? tab.answer.trim()
				: tab.answer
					? (Array.isArray(tab.answer) ? tab.answer : [tab.answer]).map(formatAnswerForModel).join(", ")
					: "";
			lines.push(`Current answer: ${answer || "(none)"}`);
			if (tab.textBuffer.trim() && tab.textBuffer.trim() !== answer) lines.push(`Current draft: ${tab.textBuffer.trim()}`);
			if (tab.otherText.trim()) lines.push(`Current custom text: ${tab.otherText.trim()}`);
			if (tab.note.trim()) lines.push(`Current note: ${tab.note.trim()}`);
		}
		lines.push(reason ? `Eligibility: protected — ${reason}.` : "Eligibility: eligible for revision.");
	});
	lines.push(
		"Answer the clarification normally, then make one atomic resume_questions call with continuationId, revision, response, and every relevant eligible later revision.",
		"Use revisions: [] when none are needed. Each revision must use questionNumber and a complete public question definition; never send internal IDs.",
		`Continuation ID: ${continuationId}`,
		`Revision: ${revision}`,
	);
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			status: "clarification_requested" as const,
			questions: toPublicQuestions(continuation.questions),
			answers: continuation.tabs.map((tab) => ({ questionIndex: tab.questionIndex, answer: tab.answer, note: tab.note })),
			clarification,
			activeQuestionIndex: continuation.activeQuestionIndex,
			questionIndex: originIndex,
			continuationId,
			revision,
			continuation,
			continuationState: "awaiting-response" as const,
			message: lines.slice(0, 2).join(" "),
		} as BatchQuestionResultDetails,
	};
}

export function answerSelectionKey(answer: AskAnswer): string | undefined {
	if (answer.type === "option") return `option:${answer.index - 1}`;
	if (answer.type === "other") return "other";
	return undefined;
}

export function buildResult(
	question: string,
	context: string | undefined,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	note = "",
) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.trim().length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	const trimmedNote = note.trim();
	if (trimmedNote) text += `\nNote: ${trimmedNote}`;

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context, undefined, trimmedNote || undefined),
	};
}
