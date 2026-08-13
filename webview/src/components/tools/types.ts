import type { ReactNode } from "react";
import type { ToolCallState } from "../../../../src/shared/chat-model";

export interface ToolBodyProps {
	call: ToolCallState;
	/** Renderers cap their own output when collapsed; the frame never clips. */
	expanded: boolean;
}

/**
 * A per-tool card. `ToolCard` owns the frame (status icon, meta, expand
 * toggle, images, artifact link) and delegates the interior here.
 */
export interface ToolRenderer {
	/** Replaces the tool name in the header. */
	title?(call: ToolCallState): ReactNode;
	/** The one-line "what did this do" that shows even when collapsed. */
	summary?(call: ToolCallState): ReactNode;
	/** Extra right-aligned header content, before the duration. */
	meta?(call: ToolCallState): ReactNode;
	body(props: ToolBodyProps): ReactNode;
	/** Suppress the tool name entirely — the body carries its own header. */
	hideName?: boolean;
	/** Open on arrival even when the call succeeded. */
	defaultExpanded?: boolean;
}
