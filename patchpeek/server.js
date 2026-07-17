import express from "express";
import path from "path";
import fs from "fs/promises";
import pLimit from "p-limit";
import MarkdownIt from "markdown-it";
import { full as emoji } from "markdown-it-emoji";
import markdownItGitHubAlerts from "markdown-it-github-alerts";

const app = express();
const port = 3000;
const configPath = path.resolve("./data/config.json");
const limit = pLimit(5);

app.set("view engine", "ejs");
app.set("views", path.resolve("./patchpeek/views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./patchpeek/public")));

let config = { repos: [], daysWindow: 31, githubToken: "" };

const markdownRenderer = new MarkdownIt({
  html: true,
  linkify: true,
});
markdownRenderer.use(emoji);
markdownRenderer.use(markdownItGitHubAlerts);

let cachedDataMap = new Map();
let lastUpdateTime = null;
let rateLimited = false;
let refreshing = false;
let lastRateRemaining = null;
let lastRateLimit = null;

const keywords = [
  "breaking change",
  "breaking changes",
  "caution",
  "important",
];

async function loadConfig() {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    } else {
      console.error(`Unable to load config: ${err.message}`);
      // Keep defaults when config is invalid, but do not overwrite the file.
    }
  }
}

function cutoffDate(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}

function shortenGithubReferences(markdown, repo) {
  const withUrls = markdown.replace(
    /(https?:\/\/github\.com\/([^\s)]+)\/(issues|pull)\/(\d+))/gi,
    (_match, url, _repoSlug, _type, number) => `[${`#${number}`}](${url})`,
  );

  return withUrls.replace(
    /(^|[^a-zA-Z0-9_\[\]])(#[0-9]+)(?![a-zA-Z0-9_])/g,
    (match, prefix, reference) => {
      const number = reference.slice(1);
      const target = repo
        ? `https://github.com/${repo}/pull/${number}`
        : `https://github.com/pull/${number}`;
      return `${prefix}[${reference}](${target})`;
    },
  );
}

