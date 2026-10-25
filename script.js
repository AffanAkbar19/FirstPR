/*
  FirstPR — script.js
  -------------------------------------------------------------
  What this file does:
  1. Reads the GitHub link the user pastes.
  2. Asks GitHub's public REST API for the repository's open issues.
  3. Puts issues labeled "good first issue" or "help wanted" first, with filters.
  4. Opens a rule-based starter guide for any issue.

  Safety rule used everywhere in this file:
  Text from the user or from GitHub is NEVER put into innerHTML.
  We use textContent and append(), so the browser always shows that
  text as plain text and can never run it as HTML or code.
*/
"use strict";

/* =========================================================
   1. Settings
   ========================================================= */
const API_BASE = "https://api.github.com";
const GOOD_FIRST = "good first issue";
const HELP_WANTED = "help wanted";
const PAGE_SIZE = 20;              // issues shown at a time in each list
const REQUEST_TIMEOUT_MS = 20000;  // stop waiting for GitHub after 20 seconds
const SLOW_AFTER_MS = 6000;        // after 6 seconds, tell the user we are still waiting
const STORAGE_PREFIX = "firstpr:"; // keys for things saved in this browser only

/* =========================================================
   2. Page elements we use
   ========================================================= */
const form = document.getElementById("repo-form");
const input = document.getElementById("repo-url");
const findButton = document.getElementById("find-button");
const urlError = document.getElementById("repo-error");
const heroQuota = document.getElementById("hero-quota");

const results = document.getElementById("results");
const resultsTitle = document.getElementById("results-title");
const statusBox = document.getElementById("status");
const resultsQuota = document.getElementById("results-quota");
const toolbar = document.getElementById("toolbar");
const toolbarNote = document.getElementById("toolbar-note");
const filterInputs = document.querySelectorAll('input[name="filter"]');
const resultsBody = document.getElementById("results-body");

const guideDialog = document.getElementById("guide");
const guideContent = document.getElementById("guide-content");
const guideClose = document.getElementById("guide-close");
const guideAnnouncer = document.getElementById("guide-announcer");

/* =========================================================
   3. App state: things we remember while the page is open
   ========================================================= */
const state = {
  loading: false,
  repo: null,              // { owner, repo, fullName } of the current search
  issues: [],              // the loaded issues, sorted
  issueMap: new Map(),     // issue number -> issue
  filter: "all",           // "all", "gfi", "hw" or "other"
  quota: null,             // { remaining, limit, reset } from GitHub
  contributing: new Map(), // "owner/repo" -> promise with CONTRIBUTING.md info
  guideOpener: null        // the button that opened the guide (focus returns there)
};

// A small error type, so we can show the right message for each problem
class GitHubProblem extends Error {
  constructor(kind, extra = {}) {
    super(kind);
    this.kind = kind; // "network", "timeout", "not-found", "issues-off", "rate-limit", "slow-down" or "http"
    Object.assign(this, extra);
  }
}

/* =========================================================
   4. Start-up
   ========================================================= */
form.addEventListener("submit", onSearch);

input.addEventListener("input", () => {
  if (input.getAttribute("aria-invalid") === "true") clearUrlError();
});

filterInputs.forEach((radio) => radio.addEventListener("change", () => {
  state.filter = radio.value;
  renderLists({ announce: true });
}));

// One click listener for everything inside the results (also works for rows added later)
resultsBody.addEventListener("click", (event) => {
  const guideButton = event.target.closest("button[data-issue]");
  if (guideButton) openGuide(Number(guideButton.dataset.issue), guideButton);
});

guideClose.addEventListener("click", () => guideDialog.close());
// Clicking the dark area around the panel closes it (the Escape key works too)
guideDialog.addEventListener("click", (event) => {
  if (event.target === guideDialog) guideDialog.close();
});
guideDialog.addEventListener("close", () => {
  if (state.guideOpener && document.contains(state.guideOpener)) state.guideOpener.focus();
});

checkQuota(); // show how many GitHub requests this network has left (this check is free)

/* =========================================================
   5. Search form and link checking
   ========================================================= */
function onSearch(event) {
  event.preventDefault();    // stop the browser from reloading the page
  if (state.loading) return; // ignore extra clicks while we wait for GitHub

  if (input.value.trim() === "") {
    showUrlError("Paste a GitHub repository link first, like https://github.com/owner/repo");
    return;
  }
  const repo = parseRepoUrl(input.value);
  if (!repo) {
    showUrlError("That doesn't look like a GitHub repository link. Use this format: https://github.com/owner/repo");
    return;
  }
  clearUrlError();
  findIssues(repo);
}

/*
  Turns what the user pasted into { owner, repo, fullName }, or null if it isn't valid.
  Accepts: https://github.com/owner/repo, github.com/owner/repo,
  links to pages inside a repo (/issues, /tree/main...), links ending in .git,
  "owner/repo", and git@github.com:owner/repo.git
*/
function parseRepoUrl(text) {
  let value = text.trim().replace(/^git@github\.com:/i, "https://github.com/");

  // "owner/repo" on its own: add the GitHub address in front
  if (/^[\w.-]+\/[\w.-]+$/.test(value) && !/^(www\.)?github\.com\//i.test(value)) {
    value = "https://github.com/" + value;
  }
  // "github.com/owner/repo" without https://
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null; // not a link at all
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;

  const [owner, repoPart] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repoPart) return null;
  const repo = repoPart.replace(/\.git$/i, "");
  return isValidRepo(owner, repo) ? { owner, repo, fullName: `${owner}/${repo}` } : null;
}

// GitHub's own rules for user names and repository names
function isValidRepo(owner, repo) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== "." && repo !== "..";
}

function showUrlError(message) {
  urlError.textContent = message;
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", "repo-error repo-hint");
  input.focus();
}

function clearUrlError() {
  urlError.textContent = "";
  input.removeAttribute("aria-invalid");
  input.setAttribute("aria-describedby", "repo-hint");
}

/* =========================================================
   6. Talking to GitHub
   ========================================================= */

