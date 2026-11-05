let ME = null;
let AWARDS = [];
let SELECTED_AWARD = null;
let CLASSIFICATIONS = [];
let SELECTED_CLASSIFICATION = null;
let RATE_CATEGORIES = [];
let RATE_INFO = { hasCasualTable: false, usedFallbackLoading: false };
let LAST_BREAKDOWN = null;
let SETTINGS = { oncostFloorPct: 22.7, defaultMarginPct: 15 };
let ALLOWANCES = { common: [], other: [] };

const $ = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toFixed(2)}`;
const isOvertimeClause = (clauseDescription) => /overtime/i.test(clauseDescription || "");
const isHourlyAllowance = (paymentFrequency) => /hour/i.test(paymentFrequency || "");
const otBadge = (isOvertime) => (isOvertime ? '<span class="pill" style="color:var(--amber);border-color:var(--amber);margin-left:6px">OT</span>' : "");

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts && opts.headers) },
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("Not authenticated");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Request failed");
  return body;
}

async function init() {
  try {
    ME = await api("/api/staff/me");
  } catch {
    return;
  }
  $("whoami").textContent = `${ME.name} (${ME.role})`;
  if (ME.mustChange) showPasswordModal(true);
  if (ME.role === "admin" || ME.role === "owner") {
    $("adminCard").hidden = false;
    if (ME.role === "owner") {
      $("newRole").innerHTML = `<option value="staff">Staff</option><option value="admin">Admin</option>`;
    }
    loadAccounts();
  }
  if (ME.role === "owner") {
    $("settingsCard").hidden = false;
  }

  SETTINGS = await api("/api/staff/settings");
  $("oncostPct").value = SETTINGS.oncostFloorPct;
  $("oncostPct").min = SETTINGS.oncostFloorPct;
  $("marginPct").value = SETTINGS.defaultMarginPct;
  $("settingOncostFloor").value = SETTINGS.oncostFloorPct;
  $("settingDefaultMargin").value = SETTINGS.defaultMarginPct;

  AWARDS = await api("/api/staff/awards");
  loadHistory();

  wireEvents();
}

// forced = first-login change: no current-password field and no way to dismiss it.
function showPasswordModal(forced) {
  $("curPwField").hidden = forced;
  $("pwCancel").hidden = forced;
  $("pwErr").innerHTML = "";
  $("pwModalWrap").hidden = false;
}

function wireEvents() {
  $("logoutBtn").addEventListener("click", async () => {
    await api("/api/staff/logout", { method: "POST" });
    location.href = "/login.html";
  });

  $("changePwBtn").addEventListener("click", () => showPasswordModal(false));
  $("pwCancel").addEventListener("click", () => ($("pwModalWrap").hidden = true));
  $("pwSubmit").addEventListener("click", async () => {
    const password = $("newPw").value;
    try {
      await api("/api/staff/password", { method: "POST", body: JSON.stringify({ password, currentPassword: $("curPw").value }) });
      $("pwModalWrap").hidden = true;
      $("curPw").value = "";
      $("newPw").value = "";
      $("pwErr").innerHTML = "";
      ME.mustChange = false;
    } catch (e) {
      $("pwErr").innerHTML = `<div class="notice error">${e.message}</div>`;
    }
  });

  $("awardSearch").addEventListener("input", onAwardSearch);
  $("awardSearch").addEventListener("focus", onAwardSearch);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".autocomplete")) $("awardList").hidden = true;
  });

  $("rateTypeSelect").addEventListener("change", onRateTypeChange);
  $("classificationSelect").addEventListener("change", onClassificationChange);
  $("isCasual").addEventListener("change", loadRateCategories);
  $("casualLoadingPct").addEventListener("change", () => {
    if (RATE_INFO.usedFallbackLoading) loadRateCategories();
  });

  $("calcBtn").addEventListener("click", calculate);
  $("saveBtn").addEventListener("click", saveQuote);

  $("addAccountBtn").addEventListener("click", addAccount);
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  wireShiftEvents();
}

async function saveSettings() {
  try {
    SETTINGS = await api("/api/staff/settings", {
      method: "POST",
      body: JSON.stringify({
        oncostFloorPct: parseFloat($("settingOncostFloor").value),
        defaultMarginPct: parseFloat($("settingDefaultMargin").value),
      }),
    });
    $("oncostPct").min = SETTINGS.oncostFloorPct;
    $("settingsResult").innerHTML = `<div class="notice">Saved. New quotes will use these as the default.</div>`;
  } catch (e) {
    $("settingsResult").innerHTML = `<div class="notice error">${e.message}</div>`;
  }
}

// --- award search ---

function onAwardSearch() {
  const q = $("awardSearch").value.trim().toLowerCase();
  const list = $("awardList");
  if (!q) {
    list.hidden = true;
    return;
  }
  const matches = AWARDS.filter(
    (a) => a.award_code && ((a.name || "").toLowerCase().includes(q) || a.award_code.toLowerCase().includes(q))
  ).slice(0, 30);
  if (!matches.length) {
    list.hidden = true;
    return;
  }
  list.innerHTML = matches
    .map((a) => `<div data-code="${a.award_code}">${a.name} <span class="muted small">(${a.award_code})</span></div>`)
    .join("");
  list.hidden = false;
  list.querySelectorAll("div").forEach((el) => {
    el.addEventListener("click", () => selectAward(el.dataset.code));
  });
}

async function selectAward(code) {
  SELECTED_AWARD = AWARDS.find((a) => a.award_code === code);
  $("awardSearch").value = SELECTED_AWARD.name;
  $("awardList").hidden = true;
  renderAwardInfo();

  CLASSIFICATIONS = await api(`/api/staff/awards/${code}/classifications`);
  ALLOWANCES = await api(`/api/staff/awards/${code}/allowances`);
  const RATE_TYPE_ORDER = ["AD", "JN", "CA", "TN", "AP", "AA"];
  const rateTypes = [...new Map(CLASSIFICATIONS.map((c) => [c.employee_rate_type_code, c.employee_rate_type_label])).entries()]
    .sort((a, b) => {
      const ai = RATE_TYPE_ORDER.indexOf(a[0]);
      const bi = RATE_TYPE_ORDER.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  $("rateTypeSelect").innerHTML = rateTypes.map(([code, label]) => `<option value="${code}">${label}</option>`).join("");
  onRateTypeChange();
  $("classificationSection").hidden = false;
  $("breakdown").innerHTML = "";
  $("saveBtn").disabled = true;
}

function renderAwardInfo() {
  const a = SELECTED_AWARD;
  const conf = a.casual_loading_confidence || "not_found";
  const pctText = a.casual_loading_pct != null ? `${a.casual_loading_pct}%` : "no single flat %";
  let noteHtml = `<div class="notice ${conf === "confirmed" ? "" : "warn"}">
    <span class="pill ${conf}">${conf.replace("_", " ")}</span>
    Fallback casual loading (only used if this classification has no official casual pay table below): <strong>${pctText}</strong>
    (${a.casual_loading_clause || "clause not identified"}). ${a.casual_loading_note ? `${a.casual_loading_note}.` : ""}
    Sourced from the award's own casual employment clause — confirm against the award before finalising if this placement involves heavy overtime/weekend work.
  </div>`;
  $("awardInfo").innerHTML = noteHtml;
  $("casualLoadingPct").value = a.casual_loading_pct != null ? a.casual_loading_pct : "";
}

function onRateTypeChange() {
  const rateType = $("rateTypeSelect").value;
  const opts = CLASSIFICATIONS.filter((c) => c.employee_rate_type_code === rateType);
  $("classificationSelect").innerHTML = opts
    .map(
      (c) =>
        `<option value="${c.base_pay_rate_id}">${c.parent_classification_name ? c.parent_classification_name + " — " : ""}${c.classification}${c.calculated_rate ? ` ($${c.calculated_rate.toFixed(2)}/hr)` : ""}</option>`
    )
    .join("");
  onClassificationChange();
}

async function onClassificationChange() {
  const bpr = $("classificationSelect").value;
  SELECTED_CLASSIFICATION = CLASSIFICATIONS.find((c) => c.base_pay_rate_id === bpr);
  await loadRateCategories();
}

async function loadRateCategories() {
  const priorHours = collectRosterHoursByCategory();
  const bpr = SELECTED_CLASSIFICATION && SELECTED_CLASSIFICATION.base_pay_rate_id;
  // Rates depend on the classification and casual flag, so any shift result is stale.
  SHIFT_RESULT = null;
  $("shiftResult").innerHTML = "";
  updateModeUI();
  if (!bpr) {
    RATE_CATEGORIES = [];
    renderRoster();
    return;
  }
  const params = new URLSearchParams({
    casual: $("isCasual").checked ? "1" : "0",
    casualLoadingPct: $("casualLoadingPct").value || "0",
  });
  const res = await api(`/api/staff/rates/${bpr}/categories?${params}`);
  RATE_CATEGORIES = res.rows;
  RATE_INFO = { hasCasualTable: res.hasCasualTable, usedFallbackLoading: res.usedFallbackLoading };
  renderRoster(priorHours);
  $("breakdown").innerHTML = "";
  $("saveBtn").disabled = true;
}

function collectRosterHoursByCategory() {
  const map = {};
  document.querySelectorAll(".roster-hours").forEach((input) => {
    const cat = RATE_CATEGORIES[Number(input.dataset.idx)];
    if (cat && input.value) map[cat.penalty_description] = input.value;
  });
  return map;
}

// Ordinary-hours roster categories with hours currently entered -- the only
// valid attachment targets for a per-hour add-on allowance (overtime hours
// already carry their own premium and don't stack with these).
function eligibleOrdinaryCategories() {
  const eligible = [];
  if (shiftModeActive()) {
    // Shift mode: the attachment targets are the (possibly adjusted) non-overtime lines of the shift result.
    if (SHIFT_RESULT) {
      for (const l of SHIFT_RESULT.lines) {
        if (l.isOvertime) continue;
        const inp = document.querySelector(`.shift-line-hours[data-label="${CSS.escape(l.label)}"]`);
        const hours = inp ? parseFloat(inp.value) : l.hours;
        if (hours > 0) eligible.push({ penaltyDescription: l.label, hours });
      }
    }
    return eligible;
  }
  document.querySelectorAll(".roster-hours").forEach((input) => {
    const hours = parseFloat(input.value);
    if (!(hours > 0)) return;
    const cat = RATE_CATEGORIES[Number(input.dataset.idx)];
    if (cat && !isOvertimeClause(cat.clause_description)) {
      eligible.push({ penaltyDescription: cat.penalty_description, hours });
    }
  });
  return eligible;
}

function renderRoster(priorHours) {
  priorHours = priorHours || {};
  const section = $("rosterSection");
  $("casualLoadingPct").disabled = !($("isCasual").checked && RATE_INFO.usedFallbackLoading);

let note = `<div class="notice warn">
    <strong>This tool does not work out ordinary vs overtime hours for you.</strong>
    Which hours count as "ordinary" depends on the specific rostering arrangement the award allows
    (e.g. a 4×9.5hr week vs 5×7.6hr week can have different daily/weekly caps) — it's not a fixed
    number, and it's not something we can safely guess from a start/end time alone. Work out the
    ordinary/overtime split from the award's own hours-of-work and overtime clauses (or ask before
    quoting if unsure), then enter the hours against the matching category below.<br>
    Working very early or very late does <em>not</em> automatically mean overtime in most awards —
    that's usually a separate penalty, shown under "Allowances" below if this award has one.
    ${SELECTED_AWARD.source_url ? `<a href="${SELECTED_AWARD.source_url}" target="_blank">Open the full award text ↗</a>` : ""}
  </div>`;
  if ($("isCasual").checked) {
    note += RATE_INFO.hasCasualTable
      ? `<div class="notice">Using this award's own official casual pay table — rates below already include whatever casual arrangement the award defines.</div>`
      : `<div class="notice warn">This award/classification has no distinct casual pay table in the source data — applying the casual loading % above as a flat markup on the permanent rates instead. Confirm against the award if unsure.</div>`;
  }

  if (!RATE_CATEGORIES.length) {
    section.innerHTML = note;
    renderAllowances();
    return;
  }
  section.innerHTML = `
    ${note}
    <label class="mt-8">Roster — enter hours worked in each applicable pay category. <span class="pill" style="color:var(--amber);border-color:var(--amber)">OT</span> marks overtime-rate categories.</label>
    <table>
      <thead><tr><th>Category</th><th>Clause</th><th class="num">Rate ($/hr)</th><th class="num" style="width:110px">Hours</th></tr></thead>
      <tbody>
        ${RATE_CATEGORIES.map(
          (r, i) => `<tr>
            <td>${r.penalty_description}${otBadge(isOvertimeClause(r.clause_description))}</td>
            <td class="muted small">${r.clauses || r.clause_description || ""}</td>
            <td class="num">${money(r.calculated_value)}</td>
            <td class="num"><input type="number" min="0" step="0.25" class="roster-hours" data-idx="${i}" value="${priorHours[r.penalty_description] || ""}" style="text-align:right"></td>
          </tr>`
        ).join("")}
      </tbody>
    </table>
  `;
  document.querySelectorAll(".roster-hours").forEach((input) => {
    input.addEventListener("input", () => renderAllowances(collectAllowancePriorState()));
  });
  renderAllowances(collectAllowancePriorState());
}

