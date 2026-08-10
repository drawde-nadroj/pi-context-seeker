import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type KeybindingsManager, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AskAnswer, AskOption, AnswerWithNote, ClarificationRequest } from "./domain.ts";
import { answerSelectionKey, getOtherLabel, sortAnswers } from "./domain.ts";
import { addWrapped, constrainFrameHeight, createNoteEditor, createQuestionEditor, isAskAgentKey, isSubmitEnter, normalizeFocusCycleKey, renderOptionalNote, sanitizeDisplayText, sanitizeEditorDisplay, WrappedChoiceList, type WrappedChoiceItem } from "./tui-primitives.ts";

interface SemanticAction { text: string; color: "muted" | "accent" | "success" | "warning" }

function actionLine(theme: any, actions: SemanticAction[]): string {
	return ` ${actions.map((action) => theme.fg(action.color, action.text)).join(theme.fg("muted", " • "))}`;
}

export function customWithAbort<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, factory: (tui: any, theme: any, keybindings: KeybindingsManager, done: (value: T) => void) => any): Promise<T> {
	let removeAbort = () => {};
	return ctx.ui.custom<T>((tui: any, theme: any, keybindings: KeybindingsManager, done) => {
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			removeAbort();
			done(value);
		};
		const abort = () => finish(null as T);
		removeAbort = () => signal?.removeEventListener("abort", abort);
		signal?.addEventListener("abort", abort, { once: true });
		const component = factory(tui, theme, keybindings, finish);
		if (signal?.aborted) abort();
		return component;
	}).finally(removeAbort);
}

function createClarificationEditor(tui: any, theme: any, done: (result: ClarificationRequest) => void, setUnderlyingFocus: (focused: boolean) => void) {
	const editor = createQuestionEditor(tui, theme);
	let active = false;
	let feedback = "";
	return {
		get active() { return active; },
		setFocused(focused: boolean) { editor.focused = focused && active; },
		open() { active = true; feedback = ""; setUnderlyingFocus(false); editor.focused = true; tui.requestRender(); },
		render(width: number) {
			const lines: string[] = [];
			addWrapped(lines, theme.fg("text", " What do you want to ask the agent?"), width);
			for (const line of editor.render(Math.max(1, width - 2))) lines.push(truncateToWidth(` ${sanitizeEditorDisplay(line)}`, width));
			if (feedback) lines.push(truncateToWidth(theme.fg("warning", ` ${feedback}`), width));
			lines.push(truncateToWidth(theme.fg("dim", " Enter ask • Esc back"), width));
			return lines;
		},
		handle(data: string) {
			if (matchesKey(data, Key.escape)) { active = false; editor.focused = false; feedback = ""; setUnderlyingFocus(true); tui.requestRender(); return; }
			if (isSubmitEnter(data)) {
				const value = editor.getExpandedText().trim();
				if (!value) { feedback = "Question required."; tui.requestRender(); return; }
				done({ action: "clarification", clarification: value }); return;
			}
			editor.handleInput(data); feedback = ""; tui.requestRender();
		},
	};
}

