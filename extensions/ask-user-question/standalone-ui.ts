import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type KeybindingsManager, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AskAnswer, AskOption, AnswerWithNote, ClarificationRequest, StandaloneContinuation } from "./domain.ts";
import { answerSelectionKey, getOtherLabel, sortAnswers } from "./domain.ts";
import { addWrapped, constrainFrameHeight, createNoteEditor, createQuestionEditor, isAskAgentKey, isSubmitEnter, normalizeFocusCycleKey, renderOptionalNote, sanitizeDisplayText, sanitizeEditorDisplay, WrappedChoiceList, type WrappedChoiceItem } from "./tui-primitives.ts";

interface SemanticAction { text: string; color: "muted" | "accent" | "success" | "warning" }

function actionLine(theme: any, actions: SemanticAction[]): string {
	return ` ${actions.map((action) => theme.fg(action.color, action.text)).join(theme.fg("muted", " • "))}`;
}

function widthAwareLabel(width: number, variants: string[]): string {
	return variants.find((variant) => visibleWidth(variant) <= width) ?? variants.at(-1)!;
}

function clarificationControls(width: number): string {
	return widthAwareLabel(width, [
		" Tab Preview • Enter Send • Esc Back",
		" Tab View • Enter Send • Esc Back",
		" Tab • Enter • Esc",
		" ⇥ • ↵ • Esc",
	]);
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

function createClarificationEditor(tui: any, theme: any, done: (result: ClarificationRequest) => void, setUnderlyingFocus: (focused: boolean) => void, snapshot: () => StandaloneContinuation) {
	const editor = createQuestionEditor(tui, theme);
	let active = false;
	let preview = false;
	let feedback = "";
	return {
		get active() { return active; },
		setFocused(focused: boolean) { editor.focused = focused && active && !preview; },
		open() { active = true; preview = false; feedback = ""; setUnderlyingFocus(false); editor.focused = true; tui.requestRender(); },
		render(width: number) {
			const lines: string[] = [];
			if (preview) {
				const label = widthAwareLabel(width, [
					" Read-only preview · Tab Back · Esc Close",
					" Preview · Tab Back · Esc Close",
					" Preview · Tab · Esc",
				]);
				lines.push(truncateToWidth(theme.fg("accent", label), width));
				return lines;
			}
			addWrapped(lines, theme.fg("text", " Ask agent"), width);
			for (const line of editor.render(Math.max(1, width - 2))) lines.push(truncateToWidth(` ${sanitizeEditorDisplay(line)}`, width));
			if (feedback) lines.push(truncateToWidth(theme.fg("warning", ` ${feedback}`), width));
			lines.push(truncateToWidth(theme.fg("dim", clarificationControls(width)), width));
			return lines;
		},
		handle(data: string) {
			if (matchesKey(data, Key.escape)) { active = false; preview = false; editor.focused = false; feedback = ""; setUnderlyingFocus(true); tui.requestRender(); return; }
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) { preview = !preview; editor.focused = !preview; tui.requestRender(); return; }
			if (preview) return;
			if (isSubmitEnter(data)) {
				const value = editor.getExpandedText().trim();
				if (!value) { feedback = "Question required."; tui.requestRender(); return; }
				done({ action: "clarification", clarification: value, continuation: snapshot() }); return;
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
	initialState?: StandaloneContinuation,
): Promise<AnswerWithNote<string> | ClarificationRequest | null> {
	return customWithAbort<AnswerWithNote<string> | ClarificationRequest | null>(ctx, signal, (tui: any, theme: any, _keybindings: KeybindingsManager, done) => {
		let cachedWidth: number | undefined;
		let cachedRows: number | undefined;
		let cachedLines: string[] | undefined;
		let noteFocused = initialState?.noteFocused ?? false;
		let feedback = "";
		let _focused = false;
		const answerEditor = createQuestionEditor(tui, theme);
		const noteEditor = createNoteEditor(tui, theme);
		answerEditor.setText(initialState?.answerText ?? "");
		noteEditor.setText(initialState?.note ?? "");
		const clarification = createClarificationEditor(tui, theme, done, (focused) => {
			answerEditor.focused = focused && _focused && !noteFocused;
			noteEditor.focused = focused && _focused && noteFocused;
		}, () => ({ answerText: answerEditor.getExpandedText(), noteFocused, note: noteEditor.getText() }));

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
				if (feedback && !clarification.active) add(theme.fg("warning", ` ${feedback}`));
				if (!clarification.active || noteEditor.getText().trim()) {
					lines.push("");
					renderOptionalNote(lines, width, theme, noteEditor, clarification.active ? false : noteFocused, 2);
					lines.push("");
				}
				if (clarification.active) {
					lines.push(...clarification.render(width));
				} else {
					add(actionLine(theme, [{ text: "Ctrl+/ Ask agent", color: "muted" }]));
					add(actionLine(theme, noteFocused
						? [
							{ text: "Note", color: "accent" }, { text: "Ctrl+C clear", color: "muted" },
							{ text: "Tab answer", color: "accent" }, { text: "Esc back", color: "muted" },
						]
						: [
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
					if (matchesKey(data, Key.ctrl("c"))) noteEditor.setText("");
					else noteEditor.handleInput(data);
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
	initialState?: StandaloneContinuation,
): Promise<AnswerWithNote<AskAnswer> | ClarificationRequest | null> {
	const otherLabel = getOtherLabel(options);
	return customWithAbort<AnswerWithNote<AskAnswer> | ClarificationRequest | null>(ctx, signal, (tui: any, theme: any, keybindings: KeybindingsManager, done) => {
		let editMode = initialState?.editingOther ?? false;
		let noteFocused = initialState?.noteFocused ?? false;
		let cachedWidth: number | undefined;
		let cachedRows: number | undefined;
		let cachedLines: string[] | undefined;
		let otherEditorValue = initialState?.otherText ?? "";
		let feedback = "";
		let stagedAnswer: AskAnswer | null = initialState?.stagedAnswer ?? null;
		let _focused = false;
		const editor = createQuestionEditor(tui, theme);
		const noteEditor = createNoteEditor(tui, theme);
		editor.setText(otherEditorValue);
		noteEditor.setText(initialState?.note ?? "");
		const clarification = createClarificationEditor(tui, theme, done, (focused) => {
			editor.focused = focused && _focused && editMode;
			noteEditor.focused = focused && _focused && noteFocused;
		}, () => ({ otherText: editMode ? editor.getText() : otherEditorValue, stagedAnswer, editingOther: editMode, noteFocused, note: noteEditor.getText() }));
		const choiceList = new WrappedChoiceList(
			options,
			otherLabel,
			Math.min(options.length + 1, 10, Math.max(1, Math.floor((tui.terminal?.rows ?? 24) / 4))),
			keybindings,
			theme,
		);
		if (stagedAnswer?.type === "option") choiceList.setSelectedIndex(stagedAnswer.index - 1);
		else if (stagedAnswer?.type === "other") choiceList.selectOther();

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
		function toggleFocusedAnswer(): void {
			const item = choiceList.selectedItem;
			feedback = "";
			if (item.isOther) {
				if (stagedAnswer?.type === "other") stagedAnswer = null;
				else {
					const customAnswer = otherEditorValue.trim();
					if (!customAnswer) return openOtherEditor();
					stagedAnswer = { type: "other", label: customAnswer, value: customAnswer };
				}
			} else if (stagedAnswer && answerSelectionKey(stagedAnswer) === item.id) stagedAnswer = null;
			else stagedAnswer = answerForItem(item);
			invalidate();
			tui.requestRender();
		}
		function confirmSelected(): void {
			if (stagedAnswer) return finish(stagedAnswer);
			feedback = "Select an answer with Space before confirming.";
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
				const tail: string[] = clarification.active ? [] : feedback ? [theme.fg("warning", ` ${feedback}`), ""] : [""];
				if (!clarification.active || noteEditor.getText().trim()) {
					renderOptionalNote(tail, width, theme, noteEditor, clarification.active ? false : noteFocused, 5);
					tail.push("");
				}
				const focusedItem = choiceList.selectedItem;
				const focusedOther = focusedItem.isOther;
				const focusedSelected = !!stagedAnswer && answerSelectionKey(stagedAnswer) === focusedItem.id;
				const spaceAction = focusedSelected ? "Space remove" : focusedOther && !otherEditorValue.trim() ? "Space edit" : "Space select";
				const selectionActions: SemanticAction[] = [{ text: "↑↓ focus", color: "muted" }];
				if (focusedOther) selectionActions.push({ text: "E edit", color: "accent" });
				if (stagedAnswer) selectionActions.push(
					{ text: spaceAction, color: "accent" },
					{ text: "Enter confirm", color: "success" },
					{ text: "Esc clear", color: "muted" },
				);
				else selectionActions.push(
					{ text: spaceAction, color: "accent" },
					{ text: "Enter needs selection", color: "muted" },
					{ text: "Tab note", color: "muted" },
					{ text: "Esc cancel", color: "muted" },
				);
				let selectionHint = actionLine(theme, selectionActions);
				const hintContentWidth = Math.max(0, width - 1);
				const disabledEnter = hintContentWidth >= visibleWidth("Enter waits") ? "Enter waits" : hintContentWidth >= visibleWidth("⏎ waits") ? "⏎ waits" : "⏎×";
				if (focusedOther && visibleWidth(selectionHint) > width) {
					const editAction: SemanticAction = { text: "E edit", color: "accent" };
					const enterAction: SemanticAction = stagedAnswer
						? { text: "Enter confirm", color: "success" }
						: { text: "Enter waits", color: "muted" };
					selectionHint = actionLine(theme, [editAction, { text: spaceAction, color: "accent" }, enterAction]);
					if (visibleWidth(selectionHint) > width) {
						selectionHint = actionLine(theme, stagedAnswer
							? [editAction, { text: spaceAction, color: "accent" }]
							: [{ text: spaceAction, color: "accent" }, enterAction]);
					}
					if (visibleWidth(selectionHint) > width) {
						selectionHint = actionLine(theme, stagedAnswer
							? [{ text: spaceAction, color: "accent" }]
							: [{ text: disabledEnter, color: "muted" }]);
					}
				}
				if (!stagedAnswer && visibleWidth(selectionHint) > width) {
					selectionHint = actionLine(theme, [{ text: disabledEnter, color: "muted" }]);
				}
				const hint = noteFocused
					? actionLine(theme, [
						{ text: "Note", color: "accent" }, { text: "Ctrl+C clear", color: "muted" },
						{ text: "Tab answer", color: "accent" }, { text: "Esc back", color: "muted" },
					])
					: editMode
						? actionLine(theme, [
							{ text: "Typing", color: "accent" }, { text: "Enter save", color: "accent" },
							{ text: "Ctrl+C clear", color: "muted" }, { text: "Tab note", color: "muted" }, { text: "Esc back", color: "muted" },
						])
						: selectionHint;
				if (clarification.active) {
					tail.push(...clarification.render(width));
				} else {
					tail.push(truncateToWidth(actionLine(theme, [{ text: "Ctrl+/ Ask agent", color: "muted" }]), width));
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
					if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) return confirmSelected();
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) return focusPrimary();
					if (matchesKey(data, Key.ctrl("c"))) noteEditor.setText("");
					else noteEditor.handleInput(data);
				} else if (editMode) {
					if (matchesKey(data, Key.ctrl("c"))) {
						editor.setText("");
						otherEditorValue = "";
						if (stagedAnswer?.type === "other") stagedAnswer = null;
					} else if (matchesKey(data, Key.tab)) return focusNote();
					else if (matchesKey(data, Key.escape)) {
						editMode = false;
						otherEditorValue = editor.getText();
						editor.focused = false;
					} else editor.handleInput(data);
				} else {
					if (matchesKey(data, Key.tab)) return focusNote();
					if ((data === "e" || data === "E") && choiceList.selectedItem.isOther) return openOtherEditor();
					if (/^[1-9]$/.test(data)) {
						const index = parseInt(data, 10) - 1;
						if (index < choiceList.length) { choiceList.setSelectedIndex(index); return toggleFocusedAnswer(); }
					}
					if (matchesKey(data, Key.space)) return toggleFocusedAnswer();
					const action = choiceList.handleInput(data);
					if (action === "confirm") return confirmSelected();
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
	initialState?: StandaloneContinuation,
): Promise<AnswerWithNote<AskAnswer[]> | ClarificationRequest | null> {
	const otherLabel = getOtherLabel(options);
	return customWithAbort<AnswerWithNote<AskAnswer[]> | ClarificationRequest | null>(ctx, signal, (tui: any, theme: any, keybindings: KeybindingsManager, done) => {
		let editMode = initialState?.editingOther ?? false;
		let noteFocused = initialState?.noteFocused ?? false;
		let cachedWidth: number | undefined;
		let cachedRows: number | undefined;
		let cachedLines: string[] | undefined;
		let _focused = false;
		let otherPending = initialState?.editingOther ?? false;
		let feedback = "";
		const selected = new Map<string, AskAnswer>();
		const otherEditor = createQuestionEditor(tui, theme);
		const noteEditor = createNoteEditor(tui, theme);
		noteEditor.setText(initialState?.note ?? "");
		const clarification = createClarificationEditor(tui, theme, done, (focused) => {
			otherEditor.focused = focused && _focused && editMode;
			noteEditor.focused = focused && _focused && noteFocused;
		}, () => ({ otherText: editMode ? otherEditor.getText() : otherText, selected: Array.from(selected.values()), editingOther: editMode, noteFocused, note: noteEditor.getText() }));
		const choiceList = new WrappedChoiceList(
			options,
			otherLabel,
			Math.min(options.length + 1, 12, Math.max(1, Math.floor((tui.terminal?.rows ?? 24) / 4))),
			keybindings,
			theme,
		);
		let otherText = initialState?.otherText ?? "";
		otherEditor.setText(otherText);
		if (editMode) choiceList.selectOther();
		for (const answer of initialState?.selected ?? []) {
			const key = answerSelectionKey(answer);
			if (key) selected.set(key, answer);
		}

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
				const tail: string[] = clarification.active ? [] : feedback ? [theme.fg("warning", ` ${feedback}`), ""] : [""];
				if (!clarification.active || noteEditor.getText().trim()) {
					renderOptionalNote(tail, width, theme, noteEditor, clarification.active ? false : noteFocused, 9);
					tail.push("");
				}
				const selectedItem = choiceList.selectedItem;
				const otherSpaceAction = selected.has("other") ? "Space remove" : otherText.trim() ? "Space select" : "Space edit";
				const primaryHint: SemanticAction[] = selectedItem.isOther
					? [{ text: otherSpaceAction, color: selected.has("other") ? "muted" : "accent" }, { text: "Enter edit", color: "accent" }, { text: "Tab note", color: "muted" }, { text: "Esc cancel", color: "muted" }]
					: [{ text: "Space toggle", color: selected.size > 0 ? "muted" : "accent" }, { text: `Enter ${selected.size > 0 ? "done" : "select"}`, color: selected.size > 0 ? "success" : "accent" }, { text: "Tab note", color: "muted" }, { text: "Esc cancel", color: "muted" }];
				const hint = noteFocused
					? actionLine(theme, [
						{ text: "Note", color: "accent" }, { text: "Ctrl+C clear", color: "muted" },
						{ text: "Tab options", color: "accent" }, { text: "Esc back", color: "muted" },
					])
					: editMode
						? actionLine(theme, [{ text: "Typing", color: "accent" }, { text: "Enter save", color: "accent" }, { text: "Ctrl+C clear", color: "muted" }, { text: "Tab note", color: "muted" }, { text: "Esc back", color: "muted" }])
						: actionLine(theme, primaryHint);
				if (clarification.active) {
					tail.push(...clarification.render(width));
				} else {
					tail.push(truncateToWidth(actionLine(theme, [{ text: "Ctrl+/ Ask agent", color: "muted" }]), width));
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
					if (matchesKey(data, Key.ctrl("c"))) noteEditor.setText("");
					else noteEditor.handleInput(data);
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