function allowanceRow(a, i, listName, eligible, prior) {
  prior = prior || {};
  const hourly = isHourlyAllowance(a.payment_frequency);
  const qtyCell = hourly
    ? eligible.length
      ? `<select class="allowance-category" data-list="${listName}" data-idx="${i}">
          <option value="">— pick category —</option>
          ${eligible.map((c) => `<option value="${c.penaltyDescription}" ${prior.appliesToCategory === c.penaltyDescription ? "selected" : ""}>${c.penaltyDescription} (${c.hours}h)</option>`).join("")}
        </select>
         <input type="number" min="0" step="0.25" class="allowance-qty" data-list="${listName}" data-idx="${i}" value="${prior.quantity || ""}" placeholder="hours" style="text-align:right;margin-top:4px">`
      : `<span class="small muted">Enter ordinary hours in the roster above first</span>`
    : `<input type="number" min="0" step="1" class="allowance-qty" data-list="${listName}" data-idx="${i}" value="${prior.quantity || ""}" style="text-align:right">`;
  return `<tr>
    <td>${a.allowance}${hourly ? ' <span class="small muted">(per hour — attaches to an ordinary-hours category)</span>' : ""}</td>
    <td class="muted small">${money(a.allowance_amount)} ${a.payment_frequency || ""}</td>
    <td class="num">${qtyCell}</td>
  </tr>`;
}