// Loads the issues for one repository and shows them
async function findIssues(repo) {
  state.repo = repo;
  state.issues = [];
  state.issueMap.clear();
  setFilter("all");

  results.hidden = false;
  toolbar.hidden = true;
  toolbarNote.hidden = true;
  setResultsTitle(repo.fullName, null);
  setLoading(true);
  resultsBody.replaceChildren(skeleton());
  results.scrollIntoView({ block: "start" }); // bring the results area into view

  // If GitHub is slow, say so honestly instead of leaving the user guessing
  const slowTimer = setTimeout(() => {
    if (state.loading) setStatus("Still waiting for GitHub. Slow connections can take a little longer…", { spinner: true });
  }, SLOW_AFTER_MS);

  const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?state=open`;

  // Three requests at the same time (each search uses 3 of your 60 hourly requests):
  //  1. the 100 newest open issues
  //  2. up to 50 issues labeled "good first issue" (these can be older, so request 1 may miss them)
  //  3. up to 50 issues labeled "help wanted"
  const [newest, firstIssues, helpWanted] = await Promise.allSettled([
    githubGet(`${path}&per_page=100`),
    githubGet(`${path}&per_page=50&labels=${encodeURIComponent(GOOD_FIRST)}`),
    githubGet(`${path}&per_page=50&labels=${encodeURIComponent(HELP_WANTED)}`)
  ]);
  clearTimeout(slowTimer);
  setLoading(false);

  if (newest.status === "rejected") {
    showProblem(newest.reason, repo);
    return;
  }

  // The labeled lists are a bonus: if they failed, we still show the newest issues
  const extra = [firstIssues, helpWanted].flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []));
  const issues = removePullRequestsAndDuplicates([...newest.value, ...extra]);

  // Use GitHub's spelling of the repository name (for example "facebook/react")
  const official = officialRepoName(issues[0]);
  if (official) Object.assign(state.repo, official);

  state.issues = issues.sort(byPriority);
  issues.forEach((issue) => state.issueMap.set(issue.number, issue));
  showIssues();
}

// One GET request to the GitHub API. Returns the JSON data or throws a GitHubProblem.
async function githubGet(path) {
  let response;
  try {
    response = await fetch(API_BASE + path, {
      headers: { Accept: "application/vnd.github+json" },
      signal: timeoutSignal(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    // fetch only fails like this when there is no connection (or it timed out)
    throw new GitHubProblem(error && error.name === "TimeoutError" ? "timeout" : "network");
  }

  updateQuotaFromHeaders(response.headers);

  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new GitHubProblem("http", { status: response.status });
    }
  }

  // Read GitHub's error message, if there is one
  let message = "";
  try {
    message = (await response.json()).message || "";
  } catch {
    // the answer was not JSON; that's fine
  }

  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      // The hourly limit (60 requests without login). GitHub tells us when it resets.
      const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
      throw new GitHubProblem("rate-limit", { resetAt: resetSeconds ? new Date(resetSeconds * 1000) : null });
    }
    // A short-term limit: too many requests sent too quickly
    if (/rate limit/i.test(message)) throw new GitHubProblem("slow-down");
  }
  if (response.status === 404) throw new GitHubProblem("not-found");
  if (response.status === 410) throw new GitHubProblem("issues-off");
  throw new GitHubProblem("http", { status: response.status });
}

// GitHub's issues list also contains pull requests. They have a "pull_request" key, so we skip them.
function removePullRequestsAndDuplicates(items) {
  const byId = new Map();
  for (const item of items) {
    if (!item || item.pull_request) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

// "https://api.github.com/repos/facebook/react" -> { owner: "facebook", repo: "react", fullName: "facebook/react" }
function officialRepoName(issue) {
  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec((issue && issue.repository_url) || "");
  if (!match || !isValidRepo(match[1], match[2])) return null;
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

/* =========================================================
   7. GitHub request limit (60 per hour without login)
   ========================================================= */

// Asking GitHub how many requests are left does not use one up
async function checkQuota() {
  try {
    const response = await fetch(`${API_BASE}/rate_limit`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: timeoutSignal(8000)
    });
    if (!response.ok) return;
    const data = await response.json();
    const core = data && data.resources && data.resources.core;
    if (core && Number.isFinite(core.remaining)) setQuota(core.remaining, core.limit, core.reset);
  } catch {
    // No connection or blocked: show nothing rather than a guess
  }
}

function updateQuotaFromHeaders(headers) {
  const remaining = headers.get("x-ratelimit-remaining");
  if (remaining === null) return;
  setQuota(Number(remaining), Number(headers.get("x-ratelimit-limit")), Number(headers.get("x-ratelimit-reset")));
}

function setQuota(remaining, limit, reset) {
  if (!Number.isFinite(remaining)) return;
  const old = state.quota;
  // Answers can arrive in any order, so keep the smallest count for the same hour
  if (old && old.reset === reset) remaining = Math.min(old.remaining, remaining);
  state.quota = { remaining, limit: limit || (old && old.limit) || 60, reset };
  renderQuota();
}

function renderQuota() {
  const quota = state.quota;
  const level = quota.remaining === 0 ? "empty" : quota.remaining <= 10 ? "low" : "ok";
  let text = `${quota.remaining} of ${quota.limit} GitHub requests left this hour`;
  const resetTime = formatTime(quota.reset);
  if (level !== "ok" && resetTime) text += `. Resets at ${resetTime}`;

  for (const target of [heroQuota, resultsQuota]) {
    target.dataset.level = level;
    target.replaceChildren(el("span", { className: "quota-dot", "aria-hidden": "true" }), text);
    target.hidden = false;
  }
}

/* =========================================================
   8. Results: loading, problems and issue lists
   ========================================================= */
function setLoading(isLoading) {
  state.loading = isLoading;
  findButton.textContent = isLoading ? "Searching…" : "Find issues";
  findButton.setAttribute("aria-disabled", String(isLoading));
  resultsBody.setAttribute("aria-busy", String(isLoading));
  if (isLoading) setStatus("Looking for open issues…", { spinner: true });
  else setStatus("");
}

function setStatus(text, { spinner = false } = {}) {
  statusBox.replaceChildren();
  if (spinner) statusBox.append(el("span", { className: "spinner", "aria-hidden": "true" }));
  if (text) statusBox.append(text);
}

function setResultsTitle(name, url) {
  resultsTitle.replaceChildren(url ? externalLink(url, name, { className: "", context: "" }) : name);
}

// Grey placeholder rows while GitHub answers (hidden from screen readers; the status line speaks instead)
function skeleton() {
  const rows = [0, 1, 2].map(() => el("div", { className: "skeleton-row" }, [
    el("span", { className: "skeleton-node" }),
    el("div", {}, [
      el("div", { className: "skeleton-line", style: "width: 28%" }),
      el("div", { className: "skeleton-line", style: "width: 64%; height: 16px" }),
      el("div", { className: "skeleton-line", style: "width: 88%" }),
      el("div", { className: "skeleton-line", style: "width: 42%" })
    ])
  ]));
  return el("div", { className: "skeleton", "aria-hidden": "true" }, rows);
}

function showProblem(problem, repo) {
  const kind = problem && problem.kind;
  const tryAgain = () => button("Try again", "retry", () => findIssues(repo), "button button-secondary");
  const editLink = () => button("Edit the link", "search", () => { input.focus(); input.select(); window.scrollTo({ top: 0 }); }, "button button-secondary");

  const messages = {
    "network": ["Couldn't reach GitHub", "Check your internet connection, then try again.", "alert", [tryAgain()]],
    "timeout": ["GitHub took too long to answer", "Your connection may be slow, or GitHub may be busy. Try again in a moment.", "clock", [tryAgain()]],
    "not-found": ["Repository not found", `We couldn't find ${repo.fullName}. It may not exist, or it may be private. FirstPR can only read public repositories.`, "lock", [editLink()]],
    "issues-off": ["Issues are turned off", `${repo.fullName} doesn't use GitHub issues, so there is nothing to show. Try another repository.`, "info", [editLink()]],
    "rate-limit": ["GitHub's hourly limit is used up", rateLimitText(problem && problem.resetAt), "clock", []],
    "slow-down": ["GitHub asked us to slow down", "Too many requests were sent in a short time. Wait a minute, then try again.", "clock", [tryAgain()]],
    "http": ["GitHub returned an error", `GitHub answered with error ${problem && problem.status}. This is usually temporary. Wait a minute, then try again.`, "alert", [tryAgain()]]
  };
  const [title, text, iconName, actions] = messages[kind] || ["Something went wrong", "Please try again.", "alert", [tryAgain()]];
  const tone = kind === "rate-limit" || kind === "slow-down" ? "warn" : "error";
  resultsBody.replaceChildren(notice(tone, iconName, title, [text], actions));
}

