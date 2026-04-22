/**
 * Alpine.js app — all state, routing, and view logic for the iCourse frontend.
 * References ICS.crypto, ICS.github, ICS.db, ICS.render globals.
 */

/* ── Gzip helpers (Compression Streams API) ── */
async function _gunzip(compressedBytes) {
  var ds = new DecompressionStream("gzip");
  var writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  var chunks = [];
  var reader = ds.readable.getReader();
  while (true) {
    var r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  var total = chunks.reduce(function(s, c) { return s + c.length; }, 0);
  var result = new Uint8Array(total);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return result;
}

async function _gzip(bytes) {
  var cs = new CompressionStream("gzip");
  var writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  var chunks = [];
  var reader = cs.readable.getReader();
  while (true) {
    var r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  var total = chunks.reduce(function(s, c) { return s + c.length; }, 0);
  var result = new Uint8Array(total);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return result;
}

/* ── IndexedDB cache for encrypted DB (avoid re-downloading 20MB+ every load) ── */
var _idbName = "ics_cache";

function _idbOpen() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(_idbName, 1);
    req.onupgradeneeded = function() { req.result.createObjectStore("blobs"); };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}

async function _idbGet(key) {
  var db = await _idbOpen();
  return new Promise(function(resolve) {
    var tx = db.transaction("blobs", "readonly");
    var req = tx.objectStore("blobs").get(key);
    req.onsuccess = function() { resolve(req.result || null); };
    req.onerror = function() { resolve(null); };
  });
}

async function _idbPut(key, value) {
  var db = await _idbOpen();
  return new Promise(function(resolve) {
    var tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(value, key);
    tx.oncomplete = function() { resolve(); };
    tx.onerror = function() { resolve(); };
  });
}

/* ── Credential helpers (localStorage) ── */
const _LS = "ics_";
const _loadCreds = () => { try { return JSON.parse(localStorage.getItem(_LS + "creds")); } catch { return null; } };
const _saveCreds = (c) => localStorage.setItem(_LS + "creds", JSON.stringify(c));
const _loadSettings = () => { try { return JSON.parse(localStorage.getItem(_LS + "settings")) || {}; } catch { return {}; } };
const _saveSettings = (s) => localStorage.setItem(_LS + "settings", JSON.stringify(s));

function _relativeTime(iso) {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const days = Math.floor(h / 24);
  if (days < 30) return days + "d ago";
  return new Date(iso).toLocaleDateString();
}

function _highlightSnippet(text, query, radius) {
  radius = radius || 60;
  if (!text || !query) return "";
  const plain = ICS.render.plainSnippet(text, 99999);
  const idx = plain.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return plain.slice(0, 120) + "...";
  const s = Math.max(0, idx - radius);
  const e = Math.min(plain.length, idx + query.length + radius);
  let snip = (s > 0 ? "..." : "") + plain.slice(s, e) + (e < plain.length ? "..." : "");
  const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return snip.replace(re, "<mark>$1</mark>");
}

function _escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _getLectureDateString(dateText, processedAt) {
  if (dateText) return String(dateText);
  if (!processedAt) return "";
  const d = new Date(processedAt);
  if (Number.isNaN(d.getTime())) return String(processedAt);
  return d.toISOString().slice(0, 10);
}

/* ── Alpine app ── */
document.addEventListener("alpine:init", () => {
  Alpine.data("app", () => ({
    view: "loading", error: null, loadingMsg: "",
    toast: null, toastType: "success",
    courses: [], lectures: [],
    currentCourse: null, currentLecture: null,
    searchQuery: "", searchResults: [],
    editText: "", editPreview: false, saving: false,
    showTranscript: false,
    commitSha: null,
    setup: { token: "", stuid: "", uispsw: "", dashscope: "", smtp: "" },
    setupError: "", setupTesting: false,
    settingsForm: {}, showSecrets: {},
    exportDialogOpen: false, exportSelection: {}, exportingPdf: false,
    iterations: 10000, repoOwner: "", repoName: "", dataBranch: "data",
    _history: [],

    async init() {
      const detected = ICS.github.detectRepo();
      const s = _loadSettings();
      this.repoOwner = s.owner || (detected?.owner ?? "");
      this.repoName = s.repo || (detected?.repo ?? "");
      this.dataBranch = s.branch || "data";
      this.iterations = s.iterations || 10000;
      const creds = _loadCreds();
      if (!creds) { this.view = "setup"; return; }
      await this._loadDB(creds);
    },

    async _loadDB(creds) {
      this.view = "loading"; this.error = null;
      try {
        this.loadingMsg = "Checking for updates...";
        var remoteSha = await ICS.github.getLatestCommitSha(
          this.repoOwner, this.repoName, this.dataBranch, creds.token
        );

        // Check IndexedDB cache
        var cached = await _idbGet("db_cache");
        if (cached && cached.sha === remoteSha) {
          this.loadingMsg = "Loading cached data...";
          this.commitSha = remoteSha;
          await ICS.db.initDB(cached.dbBytes);
          ICS.db.ensureSchema();
          this.courses = ICS.db.getCourses();
          this.view = "courses";
          return;
        }

        this.loadingMsg = "Downloading database...";
        const { data, commitSha, compressed } = await ICS.github.fetchEncryptedDB(
          this.repoOwner, this.repoName, this.dataBranch, creds.token
        );
        this.commitSha = commitSha;
        this.loadingMsg = "Decrypting...";
        var pw = ICS.crypto.buildPassword(creds);
        var decrypted = await ICS.crypto.decrypt(data, pw, this.iterations);
        if (compressed) {
          this.loadingMsg = "Decompressing...";
          decrypted = await _gunzip(decrypted);
        }
        this.loadingMsg = "Loading data...";
        await ICS.db.initDB(decrypted);
        ICS.db.ensureSchema();

        // Cache the decrypted DB bytes for next load
        await _idbPut("db_cache", { sha: commitSha, dbBytes: decrypted });

        this.courses = ICS.db.getCourses();
        this.view = "courses";
      } catch (e) {
        this.error = e.message;
        this.view = "error";
      }
    },

    navigate(view, params) {
      params = params || {};
      this._history.push({ view: this.view, courseId: this.currentCourse?.course_id, lectureId: this.currentLecture?.sub_id });
      this._go(view, params);
    },
    _go(view, params) {
      params = params || {};
      this.error = null;
      if (view === "courses") { this.courses = ICS.db.getCourses(); }
      else if (view === "lectures" && params.courseId) {
        this.currentCourse = this.courses.find(x => x.course_id === params.courseId) || { course_id: params.courseId, title: "...", teacher: "" };
        this.lectures = ICS.db.getLectures(params.courseId);
      }
      else if (view === "detail" && params.subId) { this.currentLecture = ICS.db.getLecture(params.subId); this.showTranscript = false; }
      else if (view === "edit") { this.editText = this.currentLecture?.summary || ""; this.editPreview = false; }
      this.view = view;
      if (view !== "lectures") this.exportDialogOpen = false;
    },
    goBack() {
      const p = this._history.pop();
      if (p) this._go(p.view, { courseId: p.courseId, subId: p.lectureId });
      else this._go("courses");
    },

    openCourse(id) { this.navigate("lectures", { courseId: id }); },
    openLecture(id) { this.navigate("detail", { subId: id }); },
    startEdit() { this.navigate("edit"); },
    cancelEdit() { this.goBack(); },

    getExportableLectures() {
      return (this.lectures || []).filter((lec) => lec.summary && lec.summary.trim());
    },
    openExportDialog() {
      const list = this.getExportableLectures();
      if (!list.length) { this._toast("No summarized lectures to export", "error"); return; }
      this.exportSelection = {};
      list.forEach((lec) => { this.exportSelection[lec.sub_id] = true; });
      this.exportDialogOpen = true;
    },
    closeExportDialog() {
      if (this.exportingPdf) return;
      this.exportDialogOpen = false;
    },
    isLectureSelected(subId) { return !!this.exportSelection[subId]; },
    toggleLectureSelection(subId, checked) { this.exportSelection[subId] = !!checked; },
    setExportAll(checked) {
      this.getExportableLectures().forEach((lec) => { this.exportSelection[lec.sub_id] = !!checked; });
    },
    isExportAllSelected() {
      const list = this.getExportableLectures();
      return list.length > 0 && list.every((lec) => this.exportSelection[lec.sub_id]);
    },
    selectedExportCount() {
      return this.getExportableLectures().filter((lec) => this.exportSelection[lec.sub_id]).length;
    },
    _buildExportHtml(lectures) {
      const courseTitle = this.currentCourse?.title || "课程";
      const teacher = this.currentCourse?.teacher || "";
      const sections = lectures.map((lec) => {
        const dateText = _getLectureDateString(lec.date, lec.processed_at);
        const title = _escapeHtml(lec.sub_title || "Untitled");
        const subtitle = dateText ? `<small>(${_escapeHtml(dateText)})</small>` : "";
        const titleLine = subtitle ? `${title} ${subtitle}` : title;
        return `
          <section>
            <h2>${titleLine}</h2>
            ${ICS.render.renderMarkdown(lec.summary || "")}
          </section>
          <hr>
        `;
      }).join("");
      return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif; color: #111827; }
    h1 { font-size: 24px; margin: 0; }
    .meta { color: #6b7280; margin: 8px 0 16px; font-size: 14px; }
    section { page-break-inside: avoid; }
    h2 { font-size: 18px; margin: 14px 0 10px; }
    h2 small { font-size: 12px; font-weight: 400; color: #6b7280; margin-left: 6px; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0; }
    p { line-height: 1.7; }
    pre { white-space: pre-wrap; overflow-wrap: break-word; word-wrap: break-word; }
    img { max-width: 100%; }
  </style>
</head>
<body>
  <h1>${_escapeHtml(courseTitle)}</h1>
  <p class="meta">${teacher ? `任课教师：${_escapeHtml(teacher)}` : ""}</p>
  <hr>
  ${sections}
</body>
</html>
      `;
    },
    async exportSelectedToPdf() {
      if (this.exportingPdf) return;
      if (!window.html2pdf) {
        this._toast("PDF library failed to load", "error");
        return;
      }
      const selected = this.getExportableLectures().filter((lec) => this.exportSelection[lec.sub_id]);
      if (!selected.length) {
        this._toast("Please select at least one lecture", "error");
        return;
      }
      this.exportingPdf = true;
      let mount = null;
      try {
        mount = document.createElement("div");
        mount.style.position = "fixed";
        mount.style.left = "-10000px";
        mount.style.top = "0";
        mount.style.width = "794px";
        mount.innerHTML = this._buildExportHtml(selected);
        document.body.appendChild(mount);
        const fileBase = (this.currentCourse?.title?.trim() || "course_summaries")
          .replace(/[\\/:*?"<>|]+/g, "_");
        await window.html2pdf()
          .set({
            margin: [12, 10, 12, 10],
            filename: fileBase + "_summaries.pdf",
            image: { type: "jpeg", quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
            pagebreak: { mode: ["css", "legacy"] },
          })
          .from(mount.firstElementChild || mount)
          .save();
        this.exportDialogOpen = false;
        this._toast("PDF exported", "success");
      } catch (e) {
        this._toast(e?.message || "Export failed", "error");
      } finally {
        if (mount && mount.parentNode) mount.parentNode.removeChild(mount);
        this.exportingPdf = false;
      }
    },

    async saveEdit() {
      if (this.saving) return;
      this.saving = true;
      try {
        const creds = _loadCreds();
        if (!creds) throw new Error("Not authenticated");
        ICS.db.updateSummary(this.currentLecture.sub_id, this.editText);
        var dbBytes = ICS.db.exportDB();
        var pw = ICS.crypto.buildPassword(creds);
        var compressed = await _gzip(dbBytes);
        var enc = await ICS.crypto.encrypt(compressed, pw, this.iterations);
        const sha = await ICS.github.getLatestCommitSha(this.repoOwner, this.repoName, this.dataBranch, creds.token);
        this.commitSha = await ICS.github.pushEncryptedDB(
          this.repoOwner, this.repoName, this.dataBranch, creds.token, enc, sha
        );
        // Update cache with new DB state
        await _idbPut("db_cache", { sha: this.commitSha, dbBytes: ICS.db.exportDB() });
        this.currentLecture = ICS.db.getLecture(this.currentLecture.sub_id);
        this.goBack();
        this._toast("Saved successfully", "success");
      } catch (e) { this._toast(e.message, "error"); }
      finally { this.saving = false; }
    },

    _searchTimeout: null,
    doSearch() {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = setTimeout(() => {
        this.searchResults = this.searchQuery.trim() ? ICS.db.searchSummaries(this.searchQuery) : [];
      }, 300);
    },

    async refresh() {
      const c = _loadCreds();
      if (c) { await this._loadDB(c); this._toast("Refreshed", "success"); }
    },

    async testAndSave() {
      this.setupTesting = true; this.setupError = "";
      try {
        const { data, commitSha, compressed } = await ICS.github.fetchEncryptedDB(
          this.repoOwner, this.repoName, this.dataBranch, this.setup.token
        );
        var decrypted = await ICS.crypto.decrypt(data, ICS.crypto.buildPassword(this.setup), this.iterations);
        if (compressed) decrypted = await _gunzip(decrypted);
        _saveCreds({ ...this.setup });
        _saveSettings({ owner: this.repoOwner, repo: this.repoName, branch: this.dataBranch, iterations: this.iterations });
        this.commitSha = commitSha;
        await this._loadDB({ ...this.setup });
      } catch (e) { this.setupError = e.message; }
      finally { this.setupTesting = false; }
    },

    openSettings() {
      this.settingsForm = { ...(_loadCreds() || {}) };
      this.showSecrets = {};
      this.navigate("settings");
    },
    async saveSettingsAndReload() {
      _saveCreds({ ...this.settingsForm });
      _saveSettings({ owner: this.repoOwner, repo: this.repoName, branch: this.dataBranch, iterations: this.iterations });
      this._toast("Saved. Reloading...", "success");
      const c = _loadCreds();
      if (c) await this._loadDB(c);
    },
    clearAllData() {
      if (!confirm("Clear all saved credentials?")) return;
      localStorage.removeItem(_LS + "creds");
      localStorage.removeItem(_LS + "settings");
      indexedDB.deleteDatabase(_idbName);
      this.view = "setup";
      this.setup = { token: "", stuid: "", uispsw: "", dashscope: "", smtp: "" };
    },

    _toast(msg, type) {
      this.toast = msg; this.toastType = type || "success";
      setTimeout(() => { this.toast = null; }, 3000);
    },

    // Template helpers
    renderMd(s) { return ICS.render.renderMarkdown(s); },
    activateKaTeX(el) { ICS.render.activateKaTeX(el); },
    snippet(s, n) { return ICS.render.plainSnippet(s, n); },
    highlight(text, q) { return _highlightSnippet(text, q); },
    relTime(s) { return _relativeTime(s); },
  }));
});
