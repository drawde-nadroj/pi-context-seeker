import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { askMultiChoice, askSingleChoice, askText, customWithAbort } from "./ask-user-question/standalone-ui.ts";
import { addWrappedWithPrefix, sanitizeDisplayText } from "./ask-user-question/tui-primitives.ts";
import { TabbedQuestions, type BatchUIResult } from "./ask-user-question/batch-ui.ts";
import {
	AskQuestionsParams, AskUserQuestionParams, type AskUserQuestionMode, type AskUserQuestionResultDetails,
	type BatchQuestionResultDetails, type QuestionDef, type TextAnswer,
	batchCancelledResult, batchUnavailableResult, buildBatchClarificationResult, buildBatchResult, buildClarificationResult, buildRegenerateResult,
	buildResult, cancelledResult, countRecommendedOptions, normalizeOptions, unavailableResult,
} from "./ask-user-question/domain.ts";

let uiLock = Promise.resolve();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = uiLock;
	let release: () => void;
	uiLock = new Promise<void>((r) => { release = r; });
	return prev.then(fn).finally(() => release!());
}

/**
 * Tell external agent-state integrations that Pi is waiting on a person.
 * `finally` is the ownership boundary: every active event is cleared even
 * when the dialog is cancelled, aborted, or fails unexpectedly.
 */
