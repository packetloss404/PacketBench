import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiffCommentAnchor } from "@/components/views/DiffViewer";
import {
  AlertCircle,
  Bell,
  Tag,
  Brain,
  Check,
  Clock,
  Diamond,
  GitBranch,
  GitPullRequest,
  Github,
  Loader2,
  Plane,
  RefreshCw,
  Send,
  Wand2,
  X,
} from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import { capabilitiesFor, hostLabel } from "@/lib/git-hosts";
import { useNotificationsPoller } from "@/hooks/useNotificationsPoller";
import { HostIcon } from "@/components/HostIcon";
import { GitHostSetupWizard } from "@/components/gitHost/GitHostSetupWizard";
import type { GitHostKind, GitHubRelease } from "@/lib/tauri";
import type { ReviewComment } from "@/lib/reviewCommentThreads";
import { useIssueStore } from "@/stores/issueStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

import { gitCreateBranch } from "@/lib/tauri";
import { PRModal } from "@/components/views/PRModal";
import { DiffViewer } from "@/components/views/DiffViewer";
import { IssueBody } from "@/components/views/github/IssueBody";
import { IssueActionBar } from "@/components/views/github/IssueActionBar";
import { IssueCommentList } from "@/components/views/github/IssueCommentList";
import { IssueCommentComposer } from "@/components/views/github/IssueCommentComposer";
import { IssueList } from "@/components/views/github/IssueList";
import { PRReviewPanel } from "@/components/views/github/PRReviewPanel";
// v0.8-13: read-only pr reviews + line comments viewer
import { PullRequestReviewsPanel } from "@/components/views/github/PullRequestReviewsPanel";
import { PRActionBar } from "@/components/views/github/PRActionBar";
// v0.8-B: pr check pill + checks tab (re-shipped)
import { PRChecksTab } from "@/components/views/github/PRChecksTab";
import { RepoSelector } from "@/components/views/github/RepoSelector";
import { PRList } from "@/components/views/github/PRList";
import { ActivityFeed } from "@/components/views/github/ActivityFeed";
import { NotificationsInbox } from "@/components/views/github/NotificationsInbox";
import { AITriageDrawer } from "@/components/views/github/AITriageDrawer";
import { InvestigationPanel } from "@/components/views/github/InvestigationPanel";
import { timeAgo } from "@/components/views/github/shared";
import { CtaFeedbackRow, type CtaFeedback } from "@/components/views/github/CtaFeedbackRow";
import type { GitHubIssue } from "@/types/github";
import { relativeTime } from "@/lib/time";
import { isLocalWorkspace } from "@/types/workspace";

// v0.8-D — turn an issue title into a git-branch-safe slug. Lowercase,
// non-alphanumerics collapsed to `-`, trimmed to 40 chars after dropping
// leading/trailing dashes.
function slugifyIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

type TabKey = "issues" | "prs" | "activity" | "inbox" | "releases";