function rateLimitText(resetAt) {
  const when = resetAt ? `after ${resetAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "in about an hour";
  return `Without signing in, GitHub allows 60 requests per hour for each network, and everyone on the same Wi-Fi shares them. Try again ${when}, or switch to another network, such as your phone's hotspot.`;
}

// A message box. tone is "error", "warn" or "empty".
function notice(tone, iconName, title, content, actions = []) {
  const body = el("div", { className: "notice-body" }, [
    el("p", { className: "notice-title" }, [title]),
    el("p", { className: "notice-text" }, content)
  ]);
  if (actions.length) body.append(el("div", { className: "notice-actions" }, actions));
  const box = el("div", { className: `notice notice-${tone}` }, [
    el("span", { className: "notice-icon", "aria-hidden": "true" }, [svgIcon(iconName)]),
    body
  ]);
  // Errors and warnings are read out right away. Empty lists are already announced by the status line.
  if (tone !== "empty") box.setAttribute("role", "alert");
  return box;
}

function showIssues() {
  const repo = state.repo;
  const repoUrl = `https://github.com/${repo.fullName}`;
  setResultsTitle(repo.fullName, repoUrl);

  if (state.issues.length === 0) {
    setStatus("No open issues right now.");
    resultsBody.replaceChildren(notice("empty", "info", "No open issues right now", [
      `${repo.fullName} has no open issues (pull requests are not counted). Try another project, or `,
      externalLink(repoUrl, "open it on GitHub", { className: "text-link" }),
      " to look around."
    ]));
    return;
  }

  const counts = {
    all: state.issues.length,
    gfi: state.issues.filter((issue) => hasLabel(issue, GOOD_FIRST)).length,
    hw: state.issues.filter((issue) => hasLabel(issue, HELP_WANTED)).length,
    other: state.issues.filter((issue) => !isMarkedForBeginners(issue)).length
  };
  for (const [key, value] of Object.entries(counts)) {
    toolbar.querySelector(`[data-count="${key}"]`).textContent = String(value);
  }
  toolbar.hidden = false;
  toolbarNote.hidden = false;

  const marked = state.issues.filter(isMarkedForBeginners).length;
  setStatus(`${plural(counts.all, "open issue")} loaded. ${marked === 1 ? "1 is" : `${marked} are`} marked for beginners.`);
  renderLists();
}

// Builds the lists for the chosen filter
function renderLists({ announce = false } = {}) {
  if (!state.repo || state.issues.length === 0) return;
  const issues = state.issues;
  const marked = issues.filter(isMarkedForBeginners);
  const others = issues.filter((issue) => !isMarkedForBeginners(issue));
  const labelSearch = (label) => `https://github.com/${state.repo.fullName}/issues?q=${encodeURIComponent(`is:issue is:open label:"${label}"`)}`;

  const views = {
    all: [
      { title: "Marked for beginners", note: "Labeled “good first issue” or “help wanted” by the maintainers.", items: marked,
        empty: "None of the issues FirstPR loaded have these labels. The other issues below may still suit you, but read them carefully." },
      { title: "Other open issues", note: "No beginner label. Some may still suit you, but they can need more experience.", items: others,
        empty: "Every issue FirstPR loaded has a beginner label." }
    ],
    gfi: [{ title: "Good first issue", note: "Maintainers marked these as a good first contribution.",
      items: issues.filter((issue) => hasLabel(issue, GOOD_FIRST)),
      empty: "No issues labeled “good first issue” were found in this repository.", searchUrl: labelSearch(GOOD_FIRST) }],
    hw: [{ title: "Help wanted", note: "Maintainers would welcome outside help. These are not always easy.",
      items: issues.filter((issue) => hasLabel(issue, HELP_WANTED)),
      empty: "No issues labeled “help wanted” were found in this repository.", searchUrl: labelSearch(HELP_WANTED) }],
    other: [{ title: "Other open issues", note: "No beginner label. Some may still suit you, but they can need more experience.",
      items: others, empty: "Every issue FirstPR loaded has a beginner label." }]
  };
  const groups = views[state.filter] || views.all;

  resultsBody.replaceChildren(...groups.map(issueGroup), el("p", { className: "results-footnote" }, [
    "FirstPR loads up to 100 recent open issues, plus up to 50 labeled “good first issue” and 50 labeled “help wanted”. Big projects have more. ",
    externalLink(`https://github.com/${state.repo.fullName}/issues`, "See all open issues on GitHub", { className: "inline-link" })
  ]));

  if (announce) {
    const shown = groups.reduce((sum, group) => sum + group.items.length, 0);
    const summaries = {
      all: `Showing all ${plural(shown, "open issue")}.`,
      gfi: `Showing ${plural(shown, "issue")} labeled “good first issue”.`,
      hw: `Showing ${plural(shown, "issue")} labeled “help wanted”.`,
      other: `Showing ${plural(shown, "issue")} without a beginner label.`
    };
    setStatus(summaries[state.filter] || summaries.all);
    // If the filter bar is stuck at the top, jump back to the start of the list
    if (toolbar.getBoundingClientRect().top <= navHeight() + 1) resultsBody.scrollIntoView({ block: "start" });
  }
}

function issueGroup(group) {
  const section = el("section", { className: "group" }, [
    el("div", { className: "group-head" }, [
      el("h3", { className: "group-title" }, [group.title, " ", el("span", { className: "count" }, [String(group.items.length)])]),
      el("p", { className: "group-note" }, [group.note])
    ])
  ]);

  if (group.items.length === 0) {
    const actions = [];
    if (state.filter !== "all") actions.push(button("Show all issues", null, () => setFilter("all", { render: true }), "button button-secondary"));
    if (group.searchUrl) actions.push(externalLink(group.searchUrl, "Check this label on GitHub", { className: "text-link" }));
    section.append(notice("empty", "info", "Nothing in this list", [group.empty], actions));
    return section;
  }

  const list = el("ol", { className: "issue-list", role: "list" });
  section.append(list);
  let shown = 0;
  const more = el("div", { className: "show-more" });

  const showNext = (moveFocus) => {
    const next = group.items.slice(shown, shown + PAGE_SIZE);
    next.forEach((issue) => list.append(issueRow(issue)));
    shown += next.length;
    const left = group.items.length - shown;
    more.replaceChildren();
    if (left > 0) more.append(button(`Show ${Math.min(left, PAGE_SIZE)} more`, null, () => showNext(true), "button button-secondary"));
    if (moveFocus && next[0]) {
      const firstNew = list.querySelector(`button[data-issue="${next[0].number}"]`);
      if (firstNew) firstNew.focus();
    }
  };
  showNext(false);
  section.append(more);
  return section;
}