async function fetchReleasePage(repo, page) {
  const baseDelay = 5000;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/releases?per_page=30&page=${page}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            ...(config.githubToken && {
              Authorization: `token ${config.githubToken}`,
            }),
          },
        },
      );

      const rateRemaining = res.headers.get("x-ratelimit-remaining");
      const rateLimit = res.headers.get("x-ratelimit-limit");

      if (rateRemaining !== null) lastRateRemaining = rateRemaining;
      if (rateLimit !== null) lastRateLimit = rateLimit;

      if (res.status === 403 && rateRemaining === "0") {
        rateLimited = true;
        return [];
      }

      if (res.status === 404) {
        const err = new Error("Repository not found or private");
        err.nonRetryable = true;
        throw err;
      }

      if ([502, 503, 504].includes(res.status))
        throw new Error(`Temporary upstream error ${res.status}`);

      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

      return await res.json();
    } catch (err) {
      if (err.nonRetryable || attempt === 3) throw err;

      const delay = baseDelay * 2 ** (attempt - 1);
      console.log(
        `Attempt ${attempt} failed for ${repo}: ${err.message}, retrying in ${delay / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function fetchReleases(repo, daysWindow = config.daysWindow) {
  const allReleases = [];
  const cutoff = cutoffDate(daysWindow);

  for (let page = 1; ; page++) {
    const releases = await fetchReleasePage(repo, page);

    if (!releases.length) break;

    for (const release of releases) {
      if (release.draft || release.prerelease) continue;

      if (new Date(release.published_at) < cutoff) return allReleases;

      const bodyMarkdown = shortenGithubReferences(release.body || "", repo);
      const bodyHtml = markdownRenderer.render(bodyMarkdown);
      const body = bodyMarkdown.toLowerCase();

      allReleases.push({
        ...release,
        body_html: bodyHtml,
        flagged: keywords.some((kw) => body.includes(kw)),
      });
    }
  }

  return allReleases;
}

async function refreshReleases(repos = config.repos) {
  console.log(`Refreshing ${repos.length} repositories`);
  rateLimited = false;
  const errors = [];
  let successfulCount = 0;

  await Promise.all(
    repos.map((repo) =>
      limit(async () => {
        try {
          const releases = await fetchReleases(repo);

          releases.sort((a, b) => {
            if (a.flagged && !b.flagged) return -1;
            if (!a.flagged && b.flagged) return 1;
            return new Date(b.published_at) - new Date(a.published_at);
          });

          if (releases.length) {
            cachedDataMap.set(repo, {
              repo,
              releases,
              releaseCount: releases.length,
              hasFlagged: releases.some((r) => r.flagged),
            });
          } else {
            cachedDataMap.delete(repo);
          }

          successfulCount += 1;
        } catch (err) {
          console.error(`Failed to refresh ${repo}: ${err.message}`);
          errors.push(`Failed to refresh ${repo}: ${err.message}`);
        }
      }),
    ),
  );

  lastUpdateTime = new Date().toLocaleString();

  console.log(
    `Refreshed ${successfulCount}/${repos.length} repos. Remaining tokens: ${lastRateRemaining ?? "unknown"}/${lastRateLimit ?? "unknown"}`,
  );

  return errors;
}

function compareRepoSlugs(a, b) {
  //sort by repo name in sidebar
  const getRepoSortKey = (repoSlug) => {
    const [, repoName = ""] = repoSlug.split("/");
    return (repoName || repoSlug).toLowerCase();
  };

  const repoCompare = getRepoSortKey(a).localeCompare(getRepoSortKey(b));
  if (repoCompare !== 0) return repoCompare;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function renderIndex(res, errors = null) {
  const allReleases = [...cachedDataMap.values()].sort((a, b) => {
    if (b.releaseCount !== a.releaseCount)
      return b.releaseCount - a.releaseCount;
    return a.repo.localeCompare(b.repo);
  });

  return res.render("index", {
    allReleases,
    daysWindow: config.daysWindow,
    repoList: [...config.repos].sort(compareRepoSlugs),
    errorMessage: Array.isArray(errors) ? errors : errors ? [errors] : null,
    rateLimited,
    lastUpdateTime,
  });
}

function normalizeRepoSlug(input) {
  const match = input
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/?#]+)/);
  return match ? `${match[1]}/${match[2]}` : input.trim();
}

app.get("/", (req, res) => {
  return renderIndex(res);
});

app.post("/refresh", async (req, res) => {
  if (refreshing) {
    return res.redirect("/");
  }

  refreshing = true;

  try {
    await refreshReleases();
    res.redirect("/");
  } finally {
    refreshing = false;
  }
});

app.get("/debug", (req, res) => res.json([...cachedDataMap.values()]));

app.post("/add-repo", async (req, res) => {
  const repo = normalizeRepoSlug(req.body.repoSlug.toLowerCase());

  if (!repo) return renderIndex(res, ["Invalid repository slug"]);
  if (config.repos.includes(repo)) {
    return renderIndex(res, ["Repository already added"]);
  }

  try {
    config.repos.push(repo);

    try {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    } catch (err) {
      config.repos = config.repos.filter((r) => r !== repo);
      throw err;
    }

    const refreshErrors = await refreshReleases([repo]);

    if (refreshErrors.length) {
      config.repos = config.repos.filter((r) => r !== repo);
      cachedDataMap.delete(repo);

      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
      return renderIndex(res, refreshErrors);
    }

    res.redirect("/");
  } catch (err) {
    return renderIndex(res, [`Failed to fetch: ${err.message}`]);
  }
});

app.post("/remove-repo", async (req, res) => {
  const repo = req.body.repoSlug.trim();
  config.repos = config.repos.filter((r) => r !== repo);
  cachedDataMap.delete(repo);

  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  res.redirect("/");
});

app.post("/update-days", async (req, res) => {
  const days = parseInt(req.body.daysWindow, 10);
  if (!Number.isInteger(days) || days <= 0) {
    return renderIndex(res, ["Invalid days value. Enter a positive integer."]);
  }

  config.daysWindow = days;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  await refreshReleases();
  res.redirect("/");
});

app.post("/update-token", async (req, res) => {
  const token = req.body.githubToken?.trim();
  if (token && !/^github_pat_|^ghp_/.test(token)) {
    return renderIndex(res, [
      "Invalid GitHub token format. It should start with 'github_pat_' or 'ghp_'",
    ]);
  }

  config.githubToken = token;

  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  await refreshReleases();

  res.redirect("/");
});

(async () => {
  try {
    await loadConfig();
    await refreshReleases();
    setInterval(
      () => {
        void refreshReleases().catch(console.error);
      },
      60 * 60 * 1000,
    );
    app.listen(port, () => console.log(`Server running on :${port}\n`));
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();