export function GitHubView() {
  const {
    config,
    isConnected,
    isInitializing,
    authenticatedUser,
    repos,
    issues,
    isLoading,
    error,
    investigation,
    isInvestigating,
    prs,
    prDiff,
    isPrLoading,
    lastSyncAt,
    initializeAuth,
    disconnect,
    fetchRepos,
    selectRepo,
    fetchIssues,
    investigateIssue,
    createPR,
    fetchPrs,
    getPrDiff,
    clearError,
    clearInvestigation,
    // v0.8-C: state filters + pagination
    issueStateFilter,
    prStateFilter,
    setIssueStateFilter,
    setPrStateFilter,
    issuesHasMore,
    prsHasMore,
    isLoadingMoreIssues,
    isLoadingMorePrs,
    loadMoreIssues,
    loadMorePrs,
    // v0.8-F: needed to apply labels emitted by AITriageDrawer
    setIssueLabels,
    // notifications inbox
    unreadCount,
    notifications,
    fetchNotifications,
    releases,
    isReleasesLoading,
    releasesError,
    fetchReleases,
  } = useGitHubStore();

  const addIssue = useIssueStore((s) => s.addIssue);
  const openSettings = useAppStore((s) => s.openSettings);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const activeProjectWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId),
  );
  const activeProjectWorkspaceId = activeProjectWorkspace?.id ?? null;
  const activeProjectServerId = activeProjectWorkspace?.serverId ?? null;
  const activeProjectIsLocal = activeProjectWorkspace
    ? isLocalWorkspace(activeProjectWorkspace)
    : true;
  const activeProjectLocalPath = activeProjectWorkspace?.projectPath ?? "";

  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [tab, setTab] = useState<TabKey>("issues");
  const [selectedIssueNum, setSelectedIssueNum] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showPRModal, setShowPRModal] = useState(false);
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);
  // v0.8-B: which tab is active in the PR detail panel.
  // Bumped after posting an inline review comment so PullRequestReviewsPanel
  // refetches and shows the new thread.
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0);
  // GP1: review comments for the selected PR, rendered inline in the diff.
  const [prReviewComments, setPrReviewComments] = useState<ReviewComment[]>([]);
  const [prDetailTab, setPrDetailTab] = useState<"overview" | "checks">("overview");
  // v0.8-F: triage drawer open state
  const [triageOpen, setTriageOpen] = useState(false);

  useEffect(() => {
    initializeAuth();
  }, [initializeAuth]);

  // GP2: keep the unread badge live while the pane is open (visibility-aware).
  useNotificationsPoller();

  // G3: resolve which host this workspace belongs to (from its origin remote)
  // so the pane targets the right host and shows the right branding.
  const resolveActiveConnectionForProject = useGitHubStore(
    (s) => s.resolveActiveConnectionForProject,
  );
  const clearRepositoryContext = useGitHubStore((s) => s.clearRepositoryContext);
  useEffect(() => {
    // The layout fallback remains local while an SSH Workspace is active.
    // Never resolve its origin as though it belonged to the remote project.
    const localAuthorityPath = activeProjectWorkspaceId
      ? !activeProjectIsLocal
        ? ""
        : activeProjectLocalPath
      : projectPath;
    if (localAuthorityPath) {
      void resolveActiveConnectionForProject(localAuthorityPath);
    } else if (!activeProjectIsLocal) {
      clearRepositoryContext();
    }
  }, [
    activeProjectWorkspaceId,
    activeProjectServerId,
    activeProjectIsLocal,
    activeProjectLocalPath,
    projectPath,
    resolveActiveConnectionForProject,
    clearRepositoryContext,
  ]);

  // G10: capability gating for the active host (Gitea hides GitHub-only surfaces).
  const connections = useGitHubStore((s) => s.connections);
  const activeConnectionId = useGitHubStore((s) => s.activeConnectionId);
  const activeHostKind = useMemo(
    () => connections.find((c) => c.id === activeConnectionId)?.kind ?? "github",
    [connections, activeConnectionId],
  );
  const activeCaps = useMemo(() => capabilitiesFor(activeHostKind), [activeHostKind]);
  const aiAssistAvailable = activeCaps.aiAssist && activeProjectIsLocal;
  const setActiveConnection = useGitHubStore((s) => s.setActiveConnection);
  const detailScope = `${activeConnectionId}:${config.selectedRepo?.owner ?? ""}/${config.selectedRepo?.repo ?? ""}`;
  useEffect(() => {
    // Detail state is view-local, while host/repo data lives in the store.
    // Reset both selections whenever that authority boundary changes so an
    // identically numbered issue or PR from the previous host cannot linger.
    setSelectedIssueNum(null);
    setSelectedPrNumber(null);
    setPrReviewComments([]);
    setPrDetailTab("overview");
    setReviewRefreshKey(0);
    setTriageOpen(false);
    clearInvestigation();
  }, [detailScope, clearInvestigation]);
  useEffect(() => {
    // If we land on a tab the active host doesn't support, fall back to Issues.
    if (tab === "activity" && !activeCaps.activityFeed) setTab("issues");
  }, [tab, activeCaps.activityFeed]);

  // GP1: fetch the selected PR's review comments so the diff can anchor them
  // inline. Refetches after a comment is posted (reviewRefreshKey) and on host
  // change. Gitea returns [] (inline authoring gated), so this is a no-op there.
  useEffect(() => {
    if (!isConnected || !config.selectedRepo || selectedPrNumber == null) {
      setPrReviewComments([]);
      return;
    }
    const { owner, repo } = config.selectedRepo;
    let cancelled = false;
    void invoke<ReviewComment[]>("github_list_pr_review_comments", {
      owner,
      repo,
      prNumber: selectedPrNumber,
    })
      .then((cs) => {
        if (!cancelled) setPrReviewComments(cs);
      })
      .catch(() => {
        if (!cancelled) setPrReviewComments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, config.selectedRepo, selectedPrNumber, reviewRefreshKey, activeConnectionId]);

  // Refetch repos on connect AND whenever the active host changes (a Gitea
  // workspace resolves to a different connection → different repo set).
  useEffect(() => {
    if (isConnected) {
      fetchRepos();
    }
  }, [isConnected, activeConnectionId, fetchRepos]);

  useEffect(() => {
    if (isConnected && config.selectedRepo) {
      fetchIssues();
      fetchPrs();
    }
    // activeConnectionId: the same owner/repo lives on a different host, so a
    // host switch must refetch (and correct any fetch that raced resolution).
  }, [isConnected, config.selectedRepo, activeConnectionId, fetchIssues, fetchPrs]);

  // Lazy-load notifications the first time the Inbox tab is opened. Unlike
  // issues/PRs these are global to the authenticated user, so they don't
  // depend on the selected repo (but they DO depend on the active host).
  useEffect(() => {
    if (isConnected && tab === "inbox" && notifications.length === 0) {
      fetchNotifications();
    }
  }, [isConnected, tab, notifications.length, activeConnectionId, fetchNotifications]);

  // GP6: lazy-load releases when the Releases tab opens (or host/repo changes).
  useEffect(() => {
    if (isConnected && tab === "releases" && config.selectedRepo) {
      void fetchReleases();
    }
  }, [isConnected, tab, config.selectedRepo, activeConnectionId, fetchReleases]);

  useEffect(() => {
    if (selectedIssueNum == null && issues.length > 0) {
      setSelectedIssueNum(issues[0].number);
    } else if (selectedIssueNum != null && !issues.find((i) => i.number === selectedIssueNum)) {
      setSelectedIssueNum(issues[0]?.number ?? null);
    }
  }, [issues, selectedIssueNum]);

  const selectedIssue = useMemo(
    () => issues.find((i) => i.number === selectedIssueNum) ?? null,
    [issues, selectedIssueNum],
  );

  const filteredIssues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter((i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q));
  }, [issues, searchQuery]);

  // v0.8-F: issues currently in the list with no labels — these are the
  // default selection for the triage drawer. We pull from the unfiltered
  // `issues` so the drawer's view doesn't accidentally shrink when the
  // user has a text filter applied.
  const untriagedIssues = useMemo(() => issues.filter((i) => i.labels.length === 0), [issues]);

  // v0.8-F: wire AITriageDrawer.onApply into the existing store action.
  // Falls back to the raw tauri command when the store doesn't expose
  // `setIssueLabels` (back-compat for installs that pre-date v0.8-C).
  async function handleTriageApply(labelsByIssue: Record<number, string[]>): Promise<void> {
    const entries = Object.entries(labelsByIssue);
    for (const [numStr, labels] of entries) {
      const num = Number(numStr);
      const issue = issues.find((i) => i.number === num);
      if (!issue) continue;
      if (typeof setIssueLabels === "function") {
        // v0.8-C store path: takes {name, color}[]. We don't know the
        // color, so use a neutral placeholder; the next `fetchIssues`
        // overwrites with GitHub's authoritative color.
        await setIssueLabels(
          { number: num },
          labels.map((name) => ({ name, color: "888888" })),
        );
      } else {
        // Fallback: raw tauri command.
        const { githubSetIssueLabels } = await import("@/lib/tauri");
        const repoInfo = config.selectedRepo;
        if (!repoInfo) continue;
        await githubSetIssueLabels(repoInfo.owner, repoInfo.repo, num, labels);
      }
    }
  }

  function handleImportIssue(issue: GitHubIssue) {
    addIssue({
      title: `[GH-${issue.number}] ${issue.title}`,
      description: issue.body || "",
      status: "todo",
      priority: "medium",
      labels: issue.labels.map((l) => l.name),
      epic: null,
      acceptanceCriteria: [],
      blockedBy: [],
      blocks: [],
    });
  }

  function handleRefresh() {
    fetchRepos();
    if (config.selectedRepo) {
      fetchIssues();
      fetchPrs();
    }
  }

  if (!isConnected) {
    return (
      <div className="flex h-full flex-col overflow-y-auto bg-bg-primary p-4">
        <div className="mb-6 flex items-center gap-2">
          <Github size={14} className="text-text-primary" />
          <h2 className="text-xs font-semibold text-text-primary">Git Hosts</h2>
        </div>

        <div className="mx-auto mt-16 max-w-md">
          <div className="rounded-lg border border-bg-border bg-bg-secondary p-6 text-center">
            <Github size={32} className="mx-auto mb-4 text-text-muted" />
            <h3 className="mb-2 text-sm font-semibold text-text-primary">
              {activeHostKind === "gitea" ? "Configure Gitea / Forgejo" : "Connect to GitHub"}
            </h3>
            <p className="mb-4 text-[11px] text-text-muted">
              {activeHostKind === "gitea"
                ? "This host has no usable token. Update or recreate the connection in Settings."
                : "Sign in with GitHub, or add a token with repo scope, to browse repositories and issues."}
            </p>
            {isInitializing && (
              <p className="mb-3 text-[11px] text-text-muted">Checking auth state...</p>
            )}
            {/* The one connect path. This screen used to carry its own bare
                paste-a-PAT field beside this button — a third way in, and the
                one that checked nothing. The wizard offers browser sign-in and
                token paste, and validates whichever you use, so there is
                nothing left for a raw field to add. */}
            <button
              type="button"
              onClick={() => setShowSetupWizard(true)}
              className="mb-3 inline-flex w-full items-center justify-center gap-1.5 rounded border border-accent-green/30 bg-accent-green/15 px-4 py-1.5 text-xs font-medium text-accent-green transition-colors hover:bg-accent-green/25"
            >
              <Wand2 size={12} />
              Set up a git host
            </button>
            {activeHostKind === "gitea" && (
              <button
                type="button"
                onClick={() => openSettings({ section: "github" })}
                className="rounded border border-accent-green/30 bg-accent-green/15 px-4 py-1.5 text-xs font-medium text-accent-green transition-colors hover:bg-accent-green/25"
              >
                Open Settings
              </button>
            )}
            {error && <p className="mt-3 text-[11px] text-accent-red">{error}</p>}
          </div>
        </div>
        {showSetupWizard && <GitHostSetupWizard onClose={() => setShowSetupWizard(false)} />}
      </div>
    );
  }

  const username = authenticatedUser?.login ?? "user";

  const openCount = issues.length;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-primary">
      <HeaderBand
        username={username}
        repos={repos}
        selected={config.selectedRepo}
        onSelectRepo={selectRepo}
        onRefresh={handleRefresh}
        isLoading={isLoading || isPrLoading}
        onNewPR={() => setShowPRModal(true)}
        onDisconnect={disconnect}
        hostKind={activeHostKind}
      />

      {/* G13: host indicator + override (shown once a second host is configured) */}
      {connections.length > 1 && (
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-bg-border bg-bg-secondary px-3 py-1">
          <span className="text-[10px] text-text-muted">Host</span>
          {connections.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveConnection(c.id)}
              title={c.baseUrl}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
                c.id === activeConnectionId
                  ? "border border-line-strong bg-bg-elevated text-text-primary"
                  : "border border-transparent text-text-muted hover:text-text-secondary"
              }`}
            >
              <HostIcon kind={c.kind} size={11} />
              {c.label}
            </button>
          ))}
        </div>
      )}

      <SubTabs
        tab={tab}
        onTab={setTab}
        issueCount={openCount}
        prCount={prs.length}
        unreadCount={unreadCount}
        lastSyncAt={lastSyncAt}
        showActivity={activeCaps.activityFeed}
      />

      {error && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-accent-red/20 bg-accent-red/10 px-4 py-2">
          <AlertCircle size={12} className="text-accent-red" />
          <span className="flex-1 text-[11px] text-accent-red">{error}</span>
          <button onClick={clearError} className="text-accent-red/60 hover:text-accent-red">
            <X size={12} />
          </button>
        </div>
      )}

      {tab === "inbox" ? (
        // Notifications are global to the authenticated user, so the Inbox
        // renders regardless of the selected repository.
        <NotificationsInbox />
      ) : !config.selectedRepo ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-text-muted">
          Select a repository to begin.
        </div>
      ) : tab === "issues" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr] overflow-hidden">
          <IssueList
            issues={filteredIssues}
            totalIssues={openCount}
            isLoading={isLoading}
            selectedNum={selectedIssueNum}
            onSelect={(num) => {
              setSelectedIssueNum(num);
              clearInvestigation();
            }}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            stateFilter={issueStateFilter}
            onStateFilterChange={setIssueStateFilter}
            hasMore={issuesHasMore}
            isLoadingMore={isLoadingMoreIssues}
            onLoadMore={loadMoreIssues}
            totalLoaded={issues.length}
            onOpenTriage={() => setTriageOpen(true)}
            untriagedCount={untriagedIssues.length}
            aiAssistAvailable={aiAssistAvailable}
          />
          <IssueDetail
            issue={selectedIssue}
            investigation={investigation}
            isInvestigating={isInvestigating}
            onImport={handleImportIssue}
            onInvestigate={(num) => investigateIssue(projectPath, num)}
            onRefetch={() => fetchIssues()}
            aiAssistAvailable={aiAssistAvailable}
          />
        </div>
      ) : tab === "prs" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto] overflow-hidden">
          <PRList
            prs={prs}
            isLoading={isPrLoading}
            selectedNum={selectedPrNumber}
            onSelect={(num) => {
              setSelectedPrNumber(num);
              getPrDiff(num);
            }}
            stateFilter={prStateFilter}
            onStateFilterChange={setPrStateFilter}
            hasMore={prsHasMore}
            isLoadingMore={isLoadingMorePrs}
            onLoadMore={loadMorePrs}
            showChecks={activeCaps.checkRuns}
          />
          {selectedPrNumber != null && (
            <div className="w-[480px] overflow-y-auto border-l border-bg-border bg-bg-primary">
              <div className="flex items-center gap-2 border-b border-bg-border px-4 py-3">
                <GitPullRequest size={12} className="text-accent-purple" />
                <span className="text-xs font-semibold text-text-primary">
                  PR #{selectedPrNumber} diff
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => setSelectedPrNumber(null)}
                  className="text-text-muted hover:text-text-primary"
                >
                  <X size={12} />
                </button>
              </div>
              {/* v0.8-A: PR action bar */}
              {(() => {
                const pr = prs.find((p) => p.number === selectedPrNumber);
                if (!pr) return null;
                return (
                  <PRActionBar
                    key={`${detailScope}#${pr.number}`}
                    pr={pr}
                    allowDraftToggle={activeCaps.draftPrToggle}
                    onAction={() => {
                      void fetchPrs();
                    }}
                  />
                );
              })()}
              {/* v0.8-B: pr checks tab — simple horizontal switcher between
                  the existing diff/review surface and the dedicated checks
                  list. Sits below the action bar so PRActionBar stays
                  reachable on every tab. */}
              <div className="flex items-center gap-0 border-b border-bg-border bg-bg-secondary px-3.5">
                {(
                  [
                    { key: "overview", label: "Overview" },
                    ...(activeCaps.checkRuns ? [{ key: "checks" as const, label: "Checks" }] : []),
                  ] as { key: "overview" | "checks"; label: string }[]
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setPrDetailTab(t.key)}
                    className={`border-b-2 px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                      prDetailTab === t.key
                        ? "border-accent-purple text-text-primary"
                        : "border-transparent text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {prDetailTab === "overview" ? (
                <>
                  <div className="p-3">
                    {isPrLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 size={16} className="animate-spin text-text-muted" />
                      </div>
                    ) : prDiff ? (
                      <div className="overflow-hidden rounded-lg border border-bg-border">
                        <DiffViewer
                          diff={prDiff}
                          reviewComments={prReviewComments}
                          onAddComment={
                            activeCaps.inlineReviewComments &&
                            config.selectedRepo &&
                            selectedPrNumber != null
                              ? async (anchor: DiffCommentAnchor, body: string) => {
                                  const { owner, repo } = config.selectedRepo!;
                                  await invoke("github_post_pr_review_comment", {
                                    owner,
                                    repo,
                                    prNumber: selectedPrNumber,
                                    path: anchor.path,
                                    line: anchor.line,
                                    side: anchor.side,
                                    body,
                                  });
                                  setReviewRefreshKey((k) => k + 1);
                                }
                              : undefined
                          }
                        />
                      </div>
                    ) : (
                      <p className="text-[11px] text-text-muted">No diff available.</p>
                    )}
                  </div>
                  {/* v0.8-E: AI pre-flight code review. Lives below the diff so
                      it reads naturally as "here's the change, here's what the
                      AI thinks of it". */}
                  {(() => {
                    const pr = prs.find((p) => p.number === selectedPrNumber);
                    if (!pr) return null;
                    return aiAssistAvailable ? (
                      <PRReviewPanel key={`${detailScope}#${pr.number}`} pr={pr} />
                    ) : null;
                  })()}
                  {/* v0.8-13: pr reviews panel — read-only viewer for
                      existing GitHub formal reviews + per-line comment
                      threads. Sits below the AI review so the user sees
                      AI feedback then human feedback in order. */}
                  {(() => {
                    const pr = prs.find((p) => p.number === selectedPrNumber);
                    if (!pr) return null;
                    return activeCaps.prReviews ? (
                      <PullRequestReviewsPanel
                        key={`${detailScope}#${pr.number}`}
                        pr={pr}
                        refreshKey={reviewRefreshKey}
                      />
                    ) : null;
                  })()}
                </>
              ) : (
                /* v0.8-B: pr checks tab */
                (() => {
                  const pr = prs.find((p) => p.number === selectedPrNumber);
                  if (!pr) return null;
                  return <PRChecksTab pr={pr} />;
                })()
              )}
            </div>
          )}
        </div>
      ) : tab === "releases" ? (
        <ReleasesList releases={releases} loading={isReleasesLoading} error={releasesError} />
      ) : (
        <ActivityFeed
          issues={issues}
          prs={prs}
          owner={config.selectedRepo?.owner ?? ""}
          repo={config.selectedRepo?.repo ?? ""}
        />
      )}

      {showPRModal && (
        <PRModal
          onClose={() => setShowPRModal(false)}
          onSubmit={createPR}
          isLoading={isLoading}
          allowAiAssist={aiAssistAvailable}
          allowDraft={activeCaps.draftPrToggle}
          /* v0.8 spec: when a user opens the PR modal while focused on an
             issue, seed the "Closes #N" picker with that issue so the
             linkage is the default rather than an extra click. */
          initialLinkedIssues={selectedIssueNum != null ? [selectedIssueNum] : []}
        />
      )}

      {/* v0.8-F: triage drawer */}
      {triageOpen && aiAssistAvailable && config.selectedRepo && (
        <AITriageDrawer
          owner={config.selectedRepo.owner}
          repo={config.selectedRepo.repo}
          untriagedIssues={untriagedIssues}
          onClose={() => setTriageOpen(false)}
          onApply={handleTriageApply}
        />
      )}
    </div>
  );
}