function setFilter(value, { render = false } = {}) {
  state.filter = value;
  filterInputs.forEach((radio) => { radio.checked = radio.value === value; });
  if (render) renderLists({ announce: true });
}

// One issue in the list
function issueRow(issue) {
  const titleId = `issue-${issue.number}-title`;
  const marked = isMarkedForBeginners(issue);

  const main = el("div", { className: "issue-main" }, [
    el("p", { className: "issue-ref" }, [`${state.repo.fullName} #${issue.number}`]),
    el("h4", { className: "issue-title", id: titleId }, [issue.title || "Untitled issue"]),
    el("p", { className: "issue-excerpt" }, [previewText(issue.body)])
  ]);
  const labels = labelList(issue, 4);
  if (labels) main.append(labels);
  const meta = metaList(issue);
  if (meta) main.append(meta);

  const actions = el("div", { className: "issue-actions" }, [
    el("button", { type: "button", className: "button button-primary", "data-issue": String(issue.number), "aria-describedby": titleId }, ["Help me get started"]),
    externalLink(issue.html_url, "View on GitHub", { className: "text-link", context: `: issue #${issue.number}` })
  ]);

  return el("li", { className: "issue", id: `issue-${issue.number}` }, [
    el("span", { className: marked ? "issue-node" : "issue-node issue-node-other", "aria-hidden": "true" }),
    main,
    actions
  ]);
}

// Labels with the colours the project chose. Beginner labels first, then up to "max" labels.
function labelList(issue, max = Infinity) {
  const labels = (issue.labels || []).filter((label) => labelName(label));
  if (labels.length === 0) return null;
  labels.sort((a, b) => Number(isBeginnerLabel(labelName(b))) - Number(isBeginnerLabel(labelName(a))));

  const list = el("ul", { className: "labels", "aria-label": "Labels" });
  labels.slice(0, max).forEach((label) => {
    const name = labelName(label);
    const dot = el("span", { className: "label-dot", "aria-hidden": "true" });
    const color = label && typeof label === "object" ? String(label.color || "") : "";
    if (/^[0-9a-f]{6}$/i.test(color)) dot.style.backgroundColor = `#${color}`; // only real hex colours
    list.append(el("li", { className: isBeginnerLabel(name) ? "label label-beginner" : "label", title: name }, [
      dot, el("span", { className: "label-name" }, [name])
    ]));
  });
  if (labels.length > max) {
    list.append(el("li", { className: "label-more" }, [`+${labels.length - max} more`, el("span", { className: "visually-hidden" }, [" labels"])]));
  }
  return list;
}

// Age, comments and assignee. Anything GitHub didn't send is left out instead of guessed.
function metaList(issue) {
  const items = [];
  const age = timeAgo(issue.created_at);
  if (age) {
    items.push(el("li", {}, [svgIcon("clock"), el("time", { datetime: issue.created_at, title: formatDate(issue.created_at) }, [`Opened ${age}`])]));
  }
  if (typeof issue.comments === "number") {
    items.push(el("li", {}, [svgIcon("comment"), plural(issue.comments, "comment")]));
  }
  if (Array.isArray(issue.assignees)) {
    if (issue.assignees.length) {
      const first = (issue.assignees[0] && issue.assignees[0].login) || "someone";
      const others = issue.assignees.length > 1 ? ` and ${issue.assignees.length - 1} more` : "";
      items.push(el("li", { className: "meta-caution" }, [svgIcon("person"), `Assigned to @${first}${others}`]));
    } else {
      items.push(el("li", { className: "meta-good" }, [svgIcon("person"), "Unassigned"]));
    }
  }
  return items.length ? el("ul", { className: "issue-meta", "aria-label": "Issue details" }, items) : null;
}

/* =========================================================
   9. Starter guide (opens in a panel)
   ========================================================= */
function openGuide(number, opener) {
  const issue = state.issueMap.get(number);
  if (!issue) return;
  state.guideOpener = opener;
  guideAnnouncer.textContent = "";
  guideContent.replaceChildren(...buildGuide(issue));
  guideContent.scrollTop = 0;
  if (typeof guideDialog.showModal === "function") guideDialog.showModal();
  else guideDialog.setAttribute("open", ""); // very old browsers
}

// Plain-language sentence for each kind of issue
const KIND_TEXT = {
  bug: "This looks like a bug report: something in the project doesn't work as expected. The task is to find out why and fix it.",
  docs: "This looks like a documentation task: it's about the text that explains the project, such as the README or guides. These are often a good first contribution.",
  tests: "This looks like a testing task: it's about the code that checks the project works correctly.",
  feature: "This looks like a feature request: someone wants the project to do something new or work better.",
  general: "This issue describes a task the maintainers want done."
};

// How to make sure you understand the request, for each kind of issue
const KIND_UNDERSTAND = {
  bug: "Try to describe the problem in one sentence: what happens now, and what should happen instead.",
  docs: "Work out exactly which page or section needs to change, and why.",
  tests: "Work out which behaviour the new test should check.",
  feature: "Make sure you know what the finished feature should do, and agree on the plan with the maintainers before you build it.",
  general: "Write down what “done” looks like for this issue, in your own words."
};

// Where to start looking when the issue names no files
const KIND_LOOK = {
  bug: "Search the code for words from the error message, or for the name of the broken feature.",
  docs: "Documentation usually lives in the README or in a docs folder.",
  tests: "Tests often live in a folder named test, tests or __tests__. Read a nearby test first.",
  feature: "Find a similar feature in the code and follow the same pattern.",
  general: "Search the code for key words from the issue title."
};

// How to keep the change small, for each kind of issue
const KIND_CHANGE = {
  bug: (facts) => facts.hasSteps
    ? "Reproduce the bug first with the steps in the issue, then fix it."
    : "Make the bug happen on your computer first, so you will know when it is fixed. Then fix it.",
  docs: () => "Change only what the issue asks for, in the same style as the rest of the docs.",
  tests: () => "Copy the style of a nearby test, then add yours.",
  feature: () => "Build the smallest version that solves the issue. You can improve it after review.",
  general: () => "Change only what this issue needs. Small pull requests are easier to review."
};

