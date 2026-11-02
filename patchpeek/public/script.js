document.querySelectorAll("form").forEach((form) =>
  form.addEventListener("submit", () => {
    document.getElementById("loadingOverlay").style.display = "flex";
  }),
);

const timeEl = document.getElementById("lastUpdatedTime");
const dateFormatToggle = document.getElementById("dateFormatToggle");

function renderLastUpdated() {
  const use12h = localStorage.getItem("timeFormat") === "12";
  const useDayFirst = localStorage.getItem("dateFormat") !== "MDY";
  const locale = useDayFirst ? "en-GB" : "en-US";
  timeEl.textContent = timeEl.dataset.timestamp
    ? new Date(timeEl.dataset.timestamp).toLocaleString(locale, {
        hour12: use12h,
      })
    : "never";
  document.getElementById("timeFormatToggle").textContent = use12h
    ? "12h"
    : "24h";
  dateFormatToggle.textContent = useDayFirst ? "D/M/YYYY" : "M/D/YYYY";

  document.querySelectorAll(".releaseDate").forEach((date) => {
    date.textContent = new Date(date.dateTime).toLocaleDateString(locale);
  });
}

document.getElementById("timeFormatToggle").addEventListener("click", () => {
  const use12h = localStorage.getItem("timeFormat") === "12";
  localStorage.setItem(
    "timeFormat",
    use12h ? "24" : "12",
  );
  renderLastUpdated();
});

dateFormatToggle.addEventListener("click", () => {
  localStorage.setItem(
    "dateFormat",
    localStorage.getItem("dateFormat") !== "MDY" ? "MDY" : "DMY",
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

  if (query.length < 3) return;

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

repoInput.form.addEventListener("reset", () => {
  clearTimeout(searchTimer);
  searchController?.abort();
  repoSearchResults.innerHTML = "";
  repoSearchStatus.textContent = "";
});

repoSearchResults.addEventListener("click", (event) => {
  const result = event.target.closest(".repoSearchResult");
  if (!result) return;

  repoInput.value = result.dataset.repo;
  repoInput.form.submit();
});