/** GP6: read-only list of the selected repo's releases (GitHub + Gitea). */
function ReleasesList({
  releases,
  loading,
  error,
}: {
  releases: GitHubRelease[];
  loading: boolean;
  error: string | null;
}) {
  if (loading && releases.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-text-muted">
        Loading releases…
      </div>
    );
  }
  if (error && releases.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-accent-red">
        Couldn’t load releases: {error}
      </div>
    );
  }
  if (releases.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-text-muted">
        No releases published for this repository.
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {releases.map((r) => (
        <a
          key={r.id}
          href={r.html_url}
          target="_blank"
          rel="noreferrer"
          className="block rounded-lg border border-bg-border bg-bg-primary px-3 py-2 transition-colors hover:border-line-strong"
        >
          <div className="flex items-center gap-2">
            <Tag size={11} className="flex-shrink-0 text-text-muted" />
            <span className="truncate text-[12px] font-semibold text-text-primary">
              {r.name || r.tag_name}
            </span>
            <span className="font-mono text-[10px] text-text-muted">{r.tag_name}</span>
            {r.draft && (
              <span className="rounded bg-accent-amber/15 px-1.5 py-0.5 text-[9px] text-accent-amber">
                draft
              </span>
            )}
            {r.prerelease && (
              <span className="rounded bg-accent-blue/15 px-1.5 py-0.5 text-[9px] text-accent-blue">
                pre-release
              </span>
            )}
            <span className="flex-1" />
            {r.published_at && (
              <span className="flex-shrink-0 text-[10px] text-text-muted">
                {relativeTime(Date.parse(r.published_at))}
              </span>
            )}
          </div>
          {r.body && (
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-snug text-text-secondary">
              {r.body.slice(0, 400)}
            </p>
          )}
        </a>
      ))}
    </div>
  );
}