function collectAllowancePriorState() {
  const prior = {};
  document.querySelectorAll(".allowance-qty").forEach((input) => {
    const a = ALLOWANCES[input.dataset.list][Number(input.dataset.idx)];
    if (!a) return;
    const sel = document.querySelector(`.allowance-category[data-list="${input.dataset.list}"][data-idx="${input.dataset.idx}"]`);
    prior[a.allowance] = { quantity: input.value, appliesToCategory: sel ? sel.value : undefined };
  });
  return prior;
}

function renderAllowances(priorSelections) {
  priorSelections = priorSelections || {};
  const section = $("allowancesSection");
  if (!ALLOWANCES.common.length && !ALLOWANCES.other.length) {
    section.innerHTML = "";
    return;
  }
  const eligible = eligibleOrdinaryCategories();
  const otherVisible = !document.getElementById("otherAllowancesTable") || !document.getElementById("otherAllowancesTable").hidden;
  section.innerHTML = `
    <label class="mt-8">Allowances for this award (optional) — enter a quantity for any that apply to this roster.${
      shiftModeActive() ? " Allowances the shift calculator works out itself (e.g. Hospitality evening/night add-ons) are added automatically — only add others here." : ""
    }</label>
    ${
      ALLOWANCES.common.length
        ? `<table>
            <thead><tr><th>Allowance</th><th>Rate</th><th class="num" style="width:220px">Qty</th></tr></thead>
            <tbody>${ALLOWANCES.common.map((a, i) => allowanceRow(a, i, "common", eligible, priorSelections[a.allowance])).join("")}</tbody>
          </table>`
        : ""
    }
    ${
      ALLOWANCES.other.length
        ? `<button type="button" class="link mt-8" id="toggleOtherAllowancesBtn">${otherVisible ? "Hide" : "Show"} ${ALLOWANCES.other.length} other allowance(s) for this award</button>
           <div id="otherAllowancesTable" ${otherVisible ? "" : "hidden"}>
             <table>
               <thead><tr><th>Allowance</th><th>Rate</th><th class="num" style="width:220px">Qty</th></tr></thead>
               <tbody>${ALLOWANCES.other.map((a, i) => allowanceRow(a, i, "other", eligible, priorSelections[a.allowance])).join("")}</tbody>
             </table>
           </div>`
        : ""
    }
  `;
  const toggleBtn = document.getElementById("toggleOtherAllowancesBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const table = document.getElementById("otherAllowancesTable");
      table.hidden = !table.hidden;
      toggleBtn.textContent = `${table.hidden ? "Show" : "Hide"} ${ALLOWANCES.other.length} other allowance(s) for this award`;
    });
  }
}

function collectAllowances() {
  const selections = [];
  document.querySelectorAll(".allowance-qty").forEach((input) => {
    const quantity = parseFloat(input.value);
    if (quantity > 0) {
      const a = ALLOWANCES[input.dataset.list][Number(input.dataset.idx)];
      const sel = document.querySelector(`.allowance-category[data-list="${input.dataset.list}"][data-idx="${input.dataset.idx}"]`);
      selections.push({ allowance: a.allowance, quantity, appliesToCategory: sel ? sel.value : undefined });
    }
  });
  return selections;
}

function collectRoster() {
  const roster = [];
  document.querySelectorAll(".roster-hours").forEach((input) => {
    const hours = parseFloat(input.value);
    if (hours > 0) {
      const cat = RATE_CATEGORIES[Number(input.dataset.idx)];
      roster.push({ penaltyDescription: cat.penalty_description, hours });
    }
  });
  return roster;
}

// ---------- shift calculator ----------
// Awards the shift engine covers (worker/rosterEngine.js) with their default
// daily ordinary-hours cap and the hours after which a meal break is required.
const SHIFT_AWARDS = { MA000004: { cap: 9, meal: 5, retail: true }, MA000009: { cap: 12, meal: 6 }, MA000084: { cap: 8, meal: 5 } };
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One entry per staff roster: { name, count, otherHours, shifts: [{day,start,lengthHours,breakMins}], b: builder state }.
// `count` = how many people work exactly this roster (each is costed separately, then multiplied).
let STAFF = [];
let SHIFT_RESULT = null;

