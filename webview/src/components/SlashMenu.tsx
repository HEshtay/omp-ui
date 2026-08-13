import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import type { SlashCommand } from "../../../src/shared/protocol";
import { useUi } from "../store";
import type { UiState } from "../store";
import "./composer.css";

/**
 * Slash-command completion for the composer.
 *
 * The menu is deliberately passive: the textarea owns focus and every key, and
 * `Composer` drives selection through props. That keeps arrow/enter handling in
 * one place instead of racing a second focusable widget.
 */

export interface SlashItem {
	/** Token inserted on completion, without the leading slash. */
	name: string;
	description?: string;
	/** `input.hint` for commands, `usage` for subcommands. */
	hint?: string;
	source: string;
	/** Set when the match was found through an alias rather than the name. */
	matchedAlias?: string;
	score: number;
}

export interface SlashContext {
	stage: "command" | "subcommand";
	/** Text being matched, without the leading slash. */
	term: string;
	/** Replacement range in the draft text. */
	start: number;
	end: number;
	/** Parent command, for the subcommand stage. */
	command?: SlashCommand;
}

export interface SlashState {
	context: SlashContext;
	/** Flattened in render order, so an index maps 1:1 onto a visible row. */
	items: SlashItem[];
	groups: Array<{ source: string; items: SlashItem[] }>;
}

const selectCommands = (state: UiState) => state.commands;

/** Rank of a candidate string against the typed term, or `null` for no match. */
function scoreOf(candidate: string, term: string): number | null {
	if (term === "") return 0;
	const haystack = candidate.toLowerCase();
	const needle = term.toLowerCase();
	if (haystack === needle) return 1000;
	// Prefix hits all score alike so the stable sort falls back to the order omp
	// advertised, which is roughly importance — `/mo` should offer `/model`
	// before `/move`, and a shorter-name tiebreak would invert that.
	if (haystack.startsWith(needle)) return 800;
	const contained = haystack.indexOf(needle);
	if (contained > 0) return 500 - contained;
	let matched = 0;
	for (const character of haystack) {
		if (matched < needle.length && character === needle.charAt(matched)) matched += 1;
	}
	return matched === needle.length ? 200 - haystack.length : null;
}

/**
 * Locates the completion context for `caret` in `text`, or `null` when the
 * caret is not inside a command token.
 */
export function slashContext(text: string, caret: number, commands: SlashCommand[]): SlashContext | null {
	if (!text.startsWith("/")) return null;

	const firstBreakIndex = text.search(/\s/);
	const firstBreak = firstBreakIndex === -1 ? text.length : firstBreakIndex;
	if (caret <= firstBreak) {
		return { stage: "command", term: text.slice(1, firstBreak), start: 0, end: firstBreak };
	}

	// Past the command token: only useful if that command has subcommands.
	const typed = text.slice(1, firstBreak).toLowerCase();
	const command = commands.find(
		candidate =>
			typeof candidate?.name === "string" &&
			(candidate.name.toLowerCase() === typed ||
				(candidate.aliases ?? []).some(alias => typeof alias === "string" && alias.toLowerCase() === typed)),
	);
	if (!command?.subcommands || command.subcommands.length === 0) return null;

	const gap = text.slice(firstBreak);
	const leading = gap.length - gap.trimStart().length;
	if (gap.slice(0, leading).includes("\n")) return null;
	const start = firstBreak + leading;
	if (caret < start) return null;

	const tail = text.slice(start);
	const tailBreak = tail.search(/\s/);
	const end = tailBreak === -1 ? text.length : start + tailBreak;
	if (caret > end) return null;

	return { stage: "subcommand", term: text.slice(start, end), start, end, command };
}

function commandItems(commands: SlashCommand[], term: string): SlashItem[] {
	const items: SlashItem[] = [];
	for (const command of commands) {
		if (typeof command?.name !== "string" || command.name === "") continue;
		let score = scoreOf(command.name, term);
		let matchedAlias: string | undefined;
		for (const alias of command.aliases ?? []) {
			if (typeof alias !== "string") continue;
			const aliasScore = scoreOf(alias, term);
			// Alias hits are slightly demoted so the canonical name wins ties.
			if (aliasScore !== null && (score === null || aliasScore - 1 > score)) {
				score = aliasScore - 1;
				matchedAlias = alias;
			}
		}
		if (score === null) continue;
		items.push({
			name: command.name,
			description: typeof command.description === "string" ? command.description : undefined,
			hint: typeof command.input?.hint === "string" ? command.input.hint : undefined,
			source: typeof command.source === "string" && command.source !== "" ? command.source : "commands",
			matchedAlias,
			score,
		});
	}
	return items;
}