function buildGuide(issue) {
  const repo = state.repo;
  const facts = readIssue(issue);
  const titleSlug = slug(issue.title || "");
  const branch = titleSlug ? `issue-${issue.number}-${titleSlug}` : `issue-${issue.number}`;

  return [
    guideHeader(issue),
    guideSection("What the issue says", whatItSays(facts)),
    guideSection("Before you start", beforeYouStart(issue, facts)),
    guideSection("Your path to a first pull request", pathSteps(issue, facts, repo)),
    checklistSection(issue, facts, repo, branch),
    el("p", { className: "guide-note" }, [
      "How this guide was made: your browser used simple rules on this issue's title, description, labels and details from GitHub. ",
      "FirstPR did not read the repository's code, run any tests, or use AI. If this guide and the issue disagree, trust the issue."
    ])
  ];
}

function guideHeader(issue) {
  const head = el("header", { className: "guide-head" }, [
    el("p", { className: "guide-ref" }, [`${state.repo.fullName} #${issue.number}`]),
    el("h2", { className: "guide-title", id: "guide-title" }, [issue.title || "Untitled issue"])
  ]);
  const labels = labelList(issue);
  if (labels) head.append(labels);
  const meta = metaList(issue);
  if (meta) head.append(meta);
  head.append(externalLink(issue.html_url, "Open issue on GitHub", { className: "button button-secondary" }));
  return head;
}

function guideSection(title, children) {
  return el("section", { className: "guide-block" }, [el("h3", { className: "guide-block-title" }, [title]), ...children]);
}

function whatItSays(facts) {
  const parts = [];
  if (!facts.hasBody) {
    parts.push(el("p", {}, ["The author didn't write a description. Read the title and the comments on GitHub."]));
  } else if (!facts.summary) {
    parts.push(el("p", {}, ["The description is mostly code, images or a form, so there is no text to summarize here. Read it on GitHub."]));
  } else {
    parts.push(
      el("blockquote", { className: "guide-quote" }, [el("p", {}, [facts.summary])]),
      el("p", { className: "quote-source" }, ["The start of the issue's description, shortened."])
    );
  }

  const found = [];
  if (facts.hasSteps) found.push(el("li", {}, [svgIcon("list"), "Steps to reproduce"]));
  if (facts.hasCode) found.push(el("li", {}, [svgIcon("code"), "Code or error output"]));
  if (facts.hasScreenshots) found.push(el("li", {}, [svgIcon("image"), "Screenshots"]));
  if (facts.tasks.length) found.push(el("li", {}, [svgIcon("check"), plural(facts.tasks.length, "unfinished task")]));
  facts.files.forEach((file) => found.push(el("li", {}, [svgIcon("file"), el("code", {}, [file])])));
  if (found.length) {
    parts.push(el("p", {}, ["Found in the description:"]), el("ul", { className: "found", role: "list" }, found));
  }
  return parts;
}

function beforeYouStart(issue, facts) {
  const signals = [];
  const add = (tone, text) => signals.push(el("li", { className: `signal signal-${tone}` }, [
    el("span", { className: "signal-icon", "aria-hidden": "true" }, [svgIcon(tone === "good" ? "check" : tone === "caution" ? "alert" : "dot")]),
    el("span", { className: "signal-text" }, [text])
  ]));

  if (facts.isGoodFirst) add("good", "Labeled “good first issue”: maintainers think it suits newcomers.");
  if (facts.isHelpWanted) add("neutral", "Labeled “help wanted”: maintainers welcome outside help. It isn't always easy.");
  if (!facts.isGoodFirst && !facts.isHelpWanted) add("caution", "Not labeled for beginners. It may need more experience.");

  if (Array.isArray(issue.assignees)) {
    const people = issue.assignees.map((person) => `@${(person && person.login) || "someone"}`);
    if (people.length) add("caution", `Assigned to ${people.join(", ")}. Someone may already be working on it.`);
    else add("good", "Nobody is assigned yet.");
  }
  if (typeof issue.comments === "number") {
    add("neutral", issue.comments > 0 ? `${plural(issue.comments, "comment")} to read before you start.` : "No comments yet.");
  }
  const created = new Date(issue.created_at);
  if (!Number.isNaN(created.getTime())) {
    const ageInDays = (Date.now() - created) / 86400000;
    if (ageInDays > 365) add("caution", `Opened ${timeAgo(issue.created_at)}. Ask whether it is still needed.`);
    else add("neutral", `Opened ${timeAgo(issue.created_at)}.`);
  }
  return [el("ul", { className: "signals", role: "list" }, signals)];
}

function pathSteps(issue, facts, repo) {
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  const comments = typeof issue.comments === "number" ? issue.comments : null;
  const guessedFrom = facts.kindSource ? ` (FirstPR guessed this from the issue's ${facts.kindSource}.)` : "";

  // Step 3 is filled in when GitHub answers whether a contributing guide exists
  const contributingTarget = el("div", {}, [el("p", { className: "path-note" }, ["Checking for a contributing guide…"])]);
  fillContributing(contributingTarget, repo);

  const filesText = facts.files.length
    ? ["The issue mentions ", ...codeList(facts.files.slice(0, 3)), ". Open ", facts.files.length === 1 ? "it" : "them", " and read how ", facts.files.length === 1 ? "it works" : "they work", " before you change anything."]
    : [KIND_LOOK[facts.kind]];

  const changeParts = [el("p", {}, [KIND_CHANGE[facts.kind](facts)])];
  if (facts.tasks.length) {
    changeParts.push(
      el("p", {}, [`The issue lists ${plural(facts.tasks.length, "unfinished task")}. You can offer to do just one of them:`]),
      el("ul", { className: "task-list" }, facts.tasks.map((task) => el("li", {}, [task])))
    );
  }

  const checksExtra = facts.kind === "bug" ? " Then repeat the steps from the issue to confirm the bug is gone."
    : facts.kind === "docs" ? " For documentation, preview your Markdown to check headings, links and lists." : "";

  const steps = [
    ["Read the issue and its discussion", [
      el("p", {}, [comments === null
        ? "Read the full description and any comments on GitHub."
        : comments > 0
          ? `Read the full description and all ${plural(comments, "comment")}. Comments often add hints, or show that someone is already working on it.`
          : "Read the full description. There are no comments yet, so you could be the first to ask a question."]),
      el("p", {}, [externalLink(issue.html_url, `Open issue #${issue.number}`, { className: "text-link" })])
    ]],
    ["Make sure you understand the change", [
      el("p", {}, [KIND_TEXT[facts.kind] + guessedFrom]),
      el("p", {}, [KIND_UNDERSTAND[facts.kind]]),
      el("p", {}, [assignees.length
        ? `It is assigned to @${(assignees[0] && assignees[0].login) || "someone"}, so ask in a comment whether you can help before you start.`
        : "If anything is unclear, ask in a comment, and say you would like to work on it. Some projects want a maintainer to assign the issue to you first."])
    ]],
    ["Follow the project's contribution rules", [contributingTarget]],
    ["Look at the relevant files first", [
      el("p", {}, filesText),
      el("p", { className: "path-note" }, ["FirstPR hasn't read this repository's code, so treat this as a starting point, not a finding."])
    ]],
    ["Make one small, focused change", changeParts],
    ["Run the project's checks", [
      el("p", {}, [`If the project has tests, a linter or a build step, run them before you commit. The contributing guide or README usually lists the commands.${checksExtra}`]),
      el("p", { className: "path-note" }, ["FirstPR hasn't checked which commands this project uses."])
    ]],
    ["Commit, push and open your pull request", [
      el("p", {}, [`Use the checklist below. In your pull request description, write “Fixes #${issue.number}” so GitHub links it to this issue. Maintainers may ask for changes. That is a normal part of contributing.`])
    ]]
  ];

  return [el("ol", { className: "path", role: "list" }, steps.map(([title, body], index) => el("li", { className: "path-step" }, [
    el("span", { className: "path-node", "aria-hidden": "true" }, [String(index + 1)]),
    el("div", { className: "path-content" }, [el("h4", { className: "path-title" }, [title]), ...body])
  ])))];
}

