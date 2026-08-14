import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { askMultiChoice, askSingleChoice, askText, customWithAbort } from "./ask-user-question/standalone-ui.ts";
import { addWrappedWithPrefix, sanitizeDisplayText } from "./ask-user-question/tui-primitives.ts";
import { TabbedQuestions, type BatchUIResult } from "./ask-user-question/batch-ui.ts";
import {
	AskQuestionsParams, ResumeQuestionsParams, AskUserQuestionParams, type AskUserQuestionMode, type AskUserQuestionResultDetails,
	type BatchContinuation, type BatchQuestionResultDetails, type QuestionDef, type TextAnswer,
	batchCancelledResult, batchUnavailableResult, buildBatchClarificationResult, buildBatchResult, buildClarificationResult, buildRegenerateResult,
	buildResult, cancelledResult, countRecommendedOptions, normalizeOptions, revisionProtectionReason, unavailableResult,
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

function renderClarificationRequested(clarification: string | undefined, theme: any) {
	const heading = theme.fg("accent", "↪ Clarification requested");
	const request = clarification?.trim();
	if (!request) return new Text(heading, 0, 0);
	const indented = sanitizeDisplayText(request)
		.split(/\r?\n/)
		.map((line) => `  ${theme.fg("text", line || " ")}`)
		.join("\n");
	return new Text(`${heading}\n${indented}`, 0, 0);
}

function renderBatchResult(result: any, _options: any, theme: any) {
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
		return renderClarificationRequested(details.clarification, theme);
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
}

export default function askUserQuestion(pi: ExtensionAPI) {
	let continuationClaims = new WeakMap<object, Set<string>>();
	const resetContinuationClaims = () => { continuationClaims = new WeakMap<object, Set<string>>(); };
	pi.on("session_start", resetContinuationClaims);
	pi.on("session_tree", resetContinuationClaims);

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
			const latestMatchingResult = (ctx.sessionManager?.getBranch?.() ?? [])
				.map((entry: any) => entry?.message)
				.filter((message: any) => message?.role === "toolResult" && message?.toolName === "ask_user_question"
					&& message?.details?.question === params.question
					&& message?.details?.context === context
					&& message?.details?.mode === mode)
				.at(-1)?.details;
			const resumedState = latestMatchingResult?.status === "clarification_requested"
				&& JSON.stringify(latestMatchingResult.options ?? []) === JSON.stringify(options)
				? latestMatchingResult.continuation
				: undefined;

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
						const result = await askText(ctx, params.question, context, signal, resumedState);
						if (!result) return cancelledResult(params.question, mode, context);
						if ("action" in result) return buildClarificationResult(params.question, context, mode, options, result.clarification, result.continuation);
						const answer: TextAnswer = { type: "text", label: result.answer, value: result.answer };
						return buildResult(params.question, context, mode, [answer], result.note);
					}

					if (mode === "single-select") {
						const result = await askSingleChoice(ctx, params.question, context, options, signal, resumedState);
						if (!result) return cancelledResult(params.question, mode, context);
						if ("action" in result) return buildClarificationResult(params.question, context, mode, options, result.clarification, result.continuation);
						return buildResult(params.question, context, mode, [result.answer], result.note);
					}

					const result = await askMultiChoice(ctx, params.question, context, options, signal, resumedState);
					if (!result) return cancelledResult(params.question, mode, context);
					if ("action" in result) return buildClarificationResult(params.question, context, mode, options, result.clarification, result.continuation);
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
				return renderClarificationRequested(details.clarification, theme);
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



	async function executeBatch(_toolCallId: string, questionsParams: any[] | undefined, request: any | undefined, signal: any, ctx: any) {
		const hasResume = request !== undefined;
		if (hasResume && (typeof request.response !== "string" || !request.response.trim())) throw new Error("resume response must contain the assistant clarification answer");
		if (hasResume && !Array.isArray(request.revisions)) throw new Error("resume revisions must be an array (use [] when unchanged)");

		return withUILock(async () => {
				let resumedState: BatchContinuation | undefined;
				let continuationId = randomUUID();
				let revision = 0;
				let claimKey: string | undefined;
				let claims: Set<string> | undefined;
				if (hasResume) {
					const entries: any[] = ctx.sessionManager?.getBranch?.() ?? [];
					const lifecycle = entries.map((entry: any) => entry?.message)
						.filter((message: any) => message?.role === "toolResult" && (message?.toolName === "ask_questions" || message?.toolName === "resume_questions") && message?.details?.continuationId === request.continuationId)
						.at(-1)?.details;
					if (!lifecycle) throw new Error(`Unknown continuation: ${request.continuationId}`);
					if (lifecycle.continuationState !== "awaiting-response" || lifecycle.revision !== request.revision) throw new Error(`Stale continuation revision for ${request.continuationId}`);
					if (!lifecycle.continuation) throw new Error(`Malformed continuation: ${request.continuationId}`);
					const sessionKey = (ctx.sessionManager ?? ctx) as object;
					claims = continuationClaims.get(sessionKey) ?? new Set<string>();
					continuationClaims.set(sessionKey, claims);
					claimKey = `${request.continuationId}:${request.revision}`;
					if (claims.has(claimKey)) throw new Error(`Continuation revision already resumed for ${request.continuationId}`);
					claims.add(claimKey);
					continuationId = request.continuationId;
					revision = request.revision;
				}

				try {
					if (hasResume) {
						resumedState = structuredClone((ctx.sessionManager?.getBranch?.() ?? []).map((entry: any) => entry?.message).filter((message: any) => message?.role === "toolResult" && (message?.toolName === "ask_questions" || message?.toolName === "resume_questions") && message?.details?.continuationId === request.continuationId).at(-1)?.details.continuation);
						if (!Array.isArray(resumedState!.clarificationTurns)) throw new Error("Malformed continuation: shared clarification transcript is missing");
						const originIndex = resumedState!.questions.findIndex((question) => question.id === resumedState!.originQuestionId);
						if (originIndex < 0) throw new Error("Malformed continuation: clarification origin question is missing");

						const replacements: Array<{ index: number; question: QuestionDef }> = [];
						const seen = new Set<number>();
						for (const proposed of request.revisions) {
							const number = proposed?.questionNumber;
							if (!Number.isInteger(number)) throw new Error("revision questionNumber must be an integer");
							if (seen.has(number)) throw new Error(`duplicate revision for question ${number}`);
							seen.add(number);
							const index = number - 1;
							if (index < 0 || index >= resumedState!.questions.length) throw new Error(`revision question ${number} is out of range`);
							const protectedReason = revisionProtectionReason(resumedState!, index);
							if (protectedReason) throw new Error(`revision question ${number} is protected: ${protectedReason}`);
							if (typeof proposed.question !== "string" || !proposed.question.trim()) throw new Error(`revision question ${number} must contain nonblank question text`);
							if (proposed.label !== undefined && typeof proposed.label !== "string") throw new Error(`revision question ${number} has an invalid label`);
							if (proposed.details !== undefined && typeof proposed.details !== "string") throw new Error(`revision question ${number} has invalid details`);
							if (proposed.multiSelect !== undefined && typeof proposed.multiSelect !== "boolean") throw new Error(`revision question ${number} has an invalid selection mode`);
							const optionsProvided = proposed.options !== undefined;
							if (optionsProvided && (!Array.isArray(proposed.options) || proposed.options.some((option: any) => !option || typeof option.label !== "string" || (option.value !== undefined && typeof option.value !== "string") || (option.description !== undefined && typeof option.description !== "string") || (option.recommended !== undefined && typeof option.recommended !== "boolean")))) throw new Error(`revision question ${number} has invalid options`);
							if (countRecommendedOptions(proposed.options) > 1) throw new Error(`revision question ${number} allows at most one recommended option`);
							const options = normalizeOptions(proposed.options);
							if (optionsProvided && options.length === 0) throw new Error(`revision question ${number} requires at least one non-empty option`);
							if (!optionsProvided && proposed.multiSelect) throw new Error(`revision question ${number} cannot use multiSelect without options`);
							const mode: AskUserQuestionMode = !optionsProvided ? "text" : proposed.multiSelect ? "multi-select" : "single-select";
							replacements.push({ index, question: { id: resumedState!.questions[index].id, question: proposed.question.trim(), label: proposed.label?.trim() || undefined, details: proposed.details?.trim() || undefined, mode, options } });
						}

						// Apply only after the whole sparse set has passed validation.
						resumedState!.updatedQuestionIds ??= [];
						for (const { index, question } of replacements) {
							resumedState!.questions[index] = question;
							resumedState!.tabs[index] = { questionIndex: index, mode: question.mode, answer: null, textBuffer: "", otherText: "", selected: [], note: "" };
							if (!resumedState!.updatedQuestionIds.includes(question.id!)) resumedState!.updatedQuestionIds.push(question.id!);
						}
						resumedState!.activeQuestionIndex = originIndex;
						resumedState!.clarificationOpen = false;
						resumedState!.clarificationTurns.push({ role: "assistant", content: request.response.trim() });
					}
				const sourceQuestions = resumedState?.questions ?? questionsParams!;
				const questions: QuestionDef[] = sourceQuestions.map((q: any, index: number) => {
					if (resumedState) return { ...q, options: q.options.map((option: any) => ({ ...option })) };
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
					const mode: AskUserQuestionMode = !optionsProvided ? "text" : q.multiSelect ? "multi-select" : "single-select";
					return { id: randomUUID(), question: q.question, label: q.label?.trim() || undefined, details: q.details?.trim() || undefined, mode, options: opts };
				});

				const terminal = (result: any, state: "completed" | "cancelled" | "regenerated" | "unavailable") => {
					if (hasResume) result.details = { ...result.details, continuationId, revision, continuationState: state };
					return result;
				};
				if (signal?.aborted) return terminal(batchCancelledResult(questions), "cancelled");
				if (!ctx.hasUI || ctx.mode !== "tui") return terminal(batchUnavailableResult(questions), "unavailable");

					return await withHerdrBlocked(pi, "Waiting for your answers", async () => {
						const result: BatchUIResult = await customWithAbort<any>(
						ctx,
						signal,
						(tui: any, theme: any, kb: any, done: (r: any) => void) =>
							new TabbedQuestions(questions, tui, theme, kb, done, resumedState ? { ...resumedState, questions } : undefined),
					);
						if (!result) return terminal(batchCancelledResult(questions), "cancelled");
						if (!Array.isArray(result)) {
							if (result.action === "clarification") return buildBatchClarificationResult(continuationId, revision + 1, result.continuation, result.clarification);
							return terminal(buildRegenerateResult(questions, result.answers), "regenerated");
						}
						return terminal(buildBatchResult(questions, result), "completed");
					});
				} catch (error) {
					if (claimKey) claims?.delete(claimKey);
					throw error;
				}
		});
	}

	pi.registerTool({
		name: "ask_questions",
		label: "ask_questions",
		description:
			"Start multiple related questions in a tabbed interface. A single Submit action finalizes completed answers; the user may explicitly skip the rest. Resume-shaped arguments are accepted only as a compatibility alias for conversations loaded before resume_questions was exposed; new resume calls must use resume_questions.",
		promptSnippet:
			"Use this tool only to start multiple related questions in a tabbed batch interface. Use resume_questions, not this compatibility alias, to resume a paused batch. Present distinct viable options and mark at most one as recommended per question.",
		promptGuidelines: [
			"Use ask_questions for 2+ related questions where the answers are needed together. For a single question, use ask_user_question instead.",
			"Provide distinct viable options for choice and decision questions; omit options for open-ended prompts that ask the user to describe, explain, or share an experience. Use multiSelect only with options.",
			"Mark at most one option as recommended per question. When recommending, mark exactly one singular best option based on context; otherwise mark none.",
			"Add a short label for semantic progress when useful; notes are optional.",
			"The user reviews completed answers before an explicit Submit and may intentionally skip unanswered questions. Use recommended: true for a recommendation; custom answers remain distinct.",
			"If the result status is regenerate, use the answered entries and notes as new understanding, do not repeat resolved questions, and immediately call ask_questions again with regenerated unanswered questions only.",
			"If ask_questions returns clarification_requested, answer it normally, then make one resume_questions call with continuationId, revision, response, and complete sparse replacements for every relevant eligible later question. Use revisions: [] when none need changes. Never send internal IDs.",
		],
		parameters: AskQuestionsParams,

		execute(toolCallId, params, signal, _onUpdate, ctx) {
			const resumeKeys = ["continuationId", "revision", "response", "revisions"] as const;
			const hasQuestions = params.questions !== undefined;
			const presentResumeKeys = resumeKeys.filter((key) => params[key] !== undefined);
			if (hasQuestions && presentResumeKeys.length > 0) {
				throw new Error("Invalid ask_questions arguments. Retry with exactly one complete mode: questions for a new batch, or continuationId, revision, response, and revisions for a compatibility resume; do not mix them.");
			}
			if (hasQuestions) return executeBatch(toolCallId, params.questions, undefined, signal, ctx);
			if (presentResumeKeys.length === resumeKeys.length) return executeBatch(toolCallId, undefined, params, signal, ctx);
			const detail = presentResumeKeys.length > 0 ? "the resume fields are incomplete" : "neither questions nor complete resume fields were provided";
			throw new Error(`Invalid ask_questions arguments: ${detail}. Retry with exactly one complete mode: questions for a new batch, or continuationId, revision, response, and revisions for a compatibility resume.`);
		},

		renderCall(args, theme) {
			const count = ((((args as any).questions) as Array<{ question: string }>) || []).length;
			const noun = count === 1 ? "question" : "questions";
			const label = (args as any).continuationId ? "Resume questions" : `${count} ${noun} for you`;
			return new Text(
				theme.fg("accent", theme.bold("? ")) +
					theme.fg("text", theme.bold(label)),
				0,
				0,
			);
		},

		renderResult: renderBatchResult,
	});

	pi.registerTool({
		name: "resume_questions",
		label: "resume_questions",
		description: "Atomically resume a paused ask_questions batch after answering its clarification, optionally replacing eligible clean later questions by public one-based question number. Requires revisions, using [] when unchanged.",
		parameters: ResumeQuestionsParams,
		execute(toolCallId, params, signal, _onUpdate, ctx) { return executeBatch(toolCallId, undefined, params, signal, ctx); },
		renderCall(_args, theme) { return new Text(theme.fg("accent", theme.bold("? ")) + theme.fg("text", theme.bold("Resume questions")), 0, 0); },
		renderResult: renderBatchResult,
	});

}
