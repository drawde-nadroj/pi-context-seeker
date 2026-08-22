const QUESTION_TOOLS = new Set(["ask_user_question", "ask_questions", "resume_questions"]);
const MAX_LABEL_LENGTH = 64;

type QuestionToolResultEntry = {
	type: "message";
	id: string;
	message: {
		role: "toolResult";
		toolName: string;
		details: Record<string, unknown>;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnswer(value: unknown): boolean {
	if (!isRecord(value) || typeof value.label !== "string" || typeof value.value !== "string") return false;
	if (value.type === "text" || value.type === "other") return true;
	return value.type === "option" && Number.isInteger(value.index) && (value.index as number) > 0;
}

function isStandaloneDetails(details: Record<string, unknown>): boolean {
	if (typeof details.question !== "string" || !["text", "single-select", "multi-select"].includes(String(details.mode))) return false;
	if (!Array.isArray(details.answers) || !details.answers.every(isAnswer)) return false;
	if (details.mode === "text") return details.answers.length === 1 && (details.answers[0] as Record<string, unknown>).type === "text";
	if (details.mode === "single-select") return details.answers.length === 1 && (details.answers[0] as Record<string, unknown>).type !== "text";
	return details.answers.length > 0 && details.answers.every((answer) => (answer as Record<string, unknown>).type !== "text");
}

function isPublicQuestion(value: unknown): value is { question: string } {
	if (!isRecord(value) || typeof value.question !== "string") return false;
	if (value.label !== undefined && typeof value.label !== "string") return false;
	if (value.details !== undefined && typeof value.details !== "string") return false;
	if (value.multiSelect !== undefined && typeof value.multiSelect !== "boolean") return false;
	return value.options === undefined || (Array.isArray(value.options) && value.options.every((option) => {
		if (!isRecord(option) || typeof option.label !== "string") return false;
		if (option.value !== undefined && typeof option.value !== "string") return false;
		if (option.description !== undefined && typeof option.description !== "string") return false;
		return option.recommended === undefined || typeof option.recommended === "boolean";
	}));
}

function isTabAnswer(value: unknown, questionCount: number): boolean {
	if (!isRecord(value) || !Number.isInteger(value.questionIndex)) return false;
	const index = value.questionIndex as number;
	if (index < 0 || index >= questionCount) return false;
	if (value.note !== undefined && typeof value.note !== "string") return false;
	if (typeof value.answer === "string" || value.answer === null || isAnswer(value.answer)) return true;
	return Array.isArray(value.answer) && value.answer.every(isAnswer);
}

function cleanLabelText(value: string): string {
	return value
		.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, " ")
		.trim();
}

function truncateLabel(value: string): string {
	const graphemes = Array.from(
		new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
		(part) => part.segment,
	);
	if (graphemes.length <= MAX_LABEL_LENGTH) return value;
	return `${graphemes.slice(0, MAX_LABEL_LENGTH - 1).join("").trimEnd()}…`;
}

/** Return a label only for completed question results with usable public details. */
export function questionResultLabel(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as Partial<QuestionToolResultEntry>;
	const message = candidate.type === "message" ? candidate.message : undefined;
	if (typeof candidate.id !== "string" || !candidate.id || !message || message.role !== "toolResult" || !QUESTION_TOOLS.has(message.toolName)) return undefined;
	const details = message.details;
	if (!details || typeof details !== "object" || details.status !== "answered") return undefined;

	if (message.toolName === "ask_user_question") {
		if (!isStandaloneDetails(details)) return undefined;
		const question = cleanLabelText(details.question as string);
		return question ? truncateLabel(`Q: ${question}`) : undefined;
	}

	if (!Array.isArray(details.questions) || details.questions.length === 0 || !details.questions.every(isPublicQuestion)) return undefined;
	const questions = details.questions;
	if (!Array.isArray(details.answers) || details.answers.length !== questions.length
		|| !details.answers.every((answer) => isTabAnswer(answer, questions.length))) return undefined;
	const indexes = new Set(details.answers.map((answer) => (answer as { questionIndex: number }).questionIndex));
	if (indexes.size !== questions.length) return undefined;
	const firstQuestion = cleanLabelText(questions[0].question);
	return firstQuestion ? truncateLabel(`Q×${questions.length}: ${firstQuestion}`) : undefined;
}
