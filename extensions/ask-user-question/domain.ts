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

export interface QuestionDef {
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

export interface BatchQuestionResultDetails {
	status: AskUserQuestionStatus;
	questions: QuestionDef[];
	answers: TabAnswer[];
	unansweredQuestions?: QuestionDef[];
	unansweredNotes?: Array<{ questionIndex: number; note: string }>;
	clarification?: string;
	activeQuestionIndex?: number;
	activeDraft?: TabAnswer;
	message?: string;
}

export interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	options?: AskOption[];
	clarification?: string;
	note?: string;
	message?: string;
}

export interface AnswerWithNote<T> {
	answer: T;
	note: string;
}

export interface ClarificationRequest {
	action: "clarification";
	clarification: string;
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
		Type.Boolean({ description: "Show a Recommended badge without changing the option label or value." }),
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
				"Choices for a decision question. Omit this field for an open-ended prompt that should use a multiline free-form response. When provided, the UI also offers Something else….",
			minItems: 1,
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

export const AskQuestionsParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({
				description: "The question text to display.",
			}),
			label: Type.Optional(
				Type.String({ description: "Short semantic label used in batch progress, such as Database or Auth." }),
			),
			details: Type.Optional(
				Type.String({
					description: "Optional extra context or instructions shown under the question.",
				}),
			),
			options: Type.Optional(
				Type.Array(OptionSchema, {
					description:
						"Choices for a decision question. Omit this field for an open-ended prompt that should use a multiline free-form response. When provided, the UI also offers Something else….",
					minItems: 1,
				}),
			),
			multiSelect: Type.Optional(
				Type.Boolean({
					description: "Set to true to allow multiple answers to be selected for this question.",
				}),
			),
		}),
		{
			description: "Array of questions to display in tabbed interface. At least one question is required.",
			minItems: 1,
		},
	),
});

export function normalizeOptions(options: Array<{ label: string; value?: string; description?: string; recommended?: boolean }> | undefined): AskOption[] {
	return (options || [])
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

export function batchCancelledResult(questions: QuestionDef[]) {
	const message = "Questions cancelled.";
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "cancelled" as const, questions, answers: [], message } as BatchQuestionResultDetails,
	};
}

export function batchUnavailableResult(questions: QuestionDef[]) {
	const message = "ask_questions requires interactive TUI mode";
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "unavailable" as const, questions, answers: [] } as BatchQuestionResultDetails,
	};
}

export function buildBatchResult(questions: QuestionDef[], answers: TabAnswer[]) {
	const lines = [`User answered all ${questions.length} questions.`];
	questions.forEach((question, questionIndex) => {
		const tabAnswer = answers.find((answer) => answer.questionIndex === questionIndex);
		let answerText = "(no answer)";
		if (typeof tabAnswer?.answer === "string") {
			answerText = tabAnswer.answer.trim() || "(empty response)";
		} else if (Array.isArray(tabAnswer?.answer)) {
			answerText = tabAnswer.answer.length > 0
				? tabAnswer.answer.map(formatAnswerForModel).join(", ")
				: "(none selected)";
		} else if (tabAnswer?.answer) {
			answerText = formatAnswerForModel(tabAnswer.answer);
		}

		lines.push(`Q${questionIndex + 1}: ${question.question}`);
		lines.push(`Answer: ${answerText}`);
		if (tabAnswer?.note?.trim()) lines.push(`Note: ${tabAnswer.note.trim()}`);
	});

	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: { status: "answered" as const, questions, answers } as BatchQuestionResultDetails,
	};
}

export function buildRegenerateResult(questions: QuestionDef[], answers: TabAnswer[]) {
	const answered = answers.filter((entry): entry is TabAnswer & { answer: Exclude<TabAnswer["answer"], null> } => {
		if (typeof entry.answer === "string") return entry.answer.trim().length > 0;
		return entry.answer !== null && (!Array.isArray(entry.answer) || entry.answer.length > 0);
	});
	const answeredIndexes = new Set(answered.map((entry) => entry.questionIndex));
	const unansweredQuestions = questions.filter((_question, index) => !answeredIndexes.has(index));
	const unansweredNotes = answers
		.filter((entry) => !answeredIndexes.has(entry.questionIndex) && entry.note?.trim())
		.map((entry) => ({ questionIndex: entry.questionIndex, note: entry.note!.trim() }));
	const unansweredNoteByIndex = new Map(unansweredNotes.map((entry) => [entry.questionIndex, entry.note]));
	const lines = [
		"Regenerate the remaining batch questions now using the user's new understanding below.",
		"Do not repeat resolved questions. Immediately call ask_questions again with revised unanswered questions only.",
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
			questions,
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
		details: { ...buildStructuredResult("clarification_requested", question, mode, [], context, lines[1]), clarification, options },
	};
}

export function buildBatchClarificationResult(questions: QuestionDef[], answers: TabAnswer[], activeQuestionIndex: number, clarification: string) {
	const activeDraft = answers.find((entry) => entry.questionIndex === activeQuestionIndex);
	const unresolvedAnswers = answers.map((entry) => entry.questionIndex === activeQuestionIndex
		? { ...entry, answer: null }
		: entry);
	const base = buildRegenerateResult(questions, unresolvedAnswers);
	const lines = [
		`The user paused the batch to ask: ${clarification}`,
		"Answer the clarification in normal assistant text, then immediately call ask_questions again with revised unanswered questions only before continuing work.",
		"Do not repeat resolved questions. Committed answers and notes are resolved context.",
		`Current unresolved question: Q${activeQuestionIndex + 1}: ${questions[activeQuestionIndex]?.question ?? "(unknown)"}`,
	];
	const activeDraftAnswer = activeDraft?.answer;
	if (typeof activeDraftAnswer === "string") {
		if (activeDraftAnswer.trim()) lines.push(`Current draft: ${activeDraftAnswer.trim()}`);
	} else if (Array.isArray(activeDraftAnswer)) {
		if (activeDraftAnswer.length > 0) lines.push(`Current draft: ${activeDraftAnswer.map(formatAnswerForModel).join(", ")}`);
	} else if (activeDraftAnswer) {
		lines.push(`Current draft: ${formatAnswerForModel(activeDraftAnswer)}`);
	}
	lines.push(base.content[0].text);
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			...base.details,
			status: "clarification_requested" as const,
			clarification,
			activeQuestionIndex,
			activeDraft,
			message: lines.slice(0, 3).join(" "),
		},
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
