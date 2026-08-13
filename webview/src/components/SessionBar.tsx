import type { ReactElement } from "react";
import { useRef, useState } from "react";
import type { SessionListEntry } from "../../../src/shared/bridge";
import { formatRelativeTime } from "../format";
import type { UiState } from "../store";
import { useUi } from "../store";
import { post } from "../vscode";
import {
  ICON_BRANCH,
  ICON_BRANCH_NODES,
  ICON_NEW,
  ICON_OVERFLOW,
  ICON_RESUME,
  Icon,
} from "./Icon";
import { Popover } from "./Popover";
import "./chrome.css";

type Menu = "resume" | "branch" | "overflow";

const selectSession = (state: UiState) => state.session;
const selectSavedSessions = (state: UiState) => state.savedSessions;
const selectBranchPoints = (state: UiState) => state.branchPoints;

/** The omp mark: π in a rounded square, in brand magenta. */
function Mark(): ReactElement {
  return (
    <svg
      className="session-mark"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="0.85"
        y="0.85"
        width="14.3"
        height="14.3"
        rx="4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      >
        <path d="M3.7 5.3h8.6" />
        <path d="M6.3 5.6v5.3" />
        <path d="M10 5.6v3.7c0 1.05.5 1.6 1.5 1.6" />
      </g>
    </svg>
  );
}

function statusChipClass(status: SessionListEntry["status"]): string {
  switch (status) {
    case "error":
      return "chip chip-err";
    case "aborted":
    case "interrupted":
      return "chip chip-warn";
    case "pending":
      return "chip chip-accent";
    default:
      return "chip";
  }
}

