import {
	CURSOR_MARKER,
	Editor,
	type EditorOptions,
	type EditorTheme,
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AskAnswer, AskOption } from "./domain.ts";

export function sanitizeDisplayText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
		.replace(/\x1B_[\s\S]*?\x1B\\/g, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ");
}

export function sanitizeEditorDisplay(text: string): string {
	// SafeEditor removes untrusted markers before Editor creates this output, so
	// any marker here has provenance as the focused editor's IME cursor.
	const markerIndex = text.lastIndexOf(CURSOR_MARKER);
	if (markerIndex < 0) return sanitizeDisplayText(text);
	const before = text.slice(0, markerIndex);
	const after = text.slice(markerIndex + CURSOR_MARKER.length);
	return `${sanitizeDisplayText(before)}${CURSOR_MARKER}${sanitizeDisplayText(after)}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Retain the trusted hardware/IME marker and paint a terminal-visible caret cell. */
export function renderSoftwareCaret(text: string): string {
	const safe = sanitizeEditorDisplay(text);
	const markerIndex = safe.lastIndexOf(CURSOR_MARKER);
	if (markerIndex < 0) return safe;
	const before = safe.slice(0, markerIndex);
	const after = safe.slice(markerIndex + CURSOR_MARKER.length);
	const first = after ? graphemeSegmenter.segment(after)[Symbol.iterator]().next().value?.segment ?? "" : "";
	const cell = first || " ";
	return `${before}${CURSOR_MARKER}\x1b[7m${cell}\x1b[27m${after.slice(first.length)}`;
}

export function renderOptionalNote(
	lines: string[],
	width: number,
	theme: any,
	noteEditor: Editor,
	noteFocused: boolean,
	indent: number,
): void {
	const safeIndent = Math.max(2, Math.min(indent, Math.max(2, width - 1)));
	const labelPrefix = " ".repeat(Math.max(0, safeIndent - 2));
	const note = sanitizeDisplayText(noteEditor.getText());
	if (!noteFocused && !note) {
		lines.push(truncateToWidth(`${labelPrefix}${theme.fg("muted", "+ Add note (optional)")}${theme.fg("dim", " · Tab")}`, width));
		return;
	}

	let labelText = "Note: ";
	if (noteFocused) {
		// Keep enough editor columns for typed text plus its fake cursor and
		// zero-width hardware cursor marker. Prefer the descriptive label, then
		// compact it before falling back to a separate label row.
		const minimumEditorWidth = 6;
		const labelVariants = ["Note (optional): ", "Note: ", "N: "];
		const inlineLabel = labelVariants.find(
			(candidate) => visibleWidth(labelPrefix) + visibleWidth(candidate) + minimumEditorWidth <= width,
		);

		if (!inlineLabel) {
			lines.push(truncateToWidth(`${labelPrefix}${theme.fg("accent", theme.bold("N:"))}`, width));
			for (const editorLine of noteEditor.render(Math.max(1, width)).slice(1, -1)) {
				lines.push(truncateToWidth(sanitizeEditorDisplay(editorLine), width));
			}
			return;
		}

		labelText = inlineLabel;
	}

	const label = `${labelPrefix}${theme.fg(noteFocused ? "accent" : "muted", noteFocused ? theme.bold(labelText) : labelText)}`;
	const contentPrefix = " ".repeat(visibleWidth(label));

	if (noteFocused) {
		const editorWidth = width - visibleWidth(label);
		const editorLines = noteEditor.render(editorWidth).slice(1, -1);
		lines.push(truncateToWidth(`${label}${sanitizeEditorDisplay(editorLines[0] ?? "")}`, width));
		for (const editorLine of editorLines.slice(1)) {
			lines.push(truncateToWidth(`${contentPrefix}${sanitizeEditorDisplay(editorLine)}`, width));
		}
		return;
	}

	const logicalLines = note.split("\n");
	for (let index = 0; index < logicalLines.length; index++) {
		addWrappedWithPrefix(
			lines,
			index === 0 ? label : contentPrefix,
			theme.fg("dim", logicalLines[index] || " "),
			width,
			contentPrefix,
		);
	}
}

function scrubCursorMarkers(text: string): string {
	return text.replaceAll(CURSOR_MARKER, "");
}

/** Keep marker provenance at the shared editable-input boundary. */
export class SafeEditor extends Editor {
	override setText(text: string): void {
		super.setText(scrubCursorMarkers(text));
	}

	override insertTextAtCursor(text: string): void {
		super.insertTextAtCursor(scrubCursorMarkers(text));
	}

	override handleInput(data: string): void {
		super.handleInput(scrubCursorMarkers(data));
	}
}

/** Build the complete editor palette from the active question UI theme. */
export function questionEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

export function createQuestionEditor(tui: any, theme: any, options: EditorOptions = { paddingX: 0 }): SafeEditor {
	return new SafeEditor(tui, questionEditorTheme(theme), options);
}

export function createNoteEditor(tui: any, theme: any): Editor {
	const editor = createQuestionEditor(tui, theme);
	// Enter must never clear a note. Shift+Enter/Ctrl+J insert new lines;
	// Tab leaves the note and Ctrl/Alt+Enter submits the question form.
	editor.disableSubmit = true;
	return editor;
}

export function normalizeFocusCycleKey(data: string): string {
	return matchesKey(data, Key.shift("tab")) ? "\t" : data;
}

export function isSubmitEnter(data: string): boolean {
	return matchesKey(data, Key.enter) && !matchesKey(data, Key.ctrl("j"));
}

/** Ask agent accepts both Ctrl+/ and the equivalent Ctrl+? terminal encoding. */
export function isAskAgentKey(data: string): boolean {
	return matchesKey(data, Key.ctrl("?"))
		|| matchesKey(data, Key.ctrl("/"));
}

/** A multiline free-text question with an inline optional note. */
export function addWrappedWithPrefix(
	lines: string[],
	prefix: string,
	text: string,
	width: number,
	continuationPrefix = " ".repeat(visibleWidth(prefix)),
): void {
	const renderWidth = Math.max(1, width);
	const prefixWidth = visibleWidth(prefix);

	// Extremely narrow terminals cannot reserve the prefix separately. Wrapping
	// the combined content still honors the component's hard width contract.
	if (prefixWidth >= renderWidth) {
		for (const line of wrapTextWithAnsi(`${prefix}${text}`, renderWidth)) {
			lines.push(truncateToWidth(line, renderWidth));
		}
		return;
	}

	const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
	for (let i = 0; i < wrapped.length; i++) {
		const linePrefix = i === 0 ? prefix : continuationPrefix;
		lines.push(truncateToWidth(`${linePrefix}${wrapped[i]}`, renderWidth));
	}
}

/** Render a label and its optional paragraph with the same hanging geometry. */
export function addWrappedOption(
	lines: string[],
	prefix: string,
	label: string,
	description: string | undefined,
	width: number,
	descriptionPrefix = " ".repeat(visibleWidth(prefix)),
	continuationPrefix = " ".repeat(visibleWidth(prefix)),
): void {
	addWrappedWithPrefix(lines, prefix, label, width, continuationPrefix);
	if (description) {
		addWrappedWithPrefix(lines, descriptionPrefix, description, width, descriptionPrefix);
	}
}

export type ChoiceListAction = "changed" | "confirm" | "cancel" | "unhandled";

export interface WrappedChoiceItem {
	/** Stable cursor identity; option values are allowed to collide. */
	id: string;
	index: number;
	label: string;
	description?: string;
	option?: AskOption;
	isOther: boolean;
}

export interface ChoiceListRenderOptions {
	/** Presence of this map enables checkbox rendering, even when it is empty. */
	selectedAnswers?: ReadonlyMap<string, AskAnswer>;
	/** Render the native multiline editor directly beneath the Other choice. */
	inlineOtherEditor?: Editor;
	/** Single-select lists show an explicit radio independently of the cursor. */
	showRadio?: boolean;
	/** Host-computed line budget after all surrounding chrome is reserved. */
	availableLines?: number;
}

/**
 * Owns every coupled piece of option-list behavior: cursor movement, the
 * item-count window, and ANSI-aware multiline rendering. Keeping those rules
 * behind one interface prevents navigation and presentation from drifting.
 *
 * Answer persistence and the custom-answer Input deliberately remain with the
 * host question flow; they have different submit semantics in each mode.
 */
export class WrappedChoiceList {
	private readonly items: WrappedChoiceItem[];
	private readonly maxVisible: number;
	private readonly keybindings: KeybindingsManager;
	private readonly theme: any;
	private selectedIndex = 0;

	constructor(
		options: AskOption[],
		otherLabel: string,
		maxVisible: number,
		keybindings: KeybindingsManager,
		theme: any,
	) {
		this.keybindings = keybindings;
		this.theme = theme;
		this.items = options.map((option, index) => ({
			id: `option:${index}`,
			index: index + 1,
			label: sanitizeDisplayText(option.label),
			description: option.description ? sanitizeDisplayText(option.description) : undefined,
			option,
			isOther: false,
		}));
		this.items.push({
			id: "other",
			index: options.length + 1,
			label: otherLabel,
			description: "Write your own answer.",
			isOther: true,
		});

		this.maxVisible = Math.max(1, Math.min(maxVisible, this.items.length));
	}

	get length(): number {
		return this.items.length;
	}

	get selectedItem(): WrappedChoiceItem {
		return this.items[this.selectedIndex];
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
	}

	selectOther(): void {
		this.selectedIndex = this.items.findIndex((item) => item.isOther);
	}

	/** Apply only list-level bindings; hosts retain mode-specific key precedence. */
	handleInput(data: string): ChoiceListAction {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
			return "changed";
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
			return "changed";
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) return "confirm";
		if (this.keybindings.matches(data, "tui.select.cancel")) return "cancel";
		return "unhandled";
	}

	render(width: number, options: ChoiceListRenderOptions = {}): string[] {
		const lines: string[] = [];
		const {
			selectedAnswers,
			inlineOtherEditor,
			showRadio = false,
		} = options;
		const showCheckboxes = selectedAnswers !== undefined && !showRadio;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.items.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);

		for (let itemIndex = startIndex; itemIndex < endIndex; itemIndex++) {
			const item = this.items[itemIndex];
			const hasCursor = itemIndex === this.selectedIndex;
			const answerKey = item.id;
			const checked = selectedAnswers?.has(answerKey) ?? false;
			const customActive = item.isOther && inlineOtherEditor !== undefined;
			const visiblySelected = checked || (customActive && !showRadio);
			// Radios communicate single-select state; checkboxes remain reserved
			// for actual multi-select semantics.
			const controlColor = visiblySelected ? "success" : hasCursor ? "accent" : "text";
			const labelColor = item.option?.recommended ? "success" : controlColor;
			const cursorPrefix = hasCursor
				? this.theme.fg(visiblySelected ? "success" : "accent", "→ ")
				: "  ";
			const selectionPrefix = showCheckboxes
				? `${visiblySelected ? "[x]" : "[ ]"} `
				: showRadio ? `${visiblySelected ? "(●)" : "( )"} ` : "";
			const prefix = `${cursorPrefix}${this.theme.fg(controlColor, `${selectionPrefix}${item.index}. `)}`;
			let label = this.theme.fg(labelColor, item.label);
			if (item.option?.recommended) label += this.theme.fg("success", "  Recommended");

			if (item.isOther && inlineOtherEditor) {
				addWrappedWithPrefix(lines, prefix, label, width);
				// Replace the normal description line with the native Editor so a
				// one-line answer leaves the list's geometry unchanged. At extreme
				// widths, reduce this secondary row's indent rather than hiding input.
				const editorIndent = " ".repeat(Math.min(visibleWidth(prefix), Math.max(0, width - 4)));
				const editorWidth = Math.max(1, width - visibleWidth(editorIndent));
				const editorLines = inlineOtherEditor.render(editorWidth).slice(1, -1);
				for (const editorLine of editorLines) {
					lines.push(truncateToWidth(`${editorIndent}${this.theme.fg("accent", sanitizeEditorDisplay(editorLine))}`, width));
				}
				lines.push("");
				continue;
			}

			if (item.isOther) {
				const otherAnswer = selectedAnswers?.get("other");
				if (otherAnswer?.type === "other") {
					label += this.theme.fg("accent", ` — ${sanitizeDisplayText(otherAnswer.label)}`);
				}
			}

			if (item.isOther) {
				addWrappedWithPrefix(lines, prefix, label, width);
				const descriptionPrefix = " ".repeat(Math.min(visibleWidth(prefix), Math.max(0, width - 4)));
				const descriptionWidth = Math.max(0, width - visibleWidth(descriptionPrefix));
				lines.push(truncateToWidth(
					`${descriptionPrefix}${truncateToWidth(this.theme.fg("muted", item.description ?? ""), descriptionWidth)}`,
					width,
				));
				lines.push("");
				continue;
			}

			const wrappedPrefix = " ".repeat(visibleWidth(prefix));
			addWrappedOption(
				lines, prefix, label,
				item.description ? this.theme.fg("muted", item.description) : undefined,
				width, wrappedPrefix, wrappedPrefix,
			);
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			addWrappedWithPrefix(lines, "  ", this.theme.fg("dim", `(${this.selectedIndex + 1}/${this.items.length})`), width);
		}

		const maxRenderedLines = options.availableLines === undefined
			? Number.POSITIVE_INFINITY
			: Math.max(0, Math.floor(options.availableLines));
		if (lines.length > maxRenderedLines) {
			if (maxRenderedLines === 0) return [];
			const editorCursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			const selectedLine = lines.findIndex((line) => line.includes("→"));
			const cursorLine = Math.max(0, editorCursorLine >= 0 ? editorCursorLine : selectedLine);
			const start = Math.max(0, Math.min(cursorLine - Math.floor(maxRenderedLines / 2), lines.length - maxRenderedLines));
			const visible = lines.slice(start, start + maxRenderedLines);
			if (start > 0 && start !== cursorLine) {
				visible[0] = truncateToWidth(this.theme.fg("dim", "  ↑ more"), width);
			}
			if (start + maxRenderedLines < lines.length && start + maxRenderedLines - 1 !== cursorLine) {
				visible[visible.length - 1] = truncateToWidth(this.theme.fg("dim", "  ↓ more"), width);
			}
			return visible;
		}

		return lines;
	}
}

export class FrameViewport {
	private offset = 0;
	private pageSize = 1;
	private revealActive = false;
	private canScroll = false;
	private layoutKey = "";

	/** Consume outer-frame paging before a nested editor or Pi sees the key. */
	handleInput(data: string): boolean {
		const pageUp = matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("pageUp"));
		const pageDown = matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("pageDown"));
		if (!pageUp && !pageDown) {
			this.revealActive = true;
			return false;
		}
		if (!this.canScroll) return false;
		this.offset = Math.max(0, this.offset + (pageUp ? -this.pageSize : this.pageSize));
		this.revealActive = false;
		return true;
	}

	render(lines: string[], terminalRows: number | undefined, tailLines: number, width: number, theme: any, reserveBodyRow = true): string[] {
		if (terminalRows === undefined || lines.length <= terminalRows) {
			this.canScroll = false;
			this.offset = 0;
			this.pageSize = Math.max(1, lines.length - tailLines);
			this.revealActive = false;
			this.layoutKey = "";
			return lines;
		}
		const requestedTail = Math.min(Math.max(0, tailLines), lines.length);
		const hasBody = lines.length > requestedTail;
		const keepTail = Math.min(requestedTail, hasBody && reserveBodyRow ? Math.max(0, terminalRows - 1) : terminalRows);
		const body = lines.slice(0, lines.length - keepTail);
		const tail = lines.slice(lines.length - keepTail);
		const budget = Math.max(0, terminalRows - keepTail);
		const layoutKey = `${terminalRows}:${keepTail}:${body.length}`;
		// Tiny standalone frames must open on their active editor/choice rather
		// than spending every body row on heading details. Taller frames retain
		// the top-first reading order and can be paged explicitly.
		if (reserveBodyRow && terminalRows <= 8 && layoutKey !== this.layoutKey) this.revealActive = true;
		this.layoutKey = layoutKey;
		this.pageSize = Math.max(1, budget - 1);
		const maxOffset = Math.max(0, body.length - budget);
		this.canScroll = budget > 0 && maxOffset > 0;
		if (!this.canScroll) this.offset = 0;
		if (this.revealActive && budget > 0) {
			const editorCursor = body.findIndex((line) => line.includes(CURSOR_MARKER));
			const active = editorCursor >= 0 ? editorCursor : body.findIndex((line) => line.includes("→"));
			if (active >= 0) {
				if (active < this.offset) this.offset = active;
				else if (active >= this.offset + budget) this.offset = active - Math.floor(budget / 2);
			}
		}
		this.revealActive = false;
		this.offset = Math.min(this.offset, maxOffset);
		const visible = body.slice(this.offset, this.offset + budget);
		const isActive = (line: string) => line.includes(CURSOR_MARKER) || line.includes("→");
		const needsUp = this.offset > 0;
		const needsDown = this.offset < maxOffset;
		const usedRows = new Set<number>();
		const findIndicatorRow = (fromEnd: boolean): number | undefined => {
			const indexes = Array.from({ length: visible.length }, (_, index) => index);
			if (fromEnd) indexes.reverse();
			return indexes.find((index) => !usedRows.has(index) && !isActive(visible[index]!) && visibleWidth(visible[index]!) === 0)
				?? indexes.find((index) => !usedRows.has(index) && !isActive(visible[index]!));
		};
		const setIndicator = (text: string, fromEnd: boolean): boolean => {
			// At least one real content row—especially an active choice or editor
			// caret—must survive even in a one- or two-row body viewport.
			if (usedRows.size >= visible.length - 1) return false;
			const row = findIndicatorRow(fromEnd);
			if (row === undefined) return false;
			usedRows.add(row);
			visible[row] = truncateToWidth(theme.fg("dim", text), width);
			return true;
		};
		if (needsUp && needsDown && visible.length === 2) {
			setIndicator(" ↕ more · PgUp / PgDn", true);
		} else {
			if (needsUp) setIndicator(" ↑ more · PgUp / Ctrl+PgUp", false);
			if (needsDown) setIndicator(" ↓ more · PgDn / Ctrl+PgDn", true);
		}
		return [...visible, ...tail].slice(0, terminalRows);
	}
}

export function constrainFrameHeight(lines: string[], terminalRows: number | undefined, tailLines = 2): void {
	if (terminalRows === undefined || lines.length <= terminalRows) return;
	const keepTail = Math.min(Math.max(0, tailLines), terminalRows);
	const editorCursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
	const cursorLine = editorCursorLine >= 0 ? editorCursorLine : lines.findIndex((line) => line.includes("→"));
	const bodyEnd = lines.length - keepTail;

	if (cursorLine >= 0 && cursorLine < bodyEnd) {
		const bodyBudget = terminalRows - keepTail;
		const start = Math.max(0, Math.min(cursorLine - bodyBudget + 1, bodyEnd - bodyBudget));
		lines.splice(0, lines.length, ...lines.slice(start, start + bodyBudget), ...lines.slice(bodyEnd));
		return;
	}

	const removeAt = Math.max(0, terminalRows - keepTail);
	lines.splice(removeAt, lines.length - terminalRows);
}

export function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	addWrappedWithPrefix(lines, indent, text, width, indent);
}

/** Keep model-provided progress labels compact as well as terminal-safe. */
export function sanitizeProgressLabel(text: string): string {
	return sanitizeDisplayText(text).replace(/[\t\n]/g, " ");
}

/** Truncate semantic labels by grapheme without pi-tui's three-dot suffix. */
export function truncateLabel(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";

	let result = "";
	const Segmenter = (Intl as any).Segmenter;
	const graphemes: string[] = Segmenter
		? Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part: any) => part.segment)
		: Array.from(text);
	for (const grapheme of graphemes) {
		if (visibleWidth(result + grapheme) > width - 1) break;
		result += grapheme;
	}
	return `${result}…`;
}