const timeToMin = (t) => {
  const [h, m] = String(t || "").split(":").map(Number);
  return isNaN(h) || isNaN(m) ? null : h * 60 + m;
};
const minToTime = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// Finish time from start + length; a finish earlier than the start means the shift runs past midnight.
const finishFrom = (start, lengthHours) => {
  const s = timeToMin(start);
  return s == null ? "" : minToTime((s + Math.round(lengthHours * 60)) % 1440);
};
const lengthFrom = (start, finish) => {
  const s = timeToMin(start);
  const f = timeToMin(finish);
  if (s == null || f == null || s === f) return 0;
  return ((f - s + 1440) % 1440) / 60;
};
const mealThreshold = () => (SELECTED_AWARD && SHIFT_AWARDS[SELECTED_AWARD.award_code] ? SHIFT_AWARDS[SELECTED_AWARD.award_code].meal : 5);
const suggestBreak = (lengthHours) => (lengthHours > mealThreshold() ? 30 : 0);

function newStaff(n) {
  return {
    name: `Staff ${n}`,
    count: 1,
    otherHours: 0,
    shifts: [],
    b: { days: [], start: "09:00", finish: "17:00", lengthHours: 8, breakMins: suggestBreak(8), breakTouched: false },
  };
}

const entryMode = () => document.querySelector('input[name="entryMode"]:checked').value;
const shiftModeActive = () => !$("modeSection").hidden && entryMode() === "shifts";

function shiftsAvailable() {
  return !!(
    SELECTED_AWARD &&
    SHIFT_AWARDS[SELECTED_AWARD.award_code] &&
    $("isCasual").checked &&
    SELECTED_CLASSIFICATION &&
    SELECTED_CLASSIFICATION.employee_rate_type_code === "AD"
  );
}

function updateModeUI() {
  const cfg = SELECTED_AWARD && SHIFT_AWARDS[SELECTED_AWARD.award_code];
  const avail = shiftsAvailable();
  $("modeSection").hidden = !avail;
  $("modeNote").textContent = cfg && !avail ? "The shift calculator needs a casual adult classification — enter hours by pay category for this selection." : "";
  const useShifts = avail && entryMode() === "shifts";
  $("shiftSection").hidden = !useShifts;
  $("rosterSection").hidden = useShifts;
  if (avail) {
    if ($("dailyCap").dataset.award !== SELECTED_AWARD.award_code) {
      $("dailyCap").value = cfg.cap;
      $("dailyCap").dataset.award = SELECTED_AWARD.award_code;
    }
    $("retailOptions").hidden = !cfg.retail;
  }
}

function invalidateShiftResult() {
  SHIFT_RESULT = null;
  $("shiftResult").innerHTML = "";
  $("breakdown").innerHTML = "";
  $("saveBtn").disabled = true;
  renderAllowances(collectAllowancePriorState());
}

function renderDayChecks() {
  $("phDays").innerHTML = DAY_SHORT.map((d, i) => `<label><input type="checkbox" id="phChk${i}"> ${d}</label>`).join("");
  document.querySelectorAll('[id^="phChk"]').forEach((c) => c.addEventListener("change", invalidateShiftResult));
}

function finishText(s) {
  const startMin = timeToMin(s.start) || 0;
  const total = startMin + Math.round(s.lengthHours * 60);
  const dayOffset = Math.floor(total / 1440);
  const mm = total % 1440;
  const hh = Math.floor(mm / 60);
  const text = `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm % 60).padStart(2, "0")} ${hh >= 12 ? "pm" : "am"}`;
  return dayOffset ? `${text} (${DAY_SHORT[(s.day + dayOffset) % 7]})` : text;
}