function checklistSection(issue, facts, repo, branch) {
  const storageKey = `${STORAGE_PREFIX}checks:${repo.fullName.toLowerCase()}#${issue.number}`;
  const saved = readStorage(storageKey);
  const checked = Array.isArray(saved) ? saved : [];

  const progressText = el("p", { className: "progress-text" });
  const progressFill = el("span");
  const contributingTarget = el("div", {});
  fillContributing(contributingTarget, repo);

  const repoUrl = `https://github.com/${repo.fullName}`;
  const items = [
    ["Read the contributing guide", [contributingTarget]],
    ["Fork the repository", [el("p", {}, [
      "Open the ", externalLink(repoUrl, "repository page", { className: "inline-link" }), " and click Fork. This makes your own copy of the project in your GitHub account."
    ])]],
    ["Clone your fork", [
      commandBlock(["git clone https://github.com/", { username: true }, `/${repo.repo}.git`, "\n", `cd ${repo.repo}`], "clone command"),
      el("p", {}, ["This downloads your fork and moves into its folder."])
    ]],
    ["Create a branch for this issue", [
      commandBlock([`git checkout -b ${branch}`], "branch command"),
      el("p", {}, ["A branch keeps this change separate from everything else."])
    ]],
    ["Make your change and run the checks", [el("p", {}, [
      "Follow the contributing guide or README to run the project and its tests, and check that your change works."
    ])]],
    ["Stage only the files you changed", [
      commandBlock(["git status"], "status command"),
      el("p", {}, ["This lists the files you changed. Add each file that belongs to this issue by its path:"]),
      commandBlock(["git add ", { placeholder: "PATH/TO/CHANGED-FILE" }], "add command"),
      el("p", {}, facts.files.length
        ? ["Replace the highlighted part with a path from “git status”. If you changed ", el("code", {}, [facts.files[0]]), ", that would be its path. Avoid “git add .”, which can include files you didn't mean to change."]
        : ["Replace the highlighted part with a path from “git status”. Avoid “git add .”, which can include files you didn't mean to change."])
    ]],
    ["Commit your change", [
      commandBlock(['git commit -m "', { placeholder: "Short description of your change" }, ` (#${issue.number})"`], "commit command"),
      el("p", {}, ["Replace the highlighted words with what you changed, in a few words."])
    ]],
    ["Push your branch", [commandBlock([`git push origin ${branch}`], "push command")]],
    ["Open your pull request", [el("p", {}, [
      "Go to the ", externalLink(repoUrl, "original repository", { className: "inline-link" }),
      ` and click “Compare & pull request”, which GitHub shows after you push. Write “Fixes #${issue.number}” in the description, then follow any pull request template the project uses.`
    ])]]
  ];

  const list = el("ul", { className: "checklist", role: "list" });
  const boxes = items.map(([title, details], index) => {
    const id = `check-${issue.number}-${index}`;
    const box = el("input", { type: "checkbox", id });
    box.checked = Boolean(checked[index]);
    list.append(el("li", { className: "check-item" }, [box, el("label", { for: id }, [title]), el("div", { className: "check-body" }, details)]));
    return box;
  });

  const updateProgress = () => {
    const done = boxes.filter((box) => box.checked).length;
    progressText.textContent = `${done} of ${boxes.length} done`;
    progressFill.style.width = `${Math.round((done / boxes.length) * 100)}%`;
  };
  boxes.forEach((box) => box.addEventListener("change", () => {
    updateProgress();
    writeStorage(storageKey, boxes.map((item) => item.checked)); // remembered in this browser only
  }));
  updateProgress();

  return el("section", { className: "guide-block" }, [
    el("div", { className: "checklist-head" }, [el("h3", { className: "guide-block-title" }, ["Pull request checklist"]), progressText]),
    el("div", { className: "progress-bar", "aria-hidden": "true" }, [progressFill]),
    usernameField(),
    list
  ]);
}

// "Your GitHub username" box. It fills the username into the commands so they are ready to copy.
function usernameField() {
  const saved = readStorage(`${STORAGE_PREFIX}username`);
  const field = el("input", {
    type: "text", id: "github-username", autocomplete: "username", autocapitalize: "off", spellcheck: "false",
    placeholder: "your-username", "aria-describedby": "username-help username-error"
  });
  field.value = typeof saved === "string" ? saved : "";
  const error = el("p", { className: "username-error", id: "username-error" });

  field.addEventListener("input", () => {
    const value = field.value.trim();
    const valid = value === "" || /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
    error.textContent = valid ? "" : "GitHub usernames use only letters, numbers and hyphens.";
    if (valid) field.removeAttribute("aria-invalid");
    else field.setAttribute("aria-invalid", "true");
    applyUsername(valid ? value : "");
    if (valid) writeStorage(`${STORAGE_PREFIX}username`, value);
  });
  queueMicrotask(() => applyUsername(field.value.trim()));

  return el("div", { className: "username" }, [
    el("label", { for: "github-username" }, ["Your GitHub username"]),
    field,
    el("p", { className: "username-help", id: "username-help" }, ["Optional. It fills in the commands below and is saved only in this browser."]),
    error
  ]);
}

// Puts the username into every command that needs it, or shows YOUR-USERNAME
function applyUsername(name) {
  guideContent.querySelectorAll(".token-username").forEach((token) => {
    token.textContent = name || "YOUR-USERNAME";
    token.classList.toggle("placeholder", !name);
  });
}

/*
  A terminal command with a Copy button.
  parts: plain strings, { placeholder: "TEXT" } for parts to replace, or { username: true }.
  Only safe text goes into commands: repository names and branch names are checked
  (letters, numbers, ".", "-", "_"), and usernames are checked before they are used.
*/
function commandBlock(parts, label) {
  const code = el("code");
  for (const part of parts) {
    if (typeof part === "string") code.append(part);
    else if (part.username) code.append(el("span", { className: "token-username placeholder" }, ["YOUR-USERNAME"]));
    else code.append(el("span", { className: "placeholder" }, [part.placeholder]));
  }
  const copy = el("button", { type: "button", className: "copy-button" }, [
    svgIcon("copy"), el("span", { className: "copy-label" }, ["Copy"]), el("span", { className: "visually-hidden" }, [` ${label}`])
  ]);
  copy.addEventListener("click", () => copyCommand(copy, code));
  return el("div", { className: "command" }, [
    el("div", { className: "command-bar" }, [el("span", { className: "command-label" }, ["Terminal"]), copy]),
    el("pre", {}, [code])
  ]);
}