export function askText(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	signal?: AbortSignal,
): Promise<AnswerWithNote<string> | ClarificationRequest | null> {
	return customWithAbort<AnswerWithNote<string> | ClarificationRequest | null>(ctx, signal, (tui: any, theme: any, _keybindings: KeybindingsManager, done) => {
		let cachedWidth: number | undefined;
		let cachedRows: number | undefined;
		let cachedLines: string[] | undefined;
		let noteFocused = false;
		let feedback = "";
		let _focused = false;
		const answerEditor = createQuestionEditor(tui, theme);
		const noteEditor = createNoteEditor(tui, theme);
		const clarification = createClarificationEditor(tui, theme, done, (focused) => {
			answerEditor.focused = focused && _focused && !noteFocused;
			noteEditor.focused = focused && _focused && noteFocused;
		});

		function invalidate(): void {
			cachedLines = undefined;
		}

		function finish(): void {
			if (!answerEditor.getExpandedText().trim()) {
				feedback = "Answer required.";
				invalidate();
				tui.requestRender();
				return;
			}
			done({ answer: answerEditor.getExpandedText(), note: noteEditor.getText() });
		}

		function focusNote(): void {
			noteFocused = true;
			answerEditor.focused = false;
			noteEditor.focused = _focused;
			invalidate();
			tui.requestRender();
		}

		function focusPrimary(): void {
			noteFocused = false;
			noteEditor.focused = false;
			answerEditor.focused = _focused;
			invalidate();
			tui.requestRender();
		}

		return {
			render(width: number): string[] {
				if (cachedLines && cachedWidth === width && cachedRows === tui.terminal?.rows) return cachedLines;
				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));
				add(theme.fg("accent", "─".repeat(width)));
				addWrapped(lines, theme.fg("accent", ` ${sanitizeDisplayText(question)}`), width);
				if (context) {
					lines.push("");
					addWrapped(lines, theme.fg("muted", ` ${sanitizeDisplayText(context)}`), width);
				}
				lines.push("");
				const editorPadding = width > 2 ? 1 : 0;
				const editorIndent = " ".repeat(editorPadding);
				for (const line of answerEditor.render(Math.max(1, width - editorPadding * 2))) add(`${editorIndent}${theme.fg("accent", sanitizeEditorDisplay(line))}`);
				if (feedback) add(theme.fg("warning", ` ${feedback}`));
				lines.push("");
				renderOptionalNote(lines, width, theme, noteEditor, noteFocused, 2);
				lines.push("");
				if (clarification.active) {
					lines.push(...clarification.render(width));
				} else {
					add(actionLine(theme, [{ text: "Ctrl+? Ask agent", color: "muted" }]));
					add(actionLine(theme, [
						{ text: "Enter submit", color: answerEditor.getExpandedText().trim() ? "success" : "accent" },
						...(["Shift+Enter newline", "Ctrl+C clear", "Tab note", "Esc cancel"].map((text) => ({ text, color: "muted" as const }))),
					]));
				}
				add(theme.fg("accent", "─".repeat(width)));
				constrainFrameHeight(lines, tui.terminal?.rows, 3);
				cachedWidth = width;
				cachedRows = tui.terminal?.rows;
				cachedLines = lines;
				return lines;
			},
			invalidate,
			handleInput(data: string): void {
				if (clarification.active) { clarification.handle(data); invalidate(); return; }
				if (isAskAgentKey(data)) { feedback = ""; clarification.open(); invalidate(); return; }
				data = normalizeFocusCycleKey(data);
				if (noteFocused) {
					if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) return finish();
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) return focusPrimary();
					noteEditor.handleInput(data);
				} else {
					if (matchesKey(data, Key.tab)) return focusNote();
					if (matchesKey(data, Key.ctrl("c"))) answerEditor.setText("");
					else if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter")) || isSubmitEnter(data)) return finish();
					else if (matchesKey(data, Key.escape)) return done(null);
					else answerEditor.handleInput(data);
				}
				invalidate();
				tui.requestRender();
			},
			get focused(): boolean { return _focused; },
			set focused(value: boolean) {
				_focused = value;
				invalidate();
				clarification.setFocused(value);
				if (clarification.active) { answerEditor.focused = false; noteEditor.focused = false; return; }
				answerEditor.focused = value && !noteFocused;
				noteEditor.focused = value && noteFocused;
			},
		};
	});
}

