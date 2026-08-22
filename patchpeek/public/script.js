document.querySelectorAll("form").forEach((form) =>
  form.addEventListener("submit", () => {
    document.getElementById("loadingOverlay").style.display = "flex";
  }),
);

const timeEl = document.getElementById("lastUpdatedTime");

function renderLastUpdated() {
  const use12h = localStorage.getItem("timeFormat") !== "24";
  timeEl.textContent = timeEl.dataset.timestamp
    ? new Date(timeEl.dataset.timestamp).toLocaleString(undefined, {
        hour12: use12h,
      })
    : "never";
  document.getElementById("timeFormatToggle").textContent = use12h
    ? "12h"
    : "24h";
}

document.getElementById("timeFormatToggle").addEventListener("click", () => {
  localStorage.setItem(
    "timeFormat",
    localStorage.getItem("timeFormat") !== "24" ? "24" : "12",
  );
  renderLastUpdated();
});

renderLastUpdated();

const repoInput = document.getElementById("repoSlug");
const repoSearchResults = document.getElementById("repoSearchResults");
const repoSearchStatus = document.getElementById("repoSearchStatus");

let searchTimer;
let searchController;

repoInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchController?.abort();

  const query = repoInput.value.trim();

  repoSearchResults.innerHTML = "";
  repoSearchStatus.textContent = "";

  if (query.length < 3) return res.send("");

  repoSearchStatus.textContent = "Searching GitHub...";

  searchTimer = setTimeout(async () => {
    searchController = new AbortController();

    try {
      const response = await fetch(
        `/api/repos/search?q=${encodeURIComponent(query)}`,
        { signal: searchController.signal },
      );

      if (!response.ok) {
        throw new Error((await response.json()).error);
      }

      const results = await response.text();

      // Ignore results for an old query
      if (repoInput.value.trim() !== query) return;

      repoSearchResults.innerHTML = results;
      repoSearchStatus.textContent = results ? "" : "No repositories found.";
    } catch (error) {
      if (error.name !== "AbortError") {
        repoSearchStatus.textContent = error.message;
      }
    }
  }, 300);
});

repoSearchResults.addEventListener("click", (event) => {
  const result = event.target.closest(".repoSearchResult");
  if (!result) return;

  repoInput.value = result.dataset.repo;
  repoInput.form.submit();
});