async function copyCommand(copyButton, code) {
  const ok = await copyText(code.textContent, copyButton.parentElement);
  const label = copyButton.querySelector(".copy-label");
  if (ok) {
    label.textContent = "Copied";
    copyButton.classList.add("is-copied");
    copyButton.replaceChild(svgIcon("check"), copyButton.firstChild);
    guideAnnouncer.textContent = "Copied to clipboard.";
  } else {
    // Copying was blocked: select the text so the user can press Ctrl+C (or Cmd+C)
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    label.textContent = "Press Ctrl+C";
    guideAnnouncer.textContent = "Copying is blocked here. The command is selected: press Control C or Command C to copy it.";
  }
  clearTimeout(copyButton.resetTimer);
  copyButton.resetTimer = setTimeout(() => {
    label.textContent = "Copy";
    copyButton.classList.remove("is-copied");
    copyButton.replaceChild(svgIcon("copy"), copyButton.firstChild);
  }, 2000);
}

// Copies text to the clipboard. Returns true if it worked.
async function copyText(text, container) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the older method below
  }
  // Older method: put the text in a hidden box inside the guide panel, select it and copy
  const area = el("textarea", { readonly: "", "aria-hidden": "true", tabindex: "-1", style: "position:absolute;opacity:0;pointer-events:none" });
  area.value = text;
  container.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// Asks GitHub once per repository whether a CONTRIBUTING file exists (1 extra request)