interface HeaderBandProps {
  username: string;
  repos: ReturnType<typeof useGitHubStore.getState>["repos"];
  selected: { owner: string; repo: string } | null;
  onSelectRepo: (owner: string, repo: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  onNewPR: () => void;
  onDisconnect: () => void;
  /** G13: the active host, so the header icon + label follow the workspace. */
  hostKind: GitHostKind;
}

function HeaderBand({
  username,
  repos,
  selected,
  onSelectRepo,
  onRefresh,
  isLoading,
  onNewPR,
  onDisconnect,
  hostKind,
}: HeaderBandProps) {
  return (
    <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-bg-border bg-bg-secondary px-3.5 py-2.5">
      <HostIcon kind={hostKind} size={13} className="text-text-primary" />
      <span className="text-xs font-semibold text-text-primary">{hostLabel(hostKind)}</span>

      <RepoSelector selected={selected} repos={repos} onSelect={onSelectRepo} />

      <button
        type="button"
        onClick={onRefresh}
        disabled={isLoading}
        title="Refresh"
        className="p-1 text-text-muted transition-colors hover:text-text-primary"
      >
        <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
      </button>

      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-green/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-green">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-green" />
        Connected · {username}
      </span>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onNewPR}
        className="inline-flex items-center gap-1.5 rounded border border-accent-purple/30 bg-accent-purple/15 px-2.5 py-1 text-[10.5px] font-medium text-accent-purple transition-colors hover:bg-accent-purple/25"
      >
        <GitPullRequest size={10} />
        New PR
      </button>
      {hostKind === "github" && (
        <button
          type="button"
          onClick={onDisconnect}
          className="px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:text-accent-red"
        >
          Disconnect
        </button>
      )}
    </div>
  );
}

