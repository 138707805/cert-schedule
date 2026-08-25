const API_BASE = "https://cert-schedule-api.orbital-watch-push.workers.dev";
const FAV_KEY = "cert-schedule-favorites";

let allItems = [];
let updatedAt = null;
let sourceMeta = null;
let activeQualgb = "ALL";
let activeLevel = null;
let activePhase = "ALL";
let activeTab = "all";
let showPast = false;
let searchTerm = "";

const listEl = document.getElementById("listContainer");
const updatedEl = document.getElementById("updatedAt");
const sourceUpdatedEl = document.getElementById("sourceUpdatedAt");
const sourcePanel = document.getElementById("sourcePanel");
const cardTpl = document.getElementById("cardTemplate");
const pastToggleBtn = document.getElementById("pastToggle");

function loadFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveFavorites(set) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...set]));
}
let favorites = loadFavorites();

async function loadSchedules() {
  try {
    const res = await fetch(`${API_BASE}/api/schedules`);
    const data = await res.json();
    allItems = data.items || [];
    updatedAt = data.updatedAt;
    sourceMeta = data.source || null;
    renderUpdatedAt();
    render();
  } catch (e) {
    updatedEl.textContent = "데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.";
  }
}

function renderUpdatedAt() {
  if (updatedAt) {
    const d = new Date(updatedAt);
    const label = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} 기준 업데이트`;
    updatedEl.textContent = label;
    if (sourceUpdatedEl) sourceUpdatedEl.textContent = `마지막 데이터 갱신: ${label}`;
  } else {
    updatedEl.textContent = "데이터가 아직 없습니다.";
  }
}

// 필기/실기 날짜 중 오늘 이후 가장 가까운 일정 하나를 뽑는다.
// phaseFilter가 "필기"/"실기"면 그 단계의 날짜만 후보로 삼는다.
function getNextEvent(item, phaseFilter) {
  const today = new Date().toISOString().slice(0, 10);

  if (item.kind === "single") {
    if (!item.dateStart) return null;
    const isPast = item.dateEnd ? item.dateEnd < today : item.dateStart < today;
    return { label: item.name, date: item.dateStart, isPast };
  }

  let candidates = [
    ["필기 원서접수 시작", item.written.applyStart],
    ["필기 원서접수 마감", item.written.applyEnd],
    ["필기시험", item.written.examStart],
    ["필기 합격발표", item.written.result],
    ["실기 원서접수 시작", item.practical.applyStart],
    ["실기 원서접수 마감", item.practical.applyEnd],
    ["실기시험", item.practical.examStart],
    ["실기 합격발표", item.practical.result],
  ].filter(([, d]) => d);

  if (phaseFilter === "필기" || phaseFilter === "실기") {
    candidates = candidates.filter(([label]) => label.startsWith(phaseFilter));
  }

  const upcoming = candidates.filter(([, d]) => d >= today).sort((a, b) => a[1].localeCompare(b[1]));
  if (upcoming.length) return { label: upcoming[0][0], date: upcoming[0][1], isPast: false };

  const past = candidates.sort((a, b) => b[1].localeCompare(a[1]));
  if (past.length) return { label: past[0][0], date: past[0][1], isPast: true };

  return null;
}

function dday(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return "D-DAY";
  return diff > 0 ? `D-${diff}` : `D+${-diff}`;
}

function fmtDate(d) {
  return d || "-";
}

function getFilteredItems() {
  let items = allItems;

  if (activeTab === "fav") {
    items = items.filter((it) => favorites.has(it.id));
  }
  if (activeQualgb !== "ALL") {
    items = items.filter((it) => it.qualgbCd === activeQualgb && (!activeLevel || it.level === activeLevel));
  }
  if (searchTerm.trim()) {
    const q = searchTerm.trim().toLowerCase();
    items = items.filter((it) => it.name.toLowerCase().includes(q));
  }

  if (activePhase !== "ALL") {
    items = items.filter((it) => it.kind !== "single"); // 개별 이벤트 카드는 필기/실기 구분이 없어 제외
  }

  const withNext = items.map((it) => ({ item: it, next: getNextEvent(it, activePhase) }));

  const upcoming = withNext.filter((x) => x.next && !x.next.isPast);
  const past = withNext.filter((x) => !x.next || x.next.isPast);

  upcoming.sort((a, b) => a.next.date.localeCompare(b.next.date));

  return showPast ? [...upcoming, ...past] : upcoming;
}

function render() {
  const items = getFilteredItems();
  listEl.innerHTML = "";

  if (items.length === 0) {
    const msg = document.createElement("p");
    msg.className = "empty-msg";
    msg.textContent =
      activeTab === "fav" ? "즐겨찾기한 자격증이 없습니다. 목록에서 ☆ 버튼을 눌러 추가해보세요." : "표시할 일정이 없습니다.";
    listEl.appendChild(msg);
    return;
  }

  for (const { item, next } of items) {
    const node = cardTpl.content.cloneNode(true);
    node.querySelector(".badge").textContent = item.qualgbNm;
    node.querySelector(".cert-name").textContent = item.name;

    const star = node.querySelector(".star");
    const isFav = favorites.has(item.id);
    star.textContent = isFav ? "★" : "☆";
    star.classList.toggle("is-fav", isFav);
    star.addEventListener("click", () => toggleFavorite(item.id));

    const isSingle = item.kind === "single";
    const phaseGrid = node.querySelector(".phase-grid");
    const singleDateEl = node.querySelector(".single-date");
    const nextInfo = node.querySelector(".next-info");

    if (isSingle) {
      phaseGrid.classList.add("hidden");
      nextInfo.classList.add("hidden");
      const range = item.dateEnd && item.dateEnd !== item.dateStart ? `${item.dateStart} ~ ${item.dateEnd}` : item.dateStart;
      singleDateEl.textContent = `${range} (${dday(item.dateStart)})`;
      singleDateEl.classList.remove("hidden");
    } else {
      singleDateEl.classList.add("hidden");
      nextInfo.classList.remove("hidden");
      nextInfo.textContent = next ? `${next.isPast ? "지난 일정 · " : ""}${next.label} · ${next.date} (${dday(next.date)})` : "예정된 일정 정보 없음";

      node.querySelector(".w-apply").textContent = `${fmtDate(item.written.applyStart)} ~ ${fmtDate(item.written.applyEnd)}`;
      node.querySelector(".w-exam").textContent = `${fmtDate(item.written.examStart)}${item.written.examEnd && item.written.examEnd !== item.written.examStart ? " ~ " + item.written.examEnd : ""}`;
      node.querySelector(".w-result").textContent = fmtDate(item.written.result);

      node.querySelector(".p-apply").textContent = `${fmtDate(item.practical.applyStart)} ~ ${fmtDate(item.practical.applyEnd)}`;
      node.querySelector(".p-exam").textContent = `${fmtDate(item.practical.examStart)}${item.practical.examEnd && item.practical.examEnd !== item.practical.examStart ? " ~ " + item.practical.examEnd : ""}`;
      node.querySelector(".p-result").textContent = fmtDate(item.practical.result);

      if (activePhase === "필기") node.querySelector(".phase-practical").classList.add("hidden");
      if (activePhase === "실기") node.querySelector(".phase-written").classList.add("hidden");
    }

    const sourceLink = node.querySelector(".source-link");
    if (item.sourceUrl) {
      sourceLink.href = item.sourceUrl;
      sourceLink.classList.remove("hidden");
    }

    listEl.appendChild(node);
  }
}

function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  saveFavorites(favorites);
  render();
}

document.getElementById("chipRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  document.querySelectorAll("#chipRow .chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  activeQualgb = btn.dataset.qualgb;
  activeLevel = btn.dataset.level || null;
  render();
});

document.getElementById("phaseRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  document.querySelectorAll("#phaseRow .chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  activePhase = btn.dataset.phase;
  render();
});

document.getElementById("searchInput").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  render();
});

pastToggleBtn.addEventListener("click", () => {
  showPast = !showPast;
  pastToggleBtn.textContent = showPast ? "지난 일정 숨기기" : "지난 일정 보기";
  render();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    activeTab = tab.dataset.tab;

    const isSource = activeTab === "source";
    sourcePanel.classList.toggle("hidden", !isSource);
    listEl.classList.toggle("hidden", isSource);
    document.querySelector(".searchbar").classList.toggle("hidden", isSource);
    document.querySelectorAll(".chips").forEach((el) => el.classList.toggle("hidden", isSource));
    document.querySelector(".pastToggleWrap").classList.toggle("hidden", isSource);

    if (!isSource) render();
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

loadSchedules();