function renderShiftRows(st, si) {
  if (!st.shifts.length) return `<p class="small muted">No shifts added yet for ${esc(st.name)}.</p>`;
  return `<table>
    <thead><tr><th>Day</th><th>Start</th><th>Finish</th><th class="num">Length (h)</th><th class="num">Unpaid break (min)</th><th></th></tr></thead>
    <tbody>
      ${st.shifts
        .map(
          (s, i) => `<tr>
          <td><select class="shift-field" data-si="${si}" data-i="${i}" data-k="day">${DAY_SHORT.map((d, di) => `<option value="${di}" ${s.day === di ? "selected" : ""}>${d}</option>`).join("")}</select></td>
          <td><input type="time" class="shift-field" data-si="${si}" data-i="${i}" data-k="start" value="${s.start}"></td>
          <td><input type="time" class="shift-field" data-si="${si}" data-i="${i}" data-k="finish" value="${finishFrom(s.start, s.lengthHours)}"> <span class="muted small">${finishText(s).includes("(") ? finishText(s).replace(/^.*\(/, "(") : ""}</span></td>
          <td class="num"><input type="number" class="shift-field" data-si="${si}" data-i="${i}" data-k="lengthHours" step="0.25" min="0.25" max="24" value="${s.lengthHours}" style="text-align:right"></td>
          <td class="num"><input type="number" class="shift-field" data-si="${si}" data-i="${i}" data-k="breakMins" step="5" min="0" value="${s.breakMins}" style="text-align:right"></td>
          <td><button type="button" class="link shift-remove" data-si="${si}" data-i="${i}">Remove</button></td>
        </tr>`
        )
        .join("")}
    </tbody></table>`;
}

function renderStaffBlocks() {
  $("staffBlocks").innerHTML = STAFF.map((st, si) => {
    const b = st.b;
    return `<div class="card staff-block" style="margin-bottom:14px">
      <div class="row" style="align-items:flex-end">
        <div class="field"><label>Roster name</label><input type="text" class="staff-name" data-si="${si}" value="${esc(st.name)}" maxlength="60"></div>
        <div class="field" style="flex:0 0 190px"><label>Number of staff on this roster</label><input type="number" class="staff-count" data-si="${si}" min="1" max="200" step="1" value="${st.count}"></div>
        <div class="field" style="flex:0 0 190px"><label>Hours already worked this week (each)</label><input type="number" class="staff-other" data-si="${si}" min="0" step="0.25" value="${st.otherHours || 0}"></div>
        ${STAFF.length > 1 ? `<div class="field" style="flex:0 0 auto"><button type="button" class="link staff-remove" data-si="${si}">Remove roster</button></div>` : ""}
      </div>
      <label class="mt-8">Add shifts — tick the days that share the same times</label>
      <div class="day-checks">${DAY_SHORT.map((d, i) => `<label><input type="checkbox" class="b-day" data-si="${si}" data-d="${i}" ${b.days.includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:0 0 130px"><label>Start</label><input type="time" class="b-start" data-si="${si}" value="${b.start}"></div>
        <div class="field" style="flex:0 0 130px"><label>Finish</label><input type="time" class="b-finish" data-si="${si}" value="${b.finish}"></div>
        <div class="field" style="flex:0 0 120px"><label>or length (h)</label><input type="number" class="b-length" data-si="${si}" step="0.25" min="0.25" max="24" value="${b.lengthHours}"></div>
        <div class="field" style="flex:0 0 150px"><label>Unpaid break (min)</label><input type="number" class="b-break" data-si="${si}" step="5" min="0" value="${b.breakMins}"></div>
        <div class="field" style="flex:0 0 auto"><button type="button" class="b-add" data-si="${si}">Add shift(s)</button></div>
      </div>
      <div class="b-err" id="bErr${si}"></div>
      <div class="shift-rows">${renderShiftRows(st, si)}</div>
    </div>`;
  }).join("");
}

function addShifts(si) {
  const st = STAFF[si];
  const b = st.b;
  const err = (msg) => ($(`bErr${si}`).innerHTML = `<div class="notice error">${msg}</div>`);
  if (!b.days.length) return err("Tick at least one day for the shift.");
  if (!b.start) return err("Enter a start time.");
  if (!(b.lengthHours > 0 && b.lengthHours <= 24)) return err("Enter a finish time (or a length between 0 and 24 hours).");
  for (const day of b.days) st.shifts.push({ day, start: b.start, lengthHours: b.lengthHours, breakMins: b.breakMins });
  st.shifts.sort((x, y) => x.day - y.day || x.start.localeCompare(y.start));
  b.days = [];
  invalidateShiftResult();
  renderStaffBlocks();
}

function shiftPayloadParts() {
  const overrides = {};
  if (SHIFT_RESULT) {
    document.querySelectorAll(".shift-line-hours").forEach((inp) => {
      const orig = SHIFT_RESULT.lines.find((l) => l.label === inp.dataset.label);
      const v = parseFloat(inp.value);
      if (orig && !isNaN(v) && Math.abs(v - orig.hours) > 0.001) overrides[inp.dataset.label] = v;
    });
  }
  return {
    staff: STAFF.map((st, i) => ({
      name: st.name.trim() || `Staff ${i + 1}`,
      count: Math.max(1, Math.round(Number(st.count) || 1)),
      otherHoursThisWeek: Number(st.otherHours) || 0,
      shifts: st.shifts.map((s) => ({ day: s.day, start: s.start, lengthHours: s.lengthHours, breakMins: s.breakMins })),
    })),
    publicHolidays: DAY_SHORT.map((_, i) => i).filter((i) => $(`phChk${i}`).checked),
    shiftOptions: {
      dailyCapHours: parseFloat($("dailyCap").value) || undefined,
      shiftworker: $("optShiftworker").checked,
      lateTrading: $("optLateTrading").checked,
    },
    lineOverrides: overrides,
  };
}

async function workOutHours() {
  $("shiftError").innerHTML = "";
  const empty = STAFF.find((st) => !st.shifts.length);
  if (empty) {
    $("shiftError").innerHTML = `<div class="notice error">Add at least one shift to "${esc(empty.name)}" (or remove that roster).</div>`;
    return false;
  }
  const parts = shiftPayloadParts();
  delete parts.lineOverrides;
  try {
    SHIFT_RESULT = await api("/api/staff/roster/calculate", {
      method: "POST",
      body: JSON.stringify({ awardCode: SELECTED_AWARD.award_code, basePayRateId: SELECTED_CLASSIFICATION.base_pay_rate_id, isCasual: true, ...parts }),
    });
  } catch (e) {
    SHIFT_RESULT = null;
    $("shiftResult").innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    renderAllowances(collectAllowancePriorState());
    return false;
  }
  renderShiftResult();
  renderAllowances(collectAllowancePriorState());
  return true;
}

function renderShiftResult() {
  const r = SHIFT_RESULT;
  const splitText = (d) => d.segments.map((s) => `${s.hours}h ${esc(s.label)}${s.isOvertime ? ' <span class="pill" style="color:var(--amber);border-color:var(--amber)">OT</span>' : ""}`).join(" · ");
  const multi = r.staffDetails.length > 1 || r.staffDetails.some((s) => s.count > 1);
  $("shiftResult").innerHTML = `
    ${r.warnings.length ? `<div class="notice warn"><strong>Check before quoting:</strong><ul style="margin:6px 0 0 18px;padding:0">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    <h3 class="mt-8" style="margin-bottom:8px">How each shift splits</h3>
    ${r.staffDetails
      .map(
        (sd) => `<p class="small" style="margin:10px 0 4px"><strong>${esc(sd.name)}</strong>${sd.count > 1 ? ` <span class="muted">× ${sd.count} staff</span>` : ""}</p>
      <table>
        <thead><tr><th>Shift</th><th class="num">Paid hours</th><th>Split under the award</th></tr></thead>
        <tbody>${sd.shifts.map((d) => `<tr><td>${esc(d.dayName)} ${esc(d.start)} – ${esc(d.finish)}${d.breakMins ? ` <span class="muted small">(${d.breakMins} min unpaid break)</span>` : ""}</td><td class="num">${d.workedHours}</td><td class="small">${splitText(d)}</td></tr>`).join("")}</tbody>
      </table>`
      )
      .join("")}
    <h3 class="mt-8" style="margin-bottom:8px">Hours by pay category${multi ? " — total across all staff" : ""} <span class="muted small">— you can adjust these; adjustments are recorded on the quote</span></h3>
    <table>
      <thead><tr><th>Category</th><th>Clause</th><th class="num">Award rate</th><th class="num" style="width:110px">Hours</th></tr></thead>
      <tbody>${r.lines
        .map(
          (l) => `<tr><td>${esc(l.label)}${otBadge(l.isOvertime)}</td><td class="muted small">${esc(l.clauses)}</td><td class="num">${money(l.rate)}</td>
          <td class="num"><input type="number" min="0" step="0.25" class="shift-line-hours" data-label="${esc(l.label)}" value="${l.hours}" style="text-align:right"></td></tr>`
        )
        .join("")}</tbody>
    </table>
    ${r.addOns.length ? `<p class="small muted">Added automatically from the shifts: ${r.addOns.map((a) => `${a.quantity}h ${esc(a.allowance)}`).join("; ")}.</p>` : ""}
    <details class="small muted" style="margin-top:6px"><summary>Assumptions used</summary><ul style="margin:6px 0 0 18px;padding:0">${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>
  `;
  document.querySelectorAll(".shift-line-hours").forEach((inp) => {
    inp.addEventListener("input", () => {
      $("breakdown").innerHTML = "";
      $("saveBtn").disabled = true;
      renderAllowances(collectAllowancePriorState());
    });
  });
}

function wireShiftEvents() {
  if (!STAFF.length) STAFF.push(newStaff(1));
  renderDayChecks();
  renderStaffBlocks();
  document.querySelectorAll('input[name="entryMode"]').forEach((r) =>
    r.addEventListener("change", () => {
      updateModeUI();
      invalidateShiftResult();
    })
  );
  $("addStaffBtn").addEventListener("click", () => {
    STAFF.push(newStaff(STAFF.length + 1));
    invalidateShiftResult();
    renderStaffBlocks();
  });
  $("workOutBtn").addEventListener("click", workOutHours);
  ["dailyCap", "optShiftworker", "optLateTrading"].forEach((id) => $(id).addEventListener("change", invalidateShiftResult));

  const blocks = $("staffBlocks");
  const staffOf = (el) => STAFF[Number(el.dataset.si)];

  // Typing in a builder or header field only updates state (no re-render, so focus is kept).
  blocks.addEventListener("input", (e) => {
    const el = e.target;
    const st = el.dataset.si !== undefined ? staffOf(el) : null;
    if (!st) return;
    const b = st.b;
    const si = el.dataset.si;
    const q = (cls) => blocks.querySelector(`.${cls}[data-si="${si}"]`);
    if (el.classList.contains("b-start") || el.classList.contains("b-finish")) {
      if (el.classList.contains("b-start")) b.start = el.value;
      else b.finish = el.value;
      b.lengthHours = lengthFrom(b.start, b.finish);
      q("b-length").value = b.lengthHours || "";
    } else if (el.classList.contains("b-length")) {
      b.lengthHours = parseFloat(el.value) || 0;
      b.finish = finishFrom(b.start, b.lengthHours);
      q("b-finish").value = b.finish;
    } else if (el.classList.contains("b-break")) {
      b.breakMins = parseInt(el.value, 10) || 0;
      b.breakTouched = true;
      return;
    } else {
      return;
    }
    // Suggest a 30-minute unpaid meal break for longer shifts until the user sets one themselves.
    if (!b.breakTouched) {
      b.breakMins = suggestBreak(b.lengthHours);
      q("b-break").value = b.breakMins;
    }
  });

  blocks.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.si === undefined) return;
    const st = staffOf(el);
    if (!st) return;
    if (el.classList.contains("staff-name")) {
      st.name = el.value;
      invalidateShiftResult();
    } else if (el.classList.contains("staff-count")) {
      st.count = Math.max(1, Math.min(200, Math.round(parseFloat(el.value) || 1)));
      el.value = st.count;
      invalidateShiftResult();
    } else if (el.classList.contains("staff-other")) {
      st.otherHours = Math.max(0, parseFloat(el.value) || 0);
      invalidateShiftResult();
    } else if (el.classList.contains("b-day")) {
      const d = Number(el.dataset.d);
      st.b.days = el.checked ? [...new Set([...st.b.days, d])].sort() : st.b.days.filter((x) => x !== d);
    } else if (el.classList.contains("shift-field")) {
      const s = st.shifts[Number(el.dataset.i)];
      const k = el.dataset.k;
      if (k === "day") s.day = Number(el.value);
      else if (k === "start") s.start = el.value || s.start;
      else if (k === "finish") s.lengthHours = lengthFrom(s.start, el.value) || s.lengthHours;
      else if (k === "lengthHours") s.lengthHours = Math.min(24, parseFloat(el.value) || 0) || s.lengthHours;
      else if (k === "breakMins") s.breakMins = parseInt(el.value, 10) || 0;
      st.shifts.sort((x, y) => x.day - y.day || x.start.localeCompare(y.start));
      invalidateShiftResult();
      renderStaffBlocks();
    }
  });

  blocks.addEventListener("click", (e) => {
    const el = e.target.closest("button");
    if (!el || el.dataset.si === undefined) return;
    const st = staffOf(el);
    if (!st) return;
    if (el.classList.contains("b-add")) {
      addShifts(Number(el.dataset.si));
    } else if (el.classList.contains("shift-remove")) {
      st.shifts.splice(Number(el.dataset.i), 1);
      invalidateShiftResult();
      renderStaffBlocks();
    } else if (el.classList.contains("staff-remove")) {
      STAFF.splice(Number(el.dataset.si), 1);
      invalidateShiftResult();
      renderStaffBlocks();
    }
  });
}

async function calculate() {
  const shiftMode = shiftModeActive();
  let roster = [];
  if (shiftMode) {
    if (!SHIFT_RESULT && !(await workOutHours())) return;
  } else {
    roster = collectRoster();
    if (!roster.length) {
      $("breakdown").innerHTML = `<div class="notice error">Enter hours for at least one roster category.</div>`;
      return;
    }
  }
  const payload = {
    awardCode: SELECTED_AWARD.award_code,
    basePayRateId: SELECTED_CLASSIFICATION.base_pay_rate_id,
    isCasual: $("isCasual").checked,
    casualLoadingPct: parseFloat($("casualLoadingPct").value) || 0,
    oncostPct: parseFloat($("oncostPct").value),
    marginPct: parseFloat($("marginPct").value),
    roster,
    allowances: collectAllowances(),
    ...(shiftMode ? shiftPayloadParts() : {}),
  };
  try {
    LAST_BREAKDOWN = await api("/api/staff/quotes/preview", { method: "POST", body: JSON.stringify(payload) });
    renderBreakdown(LAST_BREAKDOWN);
    $("saveBtn").disabled = false;
  } catch (e) {
    $("breakdown").innerHTML = `<div class="notice error">${e.message}</div>`;
    $("saveBtn").disabled = true;
  }
}

function renderBreakdown(b) {
  $("breakdown").innerHTML = `
    <h3 class="mt-8" style="margin-bottom:10px">Rate card — what the client is actually charged, per category</h3>
    <p class="small muted">The client is invoiced exactly what the staff member earns for each category, plus on-costs and margin — never a single blended rate.</p>
    <table>
      <thead><tr><th>Category</th><th class="num">Hours</th><th class="num">Award rate</th><th class="num">Charge rate (excl. GST)</th><th class="num">Charge total</th></tr></thead>
      <tbody>
        ${b.lines.map((l) => `<tr><td>${l.penaltyDescription}${otBadge(l.isOvertime)}</td><td class="num">${l.hours}</td><td class="num">${money(l.loadedRate)}</td><td class="num">${money(l.chargeRate)}</td><td class="num">${money(l.chargeLineTotal)}</td></tr>`).join("")}
      </tbody>
    </table>
    ${
      b.allowanceLines && b.allowanceLines.length
        ? `<table>
            <thead><tr><th>Allowance</th><th class="num">Qty</th><th class="num">Award rate</th><th class="num">Charge rate (excl. GST)</th><th class="num">Charge total</th></tr></thead>
            <tbody>${b.allowanceLines.map((l) => `<tr><td>${l.allowance}</td><td class="num">${l.quantity}</td><td class="num">${money(l.amount)}</td><td class="num">${money(l.chargeRate)}</td><td class="num">${money(l.chargeLineTotal)}</td></tr>`).join("")}</tbody>
          </table>`
        : ""
    }
    <div class="row mt-8" style="gap:24px">
      <div class="breakdown-total"><span class="label">Total charge (excl. GST) for this roster</span>${money(
        b.lines.reduce((s, l) => s + l.chargeLineTotal, 0) + (b.allowanceLines || []).reduce((s, l) => s + l.chargeLineTotal, 0)
      )}</div>
    </div>
    <div class="small muted mt-8">
      Weighted average across this roster (reference only — not what's charged): award ${money(b.blendedAwardRate)}/hr →
      cost ${money(b.costRate)}/hr (+${b.oncostPct}% on-costs) → charge ${money(b.chargeRate)}/hr (+${b.marginPct}% margin)
    </div>
    <div class="small muted mt-8">Total rostered hours: ${b.totalHours} — total award pay: ${money(b.totalPay)}</div>
    <div class="small muted mt-8">Casual rate source: ${
      b.casualRateSource === "shift_calculator"
        ? "shift calculator — award rules applied to the proposed shifts"
        : b.casualRateSource === "award_table"
        ? "award's own official casual pay table"
        : b.casualRateSource === "loading_fallback"
        ? "permanent rates + fallback casual loading %"
        : "not applicable (not a casual placement)"
    }</div>
    ${
      b.shiftPlan && b.shiftPlan.overrides && b.shiftPlan.overrides.length
        ? `<div class="notice warn mt-8">Hours manually adjusted from the calculator: ${b.shiftPlan.overrides.map((o) => `${o.label} ${o.from}h → ${o.to}h`).join("; ")}</div>`
        : ""
    }
  `;
}

async function saveQuote() {
  const clientName = $("clientName").value.trim();
  if (!clientName) {
    alert("Enter the employer / client name before saving.");
    return;
  }
  const shiftMode = shiftModeActive();
  const roster = shiftMode ? [] : collectRoster();
  const payload = {
    clientName,
    roleTitle: $("roleTitle").value.trim(),
    awardCode: SELECTED_AWARD.award_code,
    awardName: SELECTED_AWARD.name,
    basePayRateId: SELECTED_CLASSIFICATION.base_pay_rate_id,
    classificationName: SELECTED_CLASSIFICATION.classification,
    employeeRateTypeCode: SELECTED_CLASSIFICATION.employee_rate_type_code,
    isCasual: $("isCasual").checked,
    casualLoadingPct: parseFloat($("casualLoadingPct").value) || 0,
    oncostPct: parseFloat($("oncostPct").value),
    marginPct: parseFloat($("marginPct").value),
    roster,
    allowances: collectAllowances(),
    notes: $("notes").value.trim(),
    ...(shiftMode ? shiftPayloadParts() : {}),
  };
  try {
    const quote = await api("/api/staff/quotes", { method: "POST", body: JSON.stringify(payload) });
    loadHistory();
    $("breakdown").innerHTML += `<div class="notice mt-8">Saved. <a href="/quote-print.html?id=${quote.id}" target="_blank">Open client quote</a> (our charge rates only) · <a href="/quote-print.html?id=${quote.id}&internal=1" target="_blank">internal copy</a> (shows award rates and margin — don't send)</div>`;
    $("saveBtn").disabled = true;
  } catch (e) {
    $("breakdown").innerHTML += `<div class="notice error mt-8">${e.message}</div>`;
  }
}

async function loadHistory() {
  const quotes = await api("/api/staff/quotes");
  $("history").innerHTML = quotes.length
    ? `<table>
        <thead><tr><th>Date</th><th>Client</th><th>Role</th><th>Award</th><th class="num">Charge rate (excl. GST)</th><th>By</th><th></th></tr></thead>
        <tbody>
          ${quotes.map(
            (q) => `<tr>
              <td>${new Date(q.created_at + "Z").toLocaleDateString()}</td>
              <td>${q.client_name}</td>
              <td>${q.role_title || ""}</td>
              <td>${q.award_name}</td>
              <td class="num">${money(q.charge_rate)}/hr</td>
              <td>${q.staff_name}</td>
              <td><a href="/quote-print.html?id=${q.id}" target="_blank">Client quote</a> · <a href="/quote-print.html?id=${q.id}&internal=1" target="_blank">Internal</a></td>
            </tr>`
          ).join("")}
        </tbody>
      </table>`
    : `<p class="muted small">No quotes saved yet.</p>`;
}

async function loadAccounts() {
  const accounts = await api("/api/staff/accounts");
  const canToggle = (a) => a.role !== "owner" && a.id !== ME.id && (ME.role === "owner" || a.role === "staff");
  $("accountsList").innerHTML = `<table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${accounts.map(
        (a) => `<tr>
          <td>${a.name}</td>
          <td>${a.email}</td>
          <td>${a.role}</td>
          <td>
            ${!a.active ? '<span class="pill" style="color:var(--red);border-color:var(--red)">deactivated</span>' : ""}
            ${a.active && a.pendingInvite ? '<span class="pill uncertain">setup link pending</span>' : ""}
            ${a.active && !a.pendingInvite && a.mustChange ? '<span class="pill uncertain">pending first login</span>' : ""}
          </td>
          <td>
            ${canToggle(a) ? `<button type="button" class="link toggle-active-btn" data-id="${a.id}" data-active="${a.active ? 1 : 0}">${a.active ? "Deactivate" : "Reactivate"}</button>` : ""}
            ${canToggle(a) ? ` <button type="button" class="link set-password-btn" data-id="${a.id}" data-name="${a.name}">Set password</button>` : ""}
            ${canToggle(a) ? ` <button type="button" class="link resend-invite-btn" data-id="${a.id}" data-name="${a.name}">Resend setup link</button>` : ""}
          </td>
        </tr>`
      ).join("")}
    </tbody>
  </table>`;
  document.querySelectorAll(".toggle-active-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleAccountActive(btn.dataset.id, btn.dataset.active === "1"));
  });
  document.querySelectorAll(".set-password-btn").forEach((btn) => {
    btn.addEventListener("click", () => showSetPasswordForm(btn.dataset.id, btn.dataset.name));
  });
  document.querySelectorAll(".resend-invite-btn").forEach((btn) => {
    btn.addEventListener("click", () => resendInvite(btn.dataset.id, btn.dataset.name));
  });
}

async function resendInvite(id, name) {
  try {
    const account = await api(`/api/staff/accounts/${id}/resend-invite`, { method: "POST" });
    const subject = encodeURIComponent("Set up your WTC Labour Rates account");
    const body = encodeURIComponent(
      `Hi ${name},\n\nHere's a new setup link for your WTC Labour Rates account. Click this link to set your password and sign in:\n\n${account.inviteLink}\n\nThis link expires in 7 days.`
    );
    const mailtoLink = `mailto:${account.email}?subject=${subject}&body=${body}`;
    $("newAccountResult").innerHTML = `
      <div class="notice">
        New setup link for ${name} (expires in 7 days, shown once):<br>
        <input type="text" readonly value="${account.inviteLink}" style="margin:6px 0" onclick="this.select()">
        <div class="row" style="gap:8px; margin-top:4px">
          <button type="button" id="copyResendBtn">Copy link</button>
          <a href="${mailtoLink}"><button type="button">Email via your mail client</button></a>
        </div>
      </div>`;
    document.getElementById("copyResendBtn").addEventListener("click", () => {
      navigator.clipboard.writeText(account.inviteLink);
    });
    loadAccounts();
  } catch (e) {
    $("newAccountResult").innerHTML = `<div class="notice error">${e.message}</div>`;
  }
}

// Inline form (not prompt()) for an admin/owner to set or reset someone's password.
function showSetPasswordForm(id, name) {
  $("newAccountResult").innerHTML = `
    <div class="notice">
      Set a new password for <strong>${name}</strong>. Their old password stops working immediately.
      <div class="row" style="margin-top:8px; align-items:flex-end">
        <div class="field" style="flex:0 0 260px"><label for="setPwInput">New password (min 8 characters)</label><input type="text" id="setPwInput" autocomplete="off"></div>
        <div class="field" style="flex:1; min-width:240px"><label style="color:var(--text)"><input type="checkbox" id="setPwForce"> Make them choose their own at next sign-in</label></div>
        <div class="field" style="flex:0 0 auto"><button type="button" class="primary" id="setPwSave">Set password</button> <button type="button" class="link" id="setPwCancel">Cancel</button></div>
      </div>
    </div>`;
  $("setPwCancel").addEventListener("click", () => ($("newAccountResult").innerHTML = ""));
  $("setPwSave").addEventListener("click", async () => {
    try {
      await api(`/api/staff/accounts/${id}/set-password`, {
        method: "POST",
        body: JSON.stringify({ password: $("setPwInput").value, forceChange: $("setPwForce").checked }),
      });
      $("newAccountResult").innerHTML = `<div class="notice">Password set for ${name}. Give it to them securely — they can change it any time with <strong>Change password</strong>.</div>`;
      loadAccounts();
    } catch (e) {
      $("newAccountResult").innerHTML += `<div class="notice error mt-8">${e.message}</div>`;
    }
  });
}

async function toggleAccountActive(id, currentlyActive) {
  try {
    await api(`/api/staff/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ active: !currentlyActive }) });
    loadAccounts();
  } catch (e) {
    $("newAccountResult").innerHTML = `<div class="notice error">${e.message}</div>`;
  }
}

async function addAccount() {
  const email = $("newEmail").value.trim();
  const name = $("newName").value.trim();
  const role = $("newRole").value;
  if (!email || !name) return;
  const password = $("newPassword").value;
  try {
    const account = await api("/api/staff/accounts", {
      method: "POST",
      body: JSON.stringify({ email, name, role, password: password || undefined, forceChange: $("newForceChange").checked }),
    });
    if (!account.inviteLink) {
      // Password set directly -- no link to send.
      $("newAccountResult").innerHTML = `<div class="notice">Created ${account.name}. They can sign in now with the password you set${$("newForceChange").checked ? " (they'll be asked to choose their own first)" : ""}. Give it to them securely.</div>`;
      $("newEmail").value = "";
      $("newName").value = "";
      $("newPassword").value = "";
      $("newForceChange").checked = false;
      loadAccounts();
      return;
    }
    const subject = encodeURIComponent("Set up your WTC Labour Rates account");
    const body = encodeURIComponent(
      `Hi ${account.name},\n\nYou've been added to the WTC Labour Rates calculator. Click this link to set your password and sign in:\n\n${account.inviteLink}\n\nThis link expires in 7 days.`
    );
    const mailtoLink = `mailto:${account.email}?subject=${subject}&body=${body}`;
    $("newAccountResult").innerHTML = `
      <div class="notice">
        Created ${account.name}. Setup link (expires in 7 days, shown once):<br>
        <input type="text" readonly value="${account.inviteLink}" style="margin:6px 0" onclick="this.select()">
        <div class="row" style="gap:8px; margin-top:4px">
          <button type="button" id="copyInviteBtn">Copy link</button>
          <a href="${mailtoLink}"><button type="button">Email via your mail client</button></a>
        </div>
      </div>`;
    document.getElementById("copyInviteBtn").addEventListener("click", () => {
      navigator.clipboard.writeText(account.inviteLink);
    });
    $("newEmail").value = "";
    $("newName").value = "";
    loadAccounts();
  } catch (e) {
    $("newAccountResult").innerHTML = `<div class="notice error">${e.message}</div>`;
  }
}

init();
