import type { ReactElement } from "react";
import { useRef, useState } from "react";
import type { SessionEntry } from "../../../src/shared/bridge";
import type { UiState } from "../store";
import { useUi } from "../store";
import { post } from "../vscode";
import {
  ICON_CHEVRON,
  ICON_CLOSE,
  ICON_FOLDER_ADD,
  ICON_NEW,
  ICON_TRASH,
  Icon,
} from "./Icon";
import { Popover } from "./Popover";
import "./chrome.css";

const selectProjects = (state: UiState) => state.projects;
const selectSessions = (state: UiState) => state.sessions;
const selectActiveSessionId = (state: UiState) => state.activeSessionId;
const selectSessionStatuses = (state: UiState) => state.sessionStatuses;

/** The agent names sessions as they go; until then the mint ordinal identifies one. */
function sessionLabel(entry: SessionEntry): string {
  return entry.name?.trim() || `Session #${entry.ordinal}`;
}

/** Removing a project takes its live sessions with it — say so up front. */
function removeTitle(label: string, owned: number): string {
  if (owned === 0) return `Remove ${label}`;
  const sessions = owned === 1 ? "session" : `${owned} sessions`;
  return `Remove ${label} and close its ${sessions}`;
}

/**
 * Project + session switcher for the top of every chat surface.
 *
 * Each row is a live session — its own agent process — so a project can hold
 * several at once and several projects can run side by side. Picking one posts
 * `selectSession`: the host focuses it and reveals its editor panel, so two
 * conversations can be watched at the same time. Rows carry the badges fed by
 * `sessionStatus` (streaming spinner / awaiting-approval dot), which is the
 * point of the switcher: seeing what a *background* session is doing. Each
 * project heading also removes the project (`removeProjectFolder`), which the
 * host refuses if it would leave the window with no session at all.
 */
export function SessionSwitcher(): ReactElement {
  const projects = useUi(selectProjects);
  const sessions = useUi(selectSessions);
  const activeSessionId = useUi(selectActiveSessionId);
  const statuses = useUi(selectSessionStatuses);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);

  const active = sessions.find((entry) => entry.id === activeSessionId);
  const project = projects.find((entry) => entry.id === active?.projectId);
  const activeStatus = active ? statuses[active.id] : undefined;
  // The window always keeps one session; hide close where it would be refused.
  const canClose = sessions.length > 1;

  return (
    <>
      <div className="project-bar">
        <button
          type="button"
          className="project-tab"
          title={project?.cwd}
          aria-haspopup="dialog"
          aria-expanded={open}
          ref={ref}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate project-tab-label">
            {project?.label ?? active?.projectLabel ?? "Project"}
          </span>
          {active ? (
            <span className="truncate project-tab-session">
              {sessionLabel(active)}
            </span>
          ) : null}
          {project?.branch ? (
            <span className="faint mono project-tab-branch">
              {project.branch}
            </span>
          ) : null}
          {activeStatus?.isStreaming ? (
            <span className="spinner" aria-label="streaming" />
          ) : null}
          {activeStatus?.hasPendingDialog ? (
            <span className="project-dot" aria-label="awaiting approval" />
          ) : null}
          <Icon path={ICON_CHEVRON} />
        </button>
      </div>

      <Popover
        anchor={open ? ref.current : null}
        onClose={() => setOpen(false)}
        align="left"
      >
        {projects.map((entry) => {
          const owned = sessions.filter(
            (session) => session.projectId === entry.id,
          );
          // The host refuses a removal that would leave the window sessionless.
          const canRemove = sessions.some(
            (session) => session.projectId !== entry.id,
          );
          return (
            <div key={entry.id}>
              <div className="popover-group project-group">
                <span className="truncate">{entry.label}</span>
                {entry.branch ? (
                  <span className="mono truncate">{entry.branch}</span>
                ) : null}
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  title={`Start another session in ${entry.label}`}
                  onClick={() => {
                    setOpen(false);
                    post({ type: "newSession", projectId: entry.id });
                  }}
                >
                  <Icon path={ICON_NEW} />
                </button>
                {canRemove ? (
                  <button
                    type="button"
                    className="icon-btn"
                    title={removeTitle(entry.label, owned.length)}
                    onClick={() =>
                      post({ type: "removeProjectFolder", projectId: entry.id })
                    }
                  >
                    <Icon path={ICON_TRASH} />
                  </button>
                ) : null}
              </div>

              {owned.length === 0 ? (
                <div className="popover-empty">No sessions yet.</div>
              ) : (
                owned.map((session) => {
                  const status = statuses[session.id];
                  const isActive = session.id === activeSessionId;
                  return (
                    <div className="session-row" key={session.id}>
                      <button
                        type="button"
                        className="popover-item"
                        data-active={isActive}
                        onClick={() => {
                          setOpen(false);
                          if (!isActive)
                            post({ type: "selectSession", id: session.id });
                        }}
                      >
                        <span className="popover-item-title">
                          <span className="popover-item-text">
                            {sessionLabel(session)}
                          </span>
                          {isActive ? (
                            <span className="chip chip-accent">active</span>
                          ) : null}
                        </span>
                        <span className="popover-meta">
                          {status?.isStreaming ? (
                            <span className="row">
                              <span className="spinner" /> streaming
                            </span>
                          ) : null}
                          {status?.hasPendingDialog ? (
                            <span className="chip chip-warn">approval</span>
                          ) : null}
                        </span>
                      </button>
                      {canClose ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title={`Close ${sessionLabel(session)}`}
                          onClick={() =>
                            post({ type: "closeSession", id: session.id })
                          }
                        >
                          <Icon path={ICON_CLOSE} />
                        </button>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          );
        })}

        <div className="popover-sep" />
        <button
          type="button"
          className="popover-item"
          onClick={() => {
            setOpen(false);
            post({ type: "addProjectFolder" });
          }}
        >
          <span className="row">
            <Icon path={ICON_FOLDER_ADD} />
            Add folder…
          </span>
        </button>
      </Popover>
    </>
  );
}