interface SubTabsProps {
  tab: TabKey;
  onTab: (t: TabKey) => void;
  issueCount: number;
  prCount: number;
  unreadCount: number;
  lastSyncAt: number | null;
  /** G10: Gitea has no Events activity feed — hide the tab for it. */
  showActivity: boolean;
}

function SubTabs({
  tab,
  onTab,
  issueCount,
  prCount,
  unreadCount,
  lastSyncAt,
  showActivity,
}: SubTabsProps) {
  return (
    <div className="flex flex-shrink-0 items-center border-b border-bg-border bg-bg-secondary px-2.5">
      <GhTab
        active={tab === "issues"}
        onClick={() => onTab("issues")}
        icon={<AlertCircle size={10} />}
        label="Issues"
        badge={issueCount}
        accent="green"
      />
      <GhTab
        active={tab === "prs"}
        onClick={() => onTab("prs")}
        icon={<GitBranch size={10} />}
        label="Pull requests"
        badge={prCount}
        accent="purple"
      />
      {showActivity && (
        <GhTab
          active={tab === "activity"}
          onClick={() => onTab("activity")}
          icon={<Clock size={10} />}
          label="Activity"
          accent="default"
        />
      )}
      <GhTab
        active={tab === "inbox"}
        onClick={() => onTab("inbox")}
        icon={<Bell size={10} />}
        label="Inbox"
        badge={unreadCount > 0 ? unreadCount : undefined}
        accent="default"
      />
      <GhTab
        active={tab === "releases"}
        onClick={() => onTab("releases")}
        icon={<Tag size={10} />}
        label="Releases"
        accent="default"
      />
      <div className="flex-1" />
      <span className="px-1.5 text-[10px] text-text-muted">
        {lastSyncAt ? (
          <>
            synced <span className="font-mono text-text-secondary">{relativeTime(lastSyncAt)}</span>
          </>
        ) : (
          <span className="font-mono text-text-secondary">not synced yet</span>
        )}
      </span>
    </div>
  );
}