function getContributing(repo) {
  const key = repo.fullName.toLowerCase();
  if (!state.contributing.has(key)) {
    const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/community/profile`;
    const answer = githubGet(path)
      .then((profile) => {
        const files = profile && profile.files;
        const url = files && files.contributing && files.contributing.html_url;
        if (url && isGitHubUrl(url)) return { status: "found", url };
        return { status: files ? "none" : "unknown" };
      })
      .catch(() => ({ status: "unknown" })); // for example forks, or the hourly limit
    state.contributing.set(key, answer);
  }
  return state.contributing.get(key);
}

function fillContributing(target, repo) {
  target.replaceChildren(el("p", { className: "path-note" }, ["Checking for a contributing guide…"]));
  const readme = `https://github.com/${repo.fullName}#readme`;
  getContributing(repo).then((info) => {
    if (info.status === "found") {
      target.replaceChildren(
        el("p", {}, ["This project has a contributing guide. It explains how the maintainers want changes made. Read it before you start."]),
        el("p", {}, [externalLink(info.url, "Open the contributing guide", { className: "text-link" })])
      );
    } else if (info.status === "none") {
      target.replaceChildren(
        el("p", {}, ["FirstPR found no CONTRIBUTING file in this repository. The README usually explains how to set up the project."]),
        el("p", {}, [externalLink(readme, "Open the README", { className: "text-link" })])
      );
    } else {
      target.replaceChildren(
        el("p", {}, ["FirstPR couldn't check for a contributing guide. Look for a CONTRIBUTING.md file in the repository, or read the README."]),
        el("p", {}, [externalLink(readme, "Open the README", { className: "text-link" })])
      );
    }
  });
}

/* =========================================================
   10. Reading issue text (simple rules, no AI)
   ========================================================= */

// Looks through the issue text and labels with simple rules
function readIssue(issue) {
  const body = issue.body || "";
  const title = issue.title || "";
  const labels = (issue.labels || []).map(labelName).map(normalizeLabel);

  // 1. Guess the kind of issue: labels first, then the description, then the title
  let kind = "general";
  let kindSource = "";
  const labelRules = [
    ["bug", /\b(bug|defect|regression|crash)\b/],
    ["docs", /\b(docs?|documentation)\b/],
    ["tests", /\b(tests?|testing)\b/],
    ["feature", /\b(feature|enhancement|feat|improvement)\b/]
  ];
  const titleRules = [
    ["bug", /\b(bug|error|crash(es)?|broken|fails?|failing|exception|not working|doesn'?t work)\b/i],
    ["docs", /\b(docs?|documentation|readme|typo|tutorial|guide)\b/i],
    ["tests", /\b(tests?|testing|coverage)\b/i],
    ["feature", /\b(feature|add|support|implement|allow|option)\b/i]
  ];
  const labelMatch = labelRules.find(([, rule]) => labels.some((label) => rule.test(label)));
  const titleMatch = titleRules.find(([, rule]) => rule.test(title));
  if (labelMatch) {
    [kind, kindSource] = [labelMatch[0], "labels"];
  } else if (/steps to reproduce|expected behaviou?r|actual behaviou?r/i.test(body)) {
    [kind, kindSource] = ["bug", "description"];
  } else if (/feature request|proposed solution|describe the solution/i.test(body)) {
    [kind, kindSource] = ["feature", "description"];
  } else if (titleMatch) {
    [kind, kindSource] = [titleMatch[0], "title"];
  }

  // 2. Details we can spot in the text
  return {
    kind,
    kindSource,
    hasBody: body.trim() !== "",
    summary: summaryText(body),
    files: findFiles(`${title}\n${body}`),
    tasks: findTasks(body),
    hasSteps: /steps to reproduce|to reproduce|reproduction steps/i.test(body),
    hasCode: /```|~~~/.test(body),
    hasScreenshots: /!\[[^\]]*\]\(|<img\b/i.test(body),
    isGoodFirst: hasLabel(issue, GOOD_FIRST),
    isHelpWanted: hasLabel(issue, HELP_WANTED)
  };
}

// The first real paragraph of the description, without template headings, code or links
function summaryText(body) {
  const text = (body || "")
    .replace(/<!--[\s\S]*?-->/g, "")          // hidden notes left by issue templates
    .replace(/(```|~~~)[\s\S]*?\1/g, "\n\n");  // code blocks
  for (const paragraph of text.split(/\n\s*\n/)) {
    const lines = paragraph.split("\n").filter((line) => !isHeading(line) && !/^\s*\|/.test(line));
    const clean = lines.map(cleanLine).join(" ").replace(/\s+/g, " ").trim();
    if (clean.length >= 25) return shorten(clean, 320); // skip tiny bits like "Yes" or "N/A"
  }
  return "";
}

// Short preview for the issue list
function previewText(body) {
  if (!body || !body.trim()) return "No description was written for this issue.";
  const summary = summaryText(body);
  return summary ? shorten(summary, 200) : "The description is mostly code, images or a form. Open it on GitHub to read it.";
}

function isHeading(line) {
  const t = line.trim();
  return /^#{1,6}\s/.test(t) || /^(\*\*|__)[^*_]+(\*\*|__):?$/.test(t) || /^[-*_=]{3,}$/.test(t);
}

// Removes Markdown and HTML symbols from one line, keeping the words
function cleanLine(line) {
  return line
    .replace(/<[^>]*>/g, " ")                                 // HTML tags
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")     // images
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")  // links: keep the link words
    .replace(/^\s*>+\s?/, "")                                 // quote marks
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "") // list bullets and checkboxes
    .replace(/`([^`]*)`/g, "$1")                              // inline code marks
    .replace(/\*\*|__|~~/g, "")                               // bold and strike-through marks
    .replace(/\s+/g, " ")
    .trim();
}

// Cuts long text at the end of a sentence (or a word) and adds "…"
function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentenceEnd > max * 0.6) return cut.slice(0, sentenceEnd + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "") + "…";
}

// File names like src/app.js or README.md mentioned in the text (not inside web links)
const FILE_PATTERN = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cpp|h|cs|php|html|css|scss|vue|svelte|json|ya?ml|toml|md|mdx|txt|sh))(?=$|[\s`'"),.:;!?\]])/gim;
const NOT_FILES = /^(node|vue|next|nuxt|react|express|three|chart|d3|p5|angular|ember|backbone|moment|deno)\.js$/i;

function findFiles(text) {
  const found = new Set();
  for (const match of text.matchAll(FILE_PATTERN)) {
    if (!NOT_FILES.test(match[1])) found.add(match[1]);
  }
  const files = [...found];
  // Drop "Button.jsx" when "src/Button.jsx" is also mentioned
  return files.filter((file) => !files.some((other) => other.endsWith("/" + file))).slice(0, 6);
}

// Unchecked task-list items: "- [ ] something"
function findTasks(body) {
  return [...body.matchAll(/^\s*[-*+]\s+\[ \]\s+(.+)$/gm)]
    .map((match) => cleanLine(match[1]))
    .filter(Boolean)
    .slice(0, 5);
}

/* =========================================================
   11. Labels and sorting
   ========================================================= */
function labelName(label) {
  return typeof label === "string" ? label : (label && label.name) || "";
}

// "Good-First-Issue" -> "good first issue", so different spellings match
function normalizeLabel(name) {
  return name.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function isBeginnerLabel(name) {
  const clean = normalizeLabel(name);
  return clean.includes(GOOD_FIRST) || clean.includes(HELP_WANTED);
}

function hasLabel(issue, wanted) {
  return (issue.labels || []).some((label) => normalizeLabel(labelName(label)).includes(wanted));
}

function isMarkedForBeginners(issue) {
  return (issue.labels || []).some((label) => isBeginnerLabel(labelName(label)));
}

// Order: "good first issue" first, then "help wanted", unassigned before assigned, newest first
function byPriority(a, b) {
  return priority(a) - priority(b) || dateValue(b.created_at) - dateValue(a.created_at);
}

function priority(issue) {
  let score = 0;
  if (!hasLabel(issue, GOOD_FIRST)) score += 1;
  if (!isMarkedForBeginners(issue)) score += 1;
  if (Array.isArray(issue.assignees) && issue.assignees.length) score += 3;
  return score;
}

/* =========================================================
   12. Small helpers
   ========================================================= */

// Creates an element safely. Strings in "children" become plain text, never HTML.
function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "className") node.className = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function button(text, iconName, onClick, className) {
  const node = el("button", { type: "button", className }, iconName ? [svgIcon(iconName), text] : [text]);
  node.addEventListener("click", onClick);
  return node;
}

/*
  A link that opens GitHub in a new tab. Only https://github.com links get an href,
  so a strange link from the API can never run code. "context" is extra text for
  screen readers, for example ": issue #12".
*/
function externalLink(url, text, { className = "text-link", context = "" } = {}) {
  const a = el("a", { target: "_blank", rel: "noopener noreferrer" }, [
    text,
    el("span", { className: "visually-hidden" }, [`${context} (opens in a new tab)`]),
    svgIcon("external")
  ]);
  if (className) a.className = className;
  if (isGitHubUrl(url)) a.href = url;
  return a;
}

function isGitHubUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

// Line icons used by the interface (drawn here, so no image files or icon services are needed)
const ICON_PATHS = {
  clock: ["M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z", "M8 5v3.2l2.1 1.3"],
  comment: ["M3 3.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7.5l-3 2.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"],
  person: ["M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z", "M3 13.5c.6-2.3 2.6-3.6 5-3.6s4.4 1.3 5 3.6"],
  external: ["M9.5 2.5h4v4", "M13.5 2.5l-6 6", "M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"],
  copy: ["M5.5 5.5v-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2", "M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"],
  check: ["M3.5 8.5l3 3 6-7"],
  alert: ["M8 2.8l6 10.4H2L8 2.8Z", "M8 6.8v2.6", "M8 11.3v.01"],
  info: ["M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z", "M8 7.5V11", "M8 5.2v.01"],
  retry: ["M13.2 8a5.2 5.2 0 1 1-1.6-3.7", "M13 2.8v2.8h-2.8"],
  search: ["M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z", "M10.5 10.5l3 3"],
  lock: ["M4.5 7.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z", "M5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2"],
  list: ["M6 4.5h7", "M6 8h7", "M6 11.5h7", "M3 4.5h.01", "M3 8h.01", "M3 11.5h.01"],
  code: ["M5.5 4.5L2 8l3.5 3.5", "M10.5 4.5L14 8l-3.5 3.5"],
  image: ["M3 3.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z", "M2.5 11l3.2-3.2 2.8 2.8 2-2 3 3", "M10.5 6.2v.01"],
  file: ["M4 2.5h5l3 3v8H4v-11Z", "M9 2.5v3h3"],
  dot: ["M8 6.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z"]
};

function svgIcon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// ["a.js", "b.js"] -> <code>a.js</code> and <code>b.js</code>
function codeList(items) {
  const nodes = [];
  items.forEach((item, index) => {
    if (index > 0) nodes.push(index === items.length - 1 ? " and " : ", ");
    nodes.push(el("code", {}, [item]));
  });
  return nodes;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function dateValue(text) {
  const time = new Date(text).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// "2024-05-01T10:00:00Z" -> "3 months ago" (or "" if the date is missing)
function timeAgo(dateText) {
  const time = new Date(dateText).getTime();
  if (!dateText || Number.isNaN(time)) return "";
  const seconds = (time - Date.now()) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}

function formatDate(dateText) {
  const date = new Date(dateText);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

function formatTime(epochSeconds) {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// "Fix: Button breaks on mobile!" -> "fix-button-breaks-on-mobile" (at most 30 letters, whole words only)
function slug(text) {
  const full = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length <= 30) return full;
  const cut = full.slice(0, 31);
  return cut.slice(0, cut.lastIndexOf("-")) || full.slice(0, 30);
}

function timeoutSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

function navHeight() {
  return document.querySelector(".site-header").getBoundingClientRect().height;
}

// Small helpers for things saved in this browser (they never break the page if storage is blocked)
function readStorage(key) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage is full or blocked; the feature still works for this visit
  }
}