async function withHerdrBlocked<T>(
	pi: ExtensionAPI,
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	pi.events.emit("herdr:blocked", { active: true, label });
	try {
		return await fn();
	} finally {
		pi.events.emit("herdr:blocked", { active: false });
	}
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Supports choices or a multiline free-form response when options are omitted. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing. Present distinct viable options and mark at most one as recommended.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Provide distinct viable options for choice and decision questions. Users can write a custom answer with "Something else…" and add an optional note.',
			"Omit options for open-ended questions that ask the user to describe or explain something, or to share an experience; this opens a multiline free-form response.",
			"Use multiSelect: true only when you provide options and need multiple answers to the same question.",
			"If context supports a recommendation, mark exactly one singular best option with recommended: true; otherwise mark none. Never mark multiple options as recommended.",
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
			"If ask_user_question returns clarification_requested, answer the clarification and immediately call ask_user_question again with the original question before continuing work.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const optionsProvided = params.options !== undefined;
			if (countRecommendedOptions(params.options) > 1) {
				throw new Error("ask_user_question allows at most one recommended option. Retry the tool call with one singular best option marked, or none.");
			}
			const options = normalizeOptions(params.options);
			if (optionsProvided && options.length === 0) {
				throw new Error("ask_user_question requires at least one non-empty option when options are provided");
			}
			if (!optionsProvided && params.multiSelect) {
				throw new Error("ask_user_question multiSelect requires options");
			}
			const context = params.details?.trim() || undefined;
			const mode: AskUserQuestionMode = !optionsProvided
				? "text"
				: params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}

			if (!ctx.hasUI || ctx.mode !== "tui") {
				return unavailableResult(params.question, mode, "ask_user_question requires interactive TUI mode", context);
			}

			return withUILock(async () => {
				if (signal?.aborted) return cancelledResult(params.question, mode, context);
				return withHerdrBlocked(pi, "Waiting for your answer", async () => {
					if (mode === "text") {
						const result = await askText(ctx, params.question, context, signal);
						if (!result) return cancelledResult(params.question, mode, context);
						if ("action" in result) return buildClarificationResult(params.question, context, mode, options, result.clarification);
						const answer: TextAnswer = { type: "text", label: result.answer, value: result.answer };
						return buildResult(params.question, context, mode, [answer], result.note);
					}

					if (mode === "single-select") {
						const result = await askSingleChoice(ctx, params.question, context, options, signal);
						if (!result) return cancelledResult(params.question, mode, context);
						if ("action" in result) return buildClarificationResult(params.question, context, mode, options, result.clarification);
						return buildResult(params.question, context, mode, [result.answer], result.note);
					}

					const result = await askMultiChoice(ctx, params.question, context, options, signal);
					if (!result) return cancelledResult(params.question, mode, context);
					if ("action" in result) return buildClarificationResult(params.question, context, mode, options, result.clarification);
					return buildResult(params.question, context, mode, result.answer, result.note);
				});
			});
		},

		renderCall(args, theme) {
			const text =
				theme.fg("accent", theme.bold("? ")) +
				theme.fg("text", theme.bold(sanitizeDisplayText(args.question)));
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? sanitizeDisplayText(first.text) : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("muted", "○ No answer"), 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", "! Question unavailable"), 0, 0);
			}
			if (details.status === "clarification_requested") {
				return new Text(theme.fg("accent", "↪ Clarification requested"), 0, 0);
			}

			const labels = details.answers.map((answer) => sanitizeDisplayText(answer.label) || "(empty response)");
			if (details.mode !== "multi-select") {
				const lines = [
					theme.fg("success", "✓ ") + theme.fg("accent", labels[0] || "(empty response)"),
				];
				if (details.note?.trim()) lines.push(`  ${theme.fg("dim", `Note: ${sanitizeDisplayText(details.note.trim())}`)}`);
				return new Text(lines.join("\n"), 0, 0);
			}

			const lines = [theme.fg("success", `✓ ${labels.length} selected`)];
			for (const label of labels) {
				lines.push(`  ${theme.fg("dim", "•")} ${theme.fg("accent", label)}`);
			}
			if (details.note?.trim()) lines.push(`  ${theme.fg("dim", `Note: ${sanitizeDisplayText(details.note.trim())}`)}`);
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ──────────────────────────────────────────────────────────
	// ask_questions — batch tabbed multi-question tool
	// ──────────────────────────────────────────────────────────


	pi.registerTool({
		name: "ask_questions",
		label: "ask_questions",
		description:
			"Ask the user multiple related questions in a tabbed interface. A single Submit action finalizes completed answers; the user may explicitly skip the rest.",
		promptSnippet:
			"Use this tool to ask multiple related questions at once in a tabbed batch interface. Present distinct viable options and mark at most one as recommended per question.",
		promptGuidelines: [
			"Use ask_questions for 2+ related questions where the answers are needed together. For a single question, use ask_user_question instead.",
			"Provide distinct viable options for choice and decision questions; omit options for open-ended prompts that ask the user to describe, explain, or share an experience. Use multiSelect only with options.",
			"Mark at most one option as recommended per question. When recommending, mark exactly one singular best option based on context; otherwise mark none.",
			"Add a short label for semantic progress when useful; notes are optional.",
			"The user reviews completed answers before an explicit Submit and may intentionally skip unanswered questions. Use recommended: true for a recommendation; custom answers remain distinct.",
			"If the result status is regenerate, use the answered entries and notes as new understanding, do not repeat resolved questions, and immediately call ask_questions again with regenerated unanswered questions only.",
			"If ask_questions returns clarification_requested, answer the clarification, keep resolved answers as context, and immediately call ask_questions again with regenerated unanswered questions only.",
		],
		parameters: AskQuestionsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions: QuestionDef[] = params.questions.map((q: any, index: number) => {
				const optionsProvided = q.options !== undefined;
				if (countRecommendedOptions(q.options) > 1) {
					throw new Error(`ask_questions question ${index + 1} allows at most one recommended option. Retry the tool call with one singular best option marked, or none.`);
				}
				const opts = normalizeOptions(q.options);
				if (optionsProvided && opts.length === 0) {
					throw new Error(`ask_questions question ${index + 1} requires at least one non-empty option when options are provided`);
				}
				if (!optionsProvided && q.multiSelect) {
					throw new Error(`ask_questions question ${index + 1} cannot use multiSelect without options`);
				}
				const mode: AskUserQuestionMode = !optionsProvided
					? "text"
					: q.multiSelect ? "multi-select" : "single-select";
				return { question: q.question, label: q.label?.trim() || undefined, details: q.details?.trim() || undefined, mode, options: opts };
			});

			if (signal?.aborted) return batchCancelledResult(questions);

			if (!ctx.hasUI || ctx.mode !== "tui") {
				return batchUnavailableResult(questions);
			}

			return withUILock(async () => {
				if (signal?.aborted) return batchCancelledResult(questions);
				return withHerdrBlocked(pi, "Waiting for your answers", async () => {
					const result: BatchUIResult = await customWithAbort<any>(
						ctx,
						signal,
						(tui: any, theme: any, kb: any, done: (r: any) => void) =>
							new TabbedQuestions(questions, tui, theme, kb, done),
					);
					if (!result) return batchCancelledResult(questions);
					if (!Array.isArray(result)) {
						if (result.action === "clarification") return buildBatchClarificationResult(questions, result.answers, result.activeQuestionIndex, result.clarification);
						return buildRegenerateResult(questions, result.answers);
					}
					return buildBatchResult(questions, result);
				});
			});
		},

		renderCall(args, theme) {
			const count = ((args.questions as Array<{ question: string }>) || []).length;
			const noun = count === 1 ? "question" : "questions";
			return new Text(
				theme.fg("accent", theme.bold("? ")) +
					theme.fg("text", theme.bold(`${count} ${noun} for you`)),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as BatchQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? sanitizeDisplayText(first.text) : "", 0, 0);
			}
			if (details.status === "cancelled") {
				return new Text(theme.fg("muted", "○ Questions cancelled"), 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", "! Questions unavailable"), 0, 0);
			}
			if (details.status === "regenerate") {
				return new Text(theme.fg("accent", `↻ Regenerate ${details.unansweredQuestions?.length ?? 0} unanswered`), 0, 0);
			}
			if (details.status === "clarification_requested") {
				return new Text(theme.fg("accent", "↪ Clarification requested"), 0, 0);
			}

			const questionCount = details.questions.length;
			const skippedIndexes = new Set(details.skippedQuestionIndexes ?? []);
			const answerCount = questionCount - skippedIndexes.size;
			const noun = answerCount === 1 ? "answer" : "answers";
			return {
				invalidate(): void {},
				render(width: number): string[] {
					const lines: string[] = [];
					const heading = skippedIndexes.size > 0
						? `✓ ${answerCount} ${noun} · ${skippedIndexes.size} skipped`
						: `✓ ${answerCount} ${noun}`;
					addWrappedWithPrefix(lines, "", theme.fg("success", heading), width, "");
					for (let index = 0; index < questionCount; index++) {
						const tabAnswer = details.answers.find((answer) => answer.questionIndex === index);
						if (!tabAnswer) continue;

						let labels: string[];
						if (skippedIndexes.has(index)) {
							labels = ["(skipped)"];
						} else if (typeof tabAnswer.answer === "string") {
							labels = [sanitizeDisplayText(tabAnswer.answer) || "(empty response)"];
						} else if (Array.isArray(tabAnswer.answer)) {
							labels = tabAnswer.answer.map((answer) => sanitizeDisplayText(answer.label) || "(empty response)");
						} else if (tabAnswer.answer && typeof tabAnswer.answer === "object") {
							labels = [sanitizeDisplayText(tabAnswer.answer.label) || "(empty response)"];
						} else {
							labels = [skippedIndexes.has(index) ? "(skipped)" : "(no response)"];
						}

						const questionPrefix = `  ${theme.fg("dim", `${index + 1}`)}  `;
						addWrappedWithPrefix(
							lines,
							questionPrefix,
							theme.fg("muted", sanitizeDisplayText(details.questions[index].question)),
							width,
							" ".repeat(visibleWidth(questionPrefix)),
						);
						addWrappedWithPrefix(lines, "     ", theme.fg("accent", labels.join(" · ")), width, "     ");
						if (tabAnswer.note?.trim()) {
							addWrappedWithPrefix(lines, "     ", theme.fg("muted", "Note"), width, "     ");
							for (const noteLine of tabAnswer.note.trim().split("\n")) {
								addWrappedWithPrefix(lines, "       ", theme.fg("dim", sanitizeDisplayText(noteLine) || " "), width, "       ");
							}
						}
					}
					return lines;
				},
			};
		},
	});
}