/** Single-choice question with inline Other and an optional inline note. */
export function askSingleChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
	signal?: AbortSignal,
): Promise<AnswerWithNote<AskAnswer> | ClarificationRequest | null> {
	const otherLabel = getOtherLabel(options);
	return customWithAbort<AnswerWithNote<AskAnswer> | ClarificationRequest | null>(ctx, signal, (tui: any, theme: any, keybindings: KeybindingsManager, done) => {
		let editMode = false;
		let noteFocused = false;
		let cachedWidth: number | undefined;
		let cachedRows: number | undefined;
		let cachedLines: string[] | undefined;
		let otherEditorValue = "";
		let feedback = "";
		let stagedAnswer: AskAnswer | null = null;
		let _focused = false;
		const editor = createQuestionEditor(tui, theme);
		const noteEditor = createNoteEditor(tui, theme);
		const clarification = createClarificationEditor(tui, theme, done, (focused) => {
			editor.focused = focused && _focused && editMode;
			noteEditor.focused = focused && _focused && noteFocused;
		});
		const choiceList = new WrappedChoiceList(
			options,
			otherLabel,
			Math.min(options.length + 1, 10, Math.max(1, Math.floor((tui.terminal?.rows ?? 24) / 4))),
			keybindings,
			theme,
		);

		function invalidate(): void { cachedLines = undefined; }
		function finish(answer: AskAnswer): void { done({ answer, note: noteEditor.getText() }); }
		function focusNote(): void {
			if (editMode) {
				otherEditorValue = editor.getText();
				const customAnswer = otherEditorValue.trim();
				if (customAnswer) stagedAnswer = { type: "other", label: customAnswer, value: customAnswer };
			}
			editMode = false;
			editor.focused = false;
			noteFocused = true;
			noteEditor.focused = _focused;
			invalidate();
			tui.requestRender();
		}
		function focusPrimary(): void {
			noteFocused = false;
			noteEditor.focused = false;
			invalidate();
			tui.requestRender();
		}
		function openOtherEditor(): void {
			stagedAnswer = null;
			choiceList.selectOther();
			noteFocused = false;
			noteEditor.focused = false;
			editMode = true;
			editor.setText(otherEditorValue);
			editor.focused = _focused;
			invalidate();
			tui.requestRender();
		}
		function answerForItem(item: WrappedChoiceItem): AskAnswer {
			const option = item.option!;
			return { type: "option", label: option.label, value: option.value, index: item.index };
		}
		function stageOrConfirm(item: WrappedChoiceItem): void {
			if (item.isOther) {
				if (stagedAnswer?.type === "other") return finish(stagedAnswer);
				return openOtherEditor();
			}
			const answer = answerForItem(item);
			if (stagedAnswer && answerSelectionKey(stagedAnswer) === item.id) return finish(stagedAnswer);
			stagedAnswer = answer;
			invalidate();
			tui.requestRender();
		}
		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				feedback = "Custom answer required.";
				invalidate();
				tui.requestRender();
				return;
			}
			otherEditorValue = value;
			stagedAnswer = { type: "other", label: trimmed, value: trimmed };
			editMode = false;
			editor.focused = false;
			invalidate();
			tui.requestRender();
		};

		return {
			render(width: number): string[] {
				if (cachedLines && cachedWidth === width && cachedRows === tui.terminal?.rows) return cachedLines;
				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));
				add(theme.fg("accent", "─".repeat(width)));
				addWrapped(lines, theme.fg("accent", ` ${sanitizeDisplayText(question)}`), width);
				if (context) { lines.push(""); addWrapped(lines, theme.fg("muted", ` ${sanitizeDisplayText(context)}`), width); }
				lines.push("");
				const tail: string[] = feedback ? [theme.fg("warning", ` ${feedback}`), ""] : [""];
				renderOptionalNote(tail, width, theme, noteEditor, noteFocused, 5);
				tail.push("");
				const hint = noteFocused
					? actionLine(theme, [
						{ text: "Note", color: "accent" }, { text: "Tab answer", color: "accent" }, { text: "Esc back", color: "muted" },
					])
					: editMode
						? actionLine(theme, [
							{ text: "Typing", color: "accent" }, { text: "Enter save", color: "accent" },
							{ text: "Ctrl+C clear", color: "muted" }, { text: "Tab note", color: "muted" }, { text: "Esc back", color: "muted" },
						])
						: actionLine(theme, stagedAnswer
							? [{ text: "↑↓ navigate", color: "muted" }, { text: "Enter confirm/replace", color: "success" }, { text: "Esc clear", color: "muted" }]
							: [{ text: "↑↓ navigate", color: "muted" }, { text: "Enter select", color: "accent" }, { text: "Tab note", color: "muted" }, { text: "Esc cancel", color: "muted" }]);
				if (clarification.active) {
					tail.push(...clarification.render(width));
				} else {
					tail.push(truncateToWidth(actionLine(theme, [{ text: "Ctrl+? Ask agent", color: "muted" }]), width));
					tail.push(truncateToWidth(hint, width));
				}
				tail.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
				const availableLines = Math.max(0, (tui.terminal?.rows ?? Number.POSITIVE_INFINITY) - lines.length - tail.length);
				lines.push(...choiceList.render(width, {
					selectedAnswers: stagedAnswer && answerSelectionKey(stagedAnswer)
						? new Map([[answerSelectionKey(stagedAnswer)!, stagedAnswer]])
						: new Map(),
					showRadio: true,
					inlineOtherEditor: editMode ? editor : undefined,
					availableLines,
				}));
				lines.push(...tail);
				constrainFrameHeight(lines, tui.terminal?.rows, 3);
				cachedWidth = width;
				cachedRows = tui.terminal?.rows;
				cachedLines = lines;
				return lines;
			},
			invalidate,
			handleInput(data: string): void {
				if (clarification.active) { clarification.handle(data); invalidate(); return; }
				if (isAskAgentKey(data)) { feedback = ""; clarification.open(); invalidate(); return; }
				data = normalizeFocusCycleKey(data);
				if (noteFocused) {
					if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) {
						const item = choiceList.selectedItem;
						if (stagedAnswer) return finish(stagedAnswer);
						if (item.isOther) return openOtherEditor();
						return finish(answerForItem(item));
					}
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) return focusPrimary();
					noteEditor.handleInput(data);
				} else if (editMode) {
					if (matchesKey(data, Key.ctrl("c"))) {
						editor.setText("");
						otherEditorValue = "";
						stagedAnswer = null;
					} else if (matchesKey(data, Key.tab)) return focusNote();
					else if (matchesKey(data, Key.escape)) {
						editMode = false;
						otherEditorValue = editor.getText();
						editor.focused = false;
					} else editor.handleInput(data);
				} else {
					if (matchesKey(data, Key.tab)) return focusNote();
					if (/^[1-9]$/.test(data)) {
						const index = parseInt(data, 10) - 1;
						if (index < choiceList.length) { choiceList.setSelectedIndex(index); return stageOrConfirm(choiceList.selectedItem); }
					}
					const action = choiceList.handleInput(data);
					if (action === "confirm") return stageOrConfirm(choiceList.selectedItem);
					if (action === "cancel") {
						if (stagedAnswer) {
							stagedAnswer = null;
							invalidate();
							tui.requestRender();
							return;
						}
						return done(null);
					}
				}
				invalidate();
				tui.requestRender();
			},
			get focused(): boolean { return _focused; },
			set focused(value: boolean) {
				_focused = value;
				invalidate();
				clarification.setFocused(value);
				if (clarification.active) { editor.focused = false; noteEditor.focused = false; return; }
				editor.focused = value && editMode;
				noteEditor.focused = value && noteFocused;
			},
		};
	});
}