function subcommandItems(command: SlashCommand, term: string): SlashItem[] {
	const items: SlashItem[] = [];
	for (const subcommand of command.subcommands ?? []) {
		if (typeof subcommand?.name !== "string" || subcommand.name === "") continue;
		const score = scoreOf(subcommand.name, term);
		if (score === null) continue;
		items.push({
			name: subcommand.name,
			description: typeof subcommand.description === "string" ? subcommand.description : undefined,
			hint: typeof subcommand.usage === "string" ? subcommand.usage : undefined,
			source: `/${command.name}`,
			score,
		});
	}
	return items;
}

/** Matches for `context`, ranked and grouped, or `null` when nothing matches. */
export function slashItems(commands: SlashCommand[], context: SlashContext): SlashState | null {
	const unsorted =
		context.stage === "command"
			? commandItems(commands, context.term)
			: context.command
				? subcommandItems(context.command, context.term)
				: [];
	if (unsorted.length === 0) return null;

	// Stable sort: equal scores keep the order omp itself advertised.
	const sorted = [...unsorted].sort((a, b) => b.score - a.score);

	// Group by source, keeping each group in the position of its best match.
	const groups: Array<{ source: string; items: SlashItem[] }> = [];
	const bySource = new Map<string, SlashItem[]>();
	for (const item of sorted) {
		let bucket = bySource.get(item.source);
		if (!bucket) {
			bucket = [];
			bySource.set(item.source, bucket);
			groups.push({ source: item.source, items: bucket });
		}
		bucket.push(item);
	}

	return { context, groups, items: groups.flatMap(group => group.items) };
}

/** Completion state for the current caret, or `null` when there is nothing to offer. */
export function useSlashItems(text: string, caret: number): SlashState | null {
	const commands = useUi(selectCommands);
	return useMemo(() => {
		const context = slashContext(text, caret, commands);
		return context ? slashItems(commands, context) : null;
	}, [commands, text, caret]);
}

/** Text to splice in for `item`, plus the caret offset it should leave behind. */
export function completion(text: string, context: SlashContext, item: SlashItem): { text: string; caret: number } {
	const token = context.stage === "command" ? `/${item.name}` : item.name;
	// Reuse a space that is already there rather than doubling it up.
	const spaced = /^[^\S\n]/.test(text.slice(context.end));
	const inserted = spaced ? token : `${token} `;
	return {
		text: text.slice(0, context.start) + inserted + text.slice(context.end),
		caret: context.start + inserted.length + (spaced ? 1 : 0),
	};
}

export function SlashMenu(props: {
	state: SlashState;
	activeIndex: number;
	onPick(item: SlashItem): void;
	onHover(index: number): void;
}): ReactElement {
	const { state, activeIndex, onPick, onHover } = props;
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	let index = -1;
	return (
		<div className="popover slash-menu" role="listbox" aria-label="Slash commands" ref={listRef}>
			{state.groups.map(group => (
				<div key={group.source}>
					<div className="popover-group">{group.source}</div>
					{group.items.map(item => {
						index += 1;
						const itemIndex = index;
						const active = itemIndex === activeIndex;
						return (
							<div
								key={`${group.source}/${item.name}`}
								id={`slash-item-${itemIndex}`}
								className="popover-item"
								role="option"
								aria-selected={active}
								data-active={active}
								onMouseMove={() => onHover(itemIndex)}
								onMouseDown={event => {
									// Keep focus in the textarea: never let the click steal it.
									event.preventDefault();
									onPick(item);
								}}
							>
								<div className="popover-item-title">
									<span className="slash-name mono">
										{state.context.stage === "command" ? "/" : ""}
										{item.name}
									</span>
									{item.hint ? <span className="slash-hint faint mono">{item.hint}</span> : null}
									{item.matchedAlias ? <span className="slash-alias faint">/{item.matchedAlias}</span> : null}
								</div>
								{item.description ? <div className="slash-desc muted">{item.description}</div> : null}
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}