interface GhTabProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  accent: "green" | "purple" | "default";
}

function GhTab({ active, onClick, icon, label, badge, accent }: GhTabProps) {
  const accentText =
    accent === "green"
      ? "text-accent-green"
      : accent === "purple"
        ? "text-accent-purple"
        : "text-accent-blue";
  const accentBorder =
    accent === "green"
      ? "border-accent-green"
      : accent === "purple"
        ? "border-accent-purple"
        : "border-accent-blue";
  const badgeBg = active
    ? accent === "green"
      ? "bg-accent-green/20 text-accent-green"
      : accent === "purple"
        ? "bg-accent-purple/20 text-accent-purple"
        : "bg-accent-blue/20 text-accent-blue"
    : "bg-bg-tertiary text-text-muted";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[11px] transition-colors ${
        active
          ? `${accentText} ${accentBorder} font-semibold`
          : "border-transparent font-medium text-text-muted hover:text-text-secondary"
      }`}
    >
      {icon} {label}
      {badge != null && (
        <span className={`rounded-full px-1.5 text-[9px] tabular-nums ${badgeBg}`}>{badge}</span>
      )}
    </button>
  );
}

interface IssueDetailProps {
  issue: GitHubIssue | null;
  investigation: string | null;
  isInvestigating: boolean;
  onImport: (issue: GitHubIssue) => void;
  onInvestigate: (issueNumber: number) => void;
  // v0.8-C
  onRefetch?: () => void;
  aiAssistAvailable?: boolean;
}

function IssueDetail({
  issue,
  investigation,
  isInvestigating,
  onImport,
  onInvestigate,
  onRefetch,
  aiAssistAvailable = true,
}: IssueDetailProps) {
  // v0.8-D — store hooks for Plan flight + Branch from issue. Hooks must
  // run in stable order on every render, so they're called BEFORE the
  // `!issue` early-return below.

  const openFlightBrief = useAppStore((s) => s.openFlightBrief);

  const projectPathFromLayout = useLayoutStore((s) => s.projectPath);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );

  const [actionBusy, setActionBusy] = useState<null | "plan" | "branch">(null);
  const [feedback, setFeedback] = useState<CtaFeedback>(null);

  const issueNum = issue?.number;
  useEffect(() => {
    // Clear stale feedback when the selected issue changes — a "Created
    // branch issue-42-…" line for a different issue would be misleading.
    setFeedback(null);
    setActionBusy(null);
  }, [issueNum]);

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center bg-bg-primary text-[11px] text-text-muted">
        Select an issue to view details
      </div>
    );
  }

  const workspaceIsRemote = Boolean(activeWorkspace && !isLocalWorkspace(activeWorkspace));
  const resolvedProjectPath = activeWorkspace
    ? workspaceIsRemote
      ? (activeWorkspace.remoteProjectPath ?? activeWorkspace.projectPath)
      : activeWorkspace.projectPath
    : projectPathFromLayout || "";

  async function handlePlanFlight() {
    if (!issue || actionBusy) return;
    openFlightBrief({
      title: issue.title,
      objective: `GitHub issue #${issue.number}: ${issue.title}${issue.body?.trim() ? `\n\n${issue.body.trim()}` : ""}`,
      projectPath: resolvedProjectPath,
      workspaceId: activeWorkspace?.id,
      serverId: activeWorkspace?.serverId,
      sourceLabel: `GitHub issue #${issue.number}`,
    });
  }
  async function handleBranchFromIssue() {
    if (!issue || actionBusy) return;
    if (workspaceIsRemote) {
      setFeedback({
        tone: "error",
        message:
          "Branch from issue is local-only here. Use the Workspace Git panel for this SSH project.",
      });
      return;
    }
    if (!resolvedProjectPath) {
      setFeedback({
        tone: "error",
        message: "No active workspace — open one to create branches.",
      });
      return;
    }
    setActionBusy("branch");
    setFeedback(null);
    try {
      const slug = slugifyIssueTitle(issue.title) || "untitled";
      const branchName = `issue-${issue.number}-${slug}`;
      await gitCreateBranch(resolvedProjectPath, branchName, true);
      setFeedback({
        tone: "success",
        message: `Created branch \`${branchName}\``,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Branch failed: ${msg}` });
    } finally {
      setActionBusy(null);
    }
  }

  const issueIsOpen = issue.state !== "closed";
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto bg-bg-primary">
      <div className="border-b border-bg-border px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-2">
              {issueIsOpen ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-accent-green/30 bg-accent-green/15 px-2 py-0.5 text-[10px] font-semibold text-accent-green">
                  <AlertCircle size={9} /> Open
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-accent-purple/30 bg-accent-purple/15 px-2 py-0.5 text-[10px] font-semibold text-accent-purple">
                  <Check size={9} /> Closed
                </span>
              )}
              <span className="text-[10px] text-text-muted">
                <span className="text-text-secondary">{issue.user.login}</span> opened{" "}
                {timeAgo(issue.created_at)} ago
                <span className="mx-1.5 text-line-strong">·</span>
                <span className="font-mono">#{issue.number}</span>
              </span>
            </div>
            <h2 className="m-0 text-[15px] font-semibold leading-snug text-text-primary">
              {issue.title}
            </h2>
            {issue.labels.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {issue.labels.map((l) => (
                  <span
                    key={l.name}
                    className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `#${l.color}22`,
                      color: `#${l.color}`,
                      borderColor: `#${l.color}44`,
                    }}
                  >
                    {l.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <a
            href={issue.html_url}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            className="p-1 text-text-muted hover:text-text-primary"
          >
            <Send size={11} className="-rotate-45" />
          </a>
        </div>
      </div>

      {/* v0.8-C: issue actions / comments */}
      <IssueActionBar issue={issue} onChange={() => onRefetch?.()} />

      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-bg-border bg-bg-secondary px-4 py-2">
        <button
          type="button"
          onClick={() => onImport(issue)}
          className="inline-flex items-center gap-1.5 rounded border border-accent-green/30 bg-accent-green/15 px-2.5 py-1 text-[10.5px] font-medium text-accent-green transition-colors hover:bg-accent-green/25"
        >
          <Diamond size={10} /> Import to board
        </button>
        <button
          type="button"
          onClick={() => onInvestigate(issue.number)}
          disabled={isInvestigating || !aiAssistAvailable}
          title={
            aiAssistAvailable
              ? "Investigate this issue with the configured AI route"
              : "AI investigation is available for local GitHub Workspaces only"
          }
          className="inline-flex items-center gap-1.5 rounded border border-accent-blue/30 bg-accent-blue/15 px-2.5 py-1 text-[10.5px] font-medium text-accent-blue transition-colors hover:bg-accent-blue/25 disabled:opacity-50"
        >
          {isInvestigating ? <Loader2 size={10} className="animate-spin" /> : <Brain size={10} />}
          Investigate with AI
        </button>
        {/* v0.8-D — Plan flight: stage a flight seeded with the issue body;
            attempts are launched from the Flights view's "Launch attempt"
            affordance (asyncFlightStore worktree-attempt path). */}
        <button
          type="button"
          onClick={() => void handlePlanFlight()}
          disabled={actionBusy === "plan"}
          className="inline-flex items-center gap-1.5 rounded border border-accent-line bg-accent-soft px-2.5 py-1 text-[10.5px] font-medium text-accent-green transition-colors hover:bg-accent-green/15 disabled:opacity-50"
        >
          {actionBusy === "plan" ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Plane size={10} />
          )}{" "}
          Send to Flight
        </button>
        <div className="flex-1" />
        {/* v0.8-D — Branch from issue: create `issue-{N}-{slug}` in the
            active workspace cwd and check it out. */}
        <button
          type="button"
          onClick={() => void handleBranchFromIssue()}
          disabled={actionBusy === "branch" || workspaceIsRemote}
          title={
            workspaceIsRemote
              ? "Use the Workspace Git panel to create a branch on this SSH project"
              : "Create and check out a branch in the active local Workspace"
          }
          className="inline-flex items-center gap-1.5 px-2 py-1 text-[10.5px] text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          {actionBusy === "branch" ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <GitBranch size={10} />
          )}{" "}
          Branch from issue
        </button>
      </div>

      {/* v0.8-D — inline feedback under the action row. Reflects the last
          CTA invocation; cleared on issue change or by the user. */}
      {feedback && <CtaFeedbackRow feedback={feedback} onDismiss={() => setFeedback(null)} />}

      <div className="border-b border-bg-border px-4 py-3.5">
        <IssueBody body={issue.body} />
      </div>

      {/* v0.8-C: issue actions / comments */}
      <div className="border-b border-bg-border px-4 py-3">
        <IssueCommentList issue={issue} />
      </div>
      <div className="border-b border-bg-border px-4 py-3">
        <IssueCommentComposer issue={issue} onPosted={() => onRefetch?.()} />
      </div>

      <div className="min-h-0 flex-1 px-4 py-3.5">
        {aiAssistAvailable ? (
          <InvestigationPanel
            issue={issue}
            investigation={investigation}
            isInvestigating={isInvestigating}
            onRun={() => onInvestigate(issue.number)}
          />
        ) : (
          <p className="text-[11px] text-text-muted">
            AI investigation is unavailable for this Git host or SSH Workspace.
          </p>
        )}
      </div>
    </div>
  );
}