/** Multi-choice question with inline Other and an optional inline note. */
export function askMultiChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
	signal?: AbortSignal,
): Promise<AnswerWithNote<AskAnswer[]> | ClarificationRequest | null> {
	const otherLabel = getOtherLabel(options);
	return customWithAbort<AnswerWithNote<AskAnswer[]> | ClarificationRequest | null>(ctx, signal, (tui: any, theme: any, keybindings: KeybindingsManager, done) => {
		let editMode = false;
		let noteFocused = false;
		let cachedWidth: number | undefined;
		let cachedRows: number | undefined;
		let cachedLines: string[] | undefined;
		let _focused = false;
		let otherPending = false;
		let feedback = "";
		const selected = new Map<string, AskAnswer>();
		const otherEditor = createQuestionEditor(tui, theme);
		const noteEditor = createNoteEditor(tui, theme);
		const clarification = createClarificationEditor(tui, theme, done, (focused) => {
			otherEditor.focused = focused && _focused && editMode;
			noteEditor.focused = focused && _focused && noteFocused;
		});
		const choiceList = new WrappedChoiceList(
			options,
			otherLabel,
			Math.min(options.length + 1, 12, Math.max(1, Math.floor((tui.terminal?.rows ?? 24) / 4))),
			keybindings,
			theme,
		);
		let otherText = "";

		function invalidate(): void { cachedLines = undefined; }
		function finish(): void {
			if (selected.size === 0) {
				feedback = "Select an answer.";
				invalidate();
				tui.requestRender();
				return;
			}
			done({ answer: sortAnswers(Array.from(selected.values())), note: noteEditor.getText() });
		}
		function focusNote(): void {
			if (editMode) {
				otherText = otherEditor.getText();
				const customAnswer = otherText.trim();
				if (customAnswer) {
					selected.set("other", { type: "other", label: customAnswer, value: customAnswer });
					otherPending = false;
				} else {
					selected.delete("other");
				}
			}
			editMode = false;
			otherEditor.focused = false;
			noteFocused = true;
			noteEditor.focused = _focused;
			invalidate();
			tui.requestRender();
		}
		function focusPrimary(): void {
			noteFocused = false;
			noteEditor.focused = false;
			invalidate();
			tui.requestRender();
		}
		function toggleOption(item: WrappedChoiceItem): void {
			const option = item.option;
			if (!option) return;
			if (selected.has(item.id)) selected.delete(item.id);
			else selected.set(item.id, { type: "option", label: option.label, value: option.value, index: item.index });
		}
		function openOtherEditor(): void {
			choiceList.selectOther();
			otherPending = true;
			editMode = true;
			otherEditor.setText(otherText);
			otherEditor.focused = _focused;
			invalidate();
			tui.requestRender();
		}
		function toggleOther(): void {
			if (selected.has("other")) {
				selected.delete("other");
				otherPending = false;
				return;
			}
			const cached = otherText.trim();
			if (cached) {
				selected.set("other", { type: "other", label: cached, value: cached });
				otherPending = false;
				return;
			}
			openOtherEditor();
		}
		otherEditor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) {
				feedback = "Custom answer required.";
				invalidate();
				tui.requestRender();
				return;
			}
			otherText = trimmed;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			otherPending = false;
			editMode = false;
			otherEditor.focused = false;
			invalidate();
			tui.requestRender();
		};

		return {
			render(width: number): string[] {
				if (cachedLines && cachedWidth === width && cachedRows === tui.terminal?.rows) return cachedLines;
				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));
				add(theme.fg("accent", "─".repeat(width)));
				addWrapped(lines, theme.fg("accent", ` ${sanitizeDisplayText(question)}`), width);
				if (context) { lines.push(""); addWrapped(lines, theme.fg("muted", ` ${sanitizeDisplayText(context)}`), width); }
				lines.push("");
				add(selected.size > 0 ? theme.fg("success", ` ✓ ${selected.size} selected`) : theme.fg("dim", " ○ Select options below"));
				lines.push("");
				const tail: string[] = feedback ? [theme.fg("warning", ` ${feedback}`), ""] : [""];
				renderOptionalNote(tail, width, theme, noteEditor, noteFocused, 9);
				tail.push("");
				const selectedItem = choiceList.selectedItem;
				const otherSpaceAction = selected.has("other") ? "Space remove" : otherText.trim() ? "Space select" : "Space edit";
				const primaryHint: SemanticAction[] = selectedItem.isOther
					? [{ text: otherSpaceAction, color: selected.has("other") ? "muted" : "accent" }, { text: "Enter edit", color: "accent" }, { text: "Tab note", color: "muted" }, { text: "Esc cancel", color: "muted" }]
					: [{ text: "Space toggle", color: selected.size > 0 ? "muted" : "accent" }, { text: `Enter ${selected.size > 0 ? "done" : "select"}`, color: selected.size > 0 ? "success" : "accent" }, { text: "Tab note", color: "muted" }, { text: "Esc cancel", color: "muted" }];
				const hint = noteFocused
					? actionLine(theme, [{ text: "Note", color: "accent" }, { text: "Tab options", color: "accent" }, { text: "Esc back", color: "muted" }])
					: editMode
						? actionLine(theme, [{ text: "Typing", color: "accent" }, { text: "Enter save", color: "accent" }, { text: "Ctrl+C clear", color: "muted" }, { text: "Tab note", color: "muted" }, { text: "Esc back", color: "muted" }])
						: actionLine(theme, primaryHint);
				if (clarification.active) {
					tail.push(...clarification.render(width));
				} else {
					tail.push(truncateToWidth(actionLine(theme, [{ text: "Ctrl+? Ask agent", color: "muted" }]), width));
					tail.push(truncateToWidth(hint, width));
				}
				tail.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
				const availableLines = Math.max(0, (tui.terminal?.rows ?? Number.POSITIVE_INFINITY) - lines.length - tail.length);
				lines.push(...choiceList.render(width, {
					selectedAnswers: selected,
					inlineOtherEditor: editMode ? otherEditor : undefined,
					availableLines,
				}));
				lines.push(...tail);
				constrainFrameHeight(lines, tui.terminal?.rows, 3);
				cachedWidth = width;
				cachedRows = tui.terminal?.rows;
				cachedLines = lines;
				return lines;
			},
			invalidate,
			handleInput(data: string): void {
				if (clarification.active) { clarification.handle(data); invalidate(); return; }
				if (isAskAgentKey(data)) { feedback = ""; clarification.open(); invalidate(); return; }
				data = normalizeFocusCycleKey(data);
				if (noteFocused) {
					if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) {
						if (otherPending && !selected.has("other")) {
							noteFocused = false;
							noteEditor.focused = false;
							editMode = true;
							otherEditor.focused = _focused;
							invalidate();
							tui.requestRender();
							return;
						}
						return finish();
					}
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) return focusPrimary();
					noteEditor.handleInput(data);
				} else if (editMode) {
					if (matchesKey(data, Key.ctrl("c"))) {
						otherEditor.setText("");
						otherText = "";
						selected.delete("other");
						otherPending = true;
					} else if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) {
						const trimmed = otherEditor.getText().trim();
						if (!trimmed) return;
						otherText = trimmed;
						selected.set("other", { type: "other", label: trimmed, value: trimmed });
						otherPending = false;
						return finish();
					}
					if (matchesKey(data, Key.tab)) return focusNote();
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						otherPending = false;
						otherText = otherEditor.getText();
						if (!otherText.trim()) selected.delete("other");
						otherEditor.focused = false;
					} else otherEditor.handleInput(data);
				} else {
					if (matchesKey(data, Key.tab)) return focusNote();
					if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) {
						return finish();
					}
					if (/^[1-9]$/.test(data)) {
						const index = parseInt(data, 10) - 1;
						if (index < choiceList.length) {
							choiceList.setSelectedIndex(index);
							if (choiceList.selectedItem.isOther) toggleOther(); else toggleOption(choiceList.selectedItem);
							invalidate(); tui.requestRender(); return;
						}
					}
					if (matchesKey(data, Key.space)) {
						if (choiceList.selectedItem.isOther) toggleOther(); else toggleOption(choiceList.selectedItem);
					} else {
						const action = choiceList.handleInput(data);
						if (action === "confirm") {
							if (choiceList.selectedItem.isOther) return openOtherEditor();
							if (selected.size > 0) return finish();
							toggleOption(choiceList.selectedItem);
						} else if (action === "cancel") return done(null);
					}
				}
				invalidate();
				tui.requestRender();
			},
			get focused(): boolean { return _focused; },
			set focused(value: boolean) {
				_focused = value;
				invalidate();
				clarification.setFocused(value);
				if (clarification.active) { otherEditor.focused = false; noteEditor.focused = false; return; }
				otherEditor.focused = value && editMode;
				noteEditor.focused = value && noteFocused;
			},
		};
	});
}