export function SessionBar(): ReactElement {
  const session = useUi(selectSession);
  const savedSessions = useUi(selectSavedSessions);
  const branchPoints = useUi(selectBranchPoints);

  const [menu, setMenu] = useState<Menu | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);

  const resumeRef = useRef<HTMLButtonElement | null>(null);
  const branchRef = useRef<HTMLButtonElement | null>(null);
  const overflowRef = useRef<HTMLButtonElement | null>(null);

  const displayName = session.sessionName ?? session.workspaceName;

  function toggle(kind: Menu): void {
    if (menu === kind) {
      setMenu(null);
      return;
    }
    setMenu(kind);
    // The host answers with a `sessions` / `branchPoints` message; the list
    // below renders whatever has arrived so far.
    if (kind === "resume") post({ type: "requestSessions" });
    if (kind === "branch") post({ type: "requestBranchPoints" });
  }

  function commitRename(): void {
    const next = renameDraft?.trim() ?? "";
    setRenameDraft(null);
    if (next.length > 0 && next !== session.sessionName)
      post({ type: "setSessionName", name: next });
  }

  return (
    <>
      <header className="session-bar">
        <Mark />

        {renameDraft === null ? (
          <button
            type="button"
            className={`session-title truncate${displayName ? "" : " session-title-untitled"}`}
            title="Rename this session"
            onClick={() => setRenameDraft(session.sessionName ?? "")}
          >
            <span className="truncate">
              {displayName || "Untitled session"}
            </span>
          </button>
        ) : (
          <input
            className="session-name-input"
            value={renameDraft}
            placeholder="Session name"
            aria-label="Session name"
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setRenameDraft(null);
              }
            }}
          />
        )}

        {session.isStreaming ? (
          <span
            className="spinner session-streaming"
            role="status"
            aria-label="omp is working"
          />
        ) : null}

        <span className="spacer" />

        <button
          type="button"
          className="icon-btn"
          title="Start another session in this project"
          onClick={() => post({ type: "newSession" })}
        >
          <Icon path={ICON_NEW} />
        </button>

        <button
          type="button"
          className="icon-btn"
          title="Resume a session"
          aria-haspopup="dialog"
          aria-expanded={menu === "resume"}
          ref={resumeRef}
          onClick={() => toggle("resume")}
        >
          <Icon path={ICON_RESUME} />
        </button>

        <button
          type="button"
          className="icon-btn"
          title="Branch from an earlier message"
          aria-haspopup="dialog"
          aria-expanded={menu === "branch"}
          ref={branchRef}
          onClick={() => toggle("branch")}
        >
          <Icon path={ICON_BRANCH} nodes={ICON_BRANCH_NODES} />
        </button>

        <button
          type="button"
          className="icon-btn"
          title="More actions"
          aria-haspopup="dialog"
          aria-expanded={menu === "overflow"}
          ref={overflowRef}
          onClick={() => toggle("overflow")}
        >
          <Icon path={ICON_OVERFLOW} />
        </button>
      </header>

      {session.agentStatus === "ready" ? null : session.agentStatus ===
          "starting" || session.agentStatus === "restarting" ? (
        <div className="session-banner muted" role="status">
          <span className="spinner" aria-hidden="true" />
          Starting omp…
        </div>
      ) : (
        <div className="session-banner session-banner-error" role="alert">
          <span className="session-banner-detail" title={session.statusDetail}>
            {session.statusDetail ??
              (session.agentStatus === "exited"
                ? "omp exited."
                : "omp failed to start.")}
          </span>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => post({ type: "restartAgent" })}
          >
            Restart
          </button>
        </div>
      )}

      <Popover
        anchor={menu === "resume" ? resumeRef.current : null}
        onClose={() => setMenu(null)}
        align="right"
      >
        {savedSessions.length === 0 ? (
          <div className="popover-empty">Loading sessions…</div>
        ) : (
          savedSessions.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className="popover-item"
              data-active={entry.current}
              onClick={() => {
                setMenu(null);
                if (!entry.current)
                  post({ type: "switchSession", path: entry.path });
              }}
            >
              <span className="popover-item-title">
                <span className="popover-item-text">
                  {entry.name || entry.firstMessage || entry.id.slice(0, 8)}
                </span>
                {entry.current ? (
                  <span className="chip chip-accent">current</span>
                ) : null}
              </span>
              <span className="popover-meta">
                {entry.status === "unknown" ? null : (
                  <span className={statusChipClass(entry.status)}>
                    {entry.status}
                  </span>
                )}
                <span>{formatRelativeTime(entry.modified)}</span>
                {entry.messageCount > 0 ? (
                  <span>{entry.messageCount} msgs</span>
                ) : null}
              </span>
            </button>
          ))
        )}
      </Popover>

      <Popover
        anchor={menu === "branch" ? branchRef.current : null}
        onClose={() => setMenu(null)}
        align="right"
      >
        {branchPoints.length === 0 ? (
          <div className="popover-empty">
            No earlier messages to branch from.
          </div>
        ) : (
          branchPoints.map((point) => (
            <button
              type="button"
              key={point.entryId}
              className="popover-item"
              onClick={() => {
                setMenu(null);
                post({ type: "branch", entryId: point.entryId });
              }}
            >
              <span className="popover-item-text">
                {point.text || point.entryId}
              </span>
            </button>
          ))
        )}
      </Popover>

      <Popover
        anchor={menu === "overflow" ? overflowRef.current : null}
        onClose={() => setMenu(null)}
        align="right"
      >
        <button
          type="button"
          className="popover-item"
          onClick={() => {
            setMenu(null);
            post({ type: "resetSession" });
          }}
        >
          <span className="popover-item-title">Reset conversation</span>
          <span className="popover-meta">
            Clear this session's history, same agent
          </span>
        </button>
        <button
          type="button"
          className="popover-item"
          disabled={session.isCompacting}
          onClick={() => {
            setMenu(null);
            post({ type: "compact" });
          }}
        >
          <span className="popover-item-title">Compact conversation</span>
          <span className="popover-meta">
            {session.isCompacting
              ? "Compacting…"
              : "Summarise and free context"}
          </span>
        </button>
        <button
          type="button"
          className="popover-item"
          onClick={() => {
            setMenu(null);
            post({ type: "exportHtml" });
          }}
        >
          <span className="popover-item-title">Export HTML</span>
        </button>
        <button
          type="button"
          className="popover-item"
          onClick={() => {
            setMenu(null);
            post({ type: "loginProvider" });
          }}
        >
          <span className="popover-item-title">Sign in to provider…</span>
          <span className="popover-meta">
            Authenticate with a model provider
          </span>
        </button>
        <div className="popover-sep" />
        <button
          type="button"
          className="popover-item"
          onClick={() => {
            setMenu(null);
            post({ type: "restartAgent" });
          }}
        >
          <span className="popover-item-title">Restart agent</span>
        </button>
        <button
          type="button"
          className="popover-item"
          onClick={() => {
            setMenu(null);
            post({ type: "showLog" });
          }}
        >
          <span className="popover-item-title">Show log</span>
        </button>
      </Popover>
    </>
  );
}
