/* ModList-Weaver v2.5 前端交互逻辑
 *
 * 架构：
 *   - 侧边栏：折叠状态 localStorage 持久化、事件委托双按钮
 *   - 导航：分组（工作流 A/B/C、运维 D、更多 F 关于 / G 设置）
 *   - 页面 A/B 为向导（B 为四步：清单 → 预览勾选 → 目标配置 → 确认下载）；页面 C 模组列表；
 *     页面 D 任务中心（进行中 / 已完成 + 结算页）；页面 H 设置（并发 / 限速 / 主题）
 *   - 通信：Fetch 调用 FastAPI HTTP 接口；MC 版本统一从 /api/mc_versions 下拉选择
 *   - 日志：任务行提供「查看日志 / 导出日志」，不再内嵌刷新；日志归档于 cache/logs
 *   - 主题：明暗切换持久化于 localStorage，并同步服务端设置（theme）
 */

const API = "/api";

// ================================================================
// 通用工具
// ================================================================
async function postJSON(url, body) {
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.detail || `请求失败 (${resp.status})`);
    }
    return data;
}

async function getJSON(url) {
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.detail || `请求失败 (${resp.status})`);
    }
    return data;
}

let toastTimer = null;
function toast(msg, type = "") {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show " + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast " + type; }, 2800);
}

function setStatus(text, type = "") {
    const el = document.getElementById("headerStatus");
    if (!el) return;
    el.className = "appbar-status " + (type || "");
    const span = el.querySelectorAll("span");
    if (span[1]) span[1].textContent = text;
}

function formatBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}

function formatCount(n) {
    n = n || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + " 亿";
    if (n >= 10000) return (n / 10000).toFixed(1) + " 万";
    return String(n);
}

function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// ================================================================
// 侧边栏：折叠（localStorage 持久化 + 事件委托双按钮）
// ================================================================
const SIDEBAR_KEY = "mlw_sidebar_collapsed";

function applySidebarState(collapsed) {
    const shell = document.getElementById("appShell");
    if (collapsed) shell.classList.add("sidebar-collapsed");
    else shell.classList.remove("sidebar-collapsed");
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch (_) {}
}

function toggleSidebar() {
    const shell = document.getElementById("appShell");
    applySidebarState(!shell.classList.contains("sidebar-collapsed"));
}

try {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    applySidebarState(stored === "1");
} catch (_) {}

// ================================================================
// 主题（明 / 暗）：localStorage 偏好 + 服务端设置，三态 auto/light/dark
// ================================================================
const THEME_KEY = "mlw_theme";

function systemDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(pref) {
    if (pref === "light") return "light";
    if (pref === "dark") return "dark";
    return systemDark() ? "dark" : "light";
}

let themePref = "auto";
try { themePref = localStorage.getItem(THEME_KEY) || "auto"; } catch (_) {}

function applyTheme(pref) {
    themePref = pref || themePref;
    const resolved = resolveTheme(themePref);
    const icon = document.getElementById("themeIcon");
    if (icon) {
        icon.innerHTML = resolved === "dark"
            ? `<path d="M12 3a9 9 0 1 0 9 9c0-4.97-4.03-9-9-9z"/>`
            : `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
    }
    document.documentElement.setAttribute("data-theme", resolved);
    try { localStorage.setItem(THEME_KEY, themePref); } catch (_) {}
    const sel = document.getElementById("setTheme");
    if (sel) sel.value = themePref;
}

function toggleTheme() {
    const next = resolveTheme(themePref) === "dark" ? "light" : "dark";
    applyTheme(next);
    postJSON(`${API}/settings`, { theme: next }).catch(() => {});
}

document.getElementById("themeToggle").addEventListener("click", toggleTheme);

if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (themePref === "auto") applyTheme("auto");
    });
}
applyTheme(themePref);

// ================================================================
// 页面切换（面包屑同步）
// ================================================================
const PAGE_TITLES = {
    pageA: "扫描 & 导出清单",
    pageB: "批量下载模组",
    pageC: "模组列表",
    pageE: "本地模组",
    pageD: "任务中心",
    pageF: "关于",
    pageH: "设置",
};

// 面包屑根节点：按页面所属分组动态显示
const PAGE_GROUP = {
    pageA: "工作流",
    pageB: "工作流",
    pageC: "工作流",
    pageE: "工作流",
    pageD: "运维",
    pageF: "更多",
    pageH: "更多",
};

const state = {
    currentPage: "pageA",
    prevPage: "pageA",
    scannedMods: [],
    wizardStep: 1,
    bStep: 1,
    bpItems: [],       // 批量预览清单（勾选状态）
    detailPid: null,
    catDetail: false,
    selectedTaskId: null,
    settleTaskId: null,   // 结算页当前任务（已完成历史）
    logModalTid: null,    // 日志弹窗当前任务
    logModalTimer: null,
    updateMap: {},        // project_id -> 更新信息（检查更新结果，V3.1）
    wasDownloading: false, // 是否有任务进行中（完成通知判定，V3.2）
    manMods: [],          // 本地模组管理（页面 E）：扫描结果（V3.3）
    manUpdateMap: {},     // 页面 E：project_id -> 更新信息（V3.3）
};

// 模组列表页（页面 C）：搜索状态
const CAT_PAGE_SIZE = 12;
const catalogState = {
    query: "",
    loader: "",
    type: "",
    page: 1,
    total: 0,
    loaded: false,
};

// 下载偏好（详情页下载表单记忆，localStorage 持久化）
function loadPref() {
    const p = { mc: "", loader: "fabric", saveDir: "" };
    try {
        const raw = localStorage.getItem("mlw_pref");
        if (raw) Object.assign(p, JSON.parse(raw));
    } catch (_) {}
    return p;
}
const pref = loadPref();
function savePref(mc, loader, saveDir) {
    pref.mc = mc;
    pref.loader = loader;
    pref.saveDir = saveDir;
    try { localStorage.setItem("mlw_pref", JSON.stringify(pref)); } catch (_) {}
}
const LOADER_LABELS = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", quilt: "Quilt" };

function switchPage(pageId) {
    state.currentPage = pageId;
    document.querySelectorAll(".nav-item").forEach(n => {
        n.classList.toggle("active", n.dataset.page === pageId);
    });
    document.querySelectorAll(".page").forEach(p => {
        p.classList.toggle("active", p.id === pageId);
    });
    const root = document.getElementById("breadcrumbRoot");
    if (root) root.textContent = PAGE_GROUP[pageId] || "工作台";
    const bc = document.getElementById("breadcrumbCurrent");
    if (bc) bc.textContent = PAGE_TITLES[pageId] || "";
    if (pageId === "pageA") {
        const step = state.scannedMods.length ? (state.wizardStep || 1) : 1;
        showWizardStep(step, true);
    }
    if (pageId === "pageB") {
        showBStep(state.bStep || 1, true);
    }
    if (pageId === "pageC") {
        showCView(state.catDetail ? "detail" : "list");
        // 首次进入自动分页浏览模组目录
        if (!state.catDetail && !catalogState.loaded) searchCatalog(1);
    }
    if (pageId === "pageE") {
        // 预填目标版本 / 加载器（V3.3：本地模组管理）
        const mc = document.getElementById("manMc");
        const ldr = document.getElementById("manLoader");
        if (mc && !mc.value) mc.value = pref.mc || "";
        if (ldr) ldr.value = pref.loader || "fabric";
    }
    if (pageId === "pageD") {
        showQueueView(state.settleTaskId ? "settle" : "list");
    }
    if (pageId === "pageH") {
        loadSettings();
        refreshStorageInfo();
    }
}

// 页面 C 子视图切换
function showCView(view) {
    const list = document.getElementById("catListView");
    const detail = document.getElementById("catDetailView");
    if (!list || !detail) return;
    list.style.display = view === "list" ? "" : "none";
    detail.style.display = view === "detail" ? "" : "none";
}

// 页面 D 子视图切换：任务列表 / 结算页
function showQueueView(view) {
    const list = document.getElementById("dqListView");
    const settle = document.getElementById("dqSettleView");
    if (!list || !settle) return;
    list.style.display = view === "list" ? "" : "none";
    settle.style.display = view === "settle" ? "" : "none";
    const bc = document.getElementById("breadcrumbCurrent");
    if (view === "settle" && bc) bc.textContent = "任务结算";
}

// ================================================================
// MC 版本下拉（/api/mc_versions → datalist）
// ================================================================
let mcVersionsLoaded = false;

async function loadMcVersions() {
    const dl = document.getElementById("mcVersionsList");
    if (!dl || mcVersionsLoaded) return;
    mcVersionsLoaded = true;
    try {
        const data = await getJSON(`${API}/mc_versions`);
        const versions = data.versions || [];
        if (!versions.length) return;
        // 正式版优先置顶，其余按返回顺序（已按时间倒序）
        const releases = versions.filter(v => v.type === "release");
        const rest = versions.filter(v => v.type !== "release");
        const opts = [...releases, ...rest].map(v =>
            `<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}${v.type !== "release" ? "（快照）" : ""}</option>`);
        dl.innerHTML = opts.join("");
    } catch (_) {
        mcVersionsLoaded = false; // 失败可下次重试
    }
}

// 全局事件委托：折叠按钮 / 导航 / 队列列表 / 模组列表 / 搜索结果
document.addEventListener("click", (e) => {
    const t = e.target.closest("#sidebarToggle, #sidebarToggle2");
    if (t) {
        e.preventDefault();
        toggleSidebar();
        return;
    }
    const nav = e.target.closest(".nav-item");
    if (nav) {
        e.preventDefault();
        state.catDetail = false; // 导航点击始终回到列表视图
        switchPage(nav.dataset.page);
        return;
    }
});

// ================================================================
// 页面 A：扫描 & 导出 三步向导
// ================================================================
const WIZARD_VIEWS = { 1: "step-scan", 2: "step-select", 3: "step-export" };

function showWizardStep(n, silent) {
    state.wizardStep = n;
    Object.entries(WIZARD_VIEWS).forEach(([step, id]) => {
        document.getElementById(id).classList.toggle("active", Number(step) === n);
    });
    document.querySelectorAll("#wizardSteps .wstep").forEach(el => {
        const step = Number(el.dataset.step);
        el.classList.toggle("active", step === n);
        el.classList.toggle("done", step < n);
    });
    const btnScanNext = document.getElementById("btnScanNext");
    if (btnScanNext) btnScanNext.disabled = !state.scannedMods.length;
    if (n === 2) {
        renderModList(state.scannedMods);
    } else if (n === 3) {
        updateSelCount();
    }
    if (!silent) {
        const titles = { 1: "扫描模组目录", 2: "勾选模组", 3: "导出清单" };
        setStatus("步骤 " + n + "：" + titles[n], "");
    }
}

// 步骤指示器点击
document.getElementById("wizardSteps").addEventListener("click", (e) => {
    const ws = e.target.closest(".wstep");
    if (!ws) return;
    const step = Number(ws.dataset.step);
    if (step > 1 && !state.scannedMods.length) {
        toast("请先在步骤 1 完成扫描", "err");
        return;
    }
    showWizardStep(step);
});

document.getElementById("btnScanNext").addEventListener("click", () => {
    if (!state.scannedMods.length) { toast("请先扫描模组", "err"); return; }
    showWizardStep(2);
});
document.getElementById("btnSelPrev").addEventListener("click", () => showWizardStep(1));
document.getElementById("btnSelNext").addEventListener("click", () => {
    if (!state.scannedMods.length) { toast("请先扫描模组", "err"); return; }
    showWizardStep(3);
});
document.getElementById("btnExpPrev").addEventListener("click", () => showWizardStep(2));

// ---------- 步骤 1：扫描 ----------
document.getElementById("btnBrowseScan").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_folder?title=选择旧版本 mods 目录`);
    if (data.folder) document.getElementById("scanFolder").value = data.folder;
});

document.getElementById("btnScan").addEventListener("click", async () => {
    const folder = document.getElementById("scanFolder").value.trim();
    if (!folder) { toast("请先选择 mods 目录", "err"); return; }
    const btn = document.getElementById("btnScan");
    btn.disabled = true;
    setStatus("扫描中…", "busy");
    toast("正在扫描模组并反查 Modrinth…");
    try {
        const data = await postJSON(`${API}/scan_mods`, { folder });
        state.scannedMods = (data.mods || []).map((m, i) => Object.assign(m, { _idx: i, selected: false }));
        document.getElementById("statTotal").textContent = data.total;
        document.getElementById("statMatched").textContent = data.matched;
        document.getElementById("statUnmatched").textContent = data.unmatched;
        setStatus("就绪");
        toast(`扫描完成：${data.matched}/${data.total} 已识别`, "ok");
        showWizardStep(2);
    } catch (e) {
        setStatus("就绪");
        toast("扫描失败：" + e.message, "err");
    } finally {
        btn.disabled = false;
    }
});

// ---------- 步骤 2：勾选模组 ----------
function openSourcePage(pid, source) {
    if (!pid) return;
    getJSON(`${API}/project_page?project_id=${encodeURIComponent(pid)}${source ? "&source=" + encodeURIComponent(source) : ""}`)
        .then(r => {
            if (r && r.url) window.open(r.url, "_blank");
            else toast("未找到源页面", "err");
        })
        .catch(e => toast("打开源页面失败：" + e.message, "err"));
}

function renderModList(mods) {
    const box = document.getElementById("modList");
    if (!mods.length) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">暂无扫描结果</div>
                <div class="empty-state-desc">请先在步骤 1 扫描 mods 目录。</div>
            </div>`;
        updateSelCount();
        return;
    }
    // 未识别（标灰）模组置顶显示
    const list = [...mods].sort((a, b) => (a.matched ? 1 : 0) - (b.matched ? 1 : 0));
    box.innerHTML = list.map(m => {
        const cls = m.matched ? "" : "unmatched";
        const badge = m.matched
            ? `<span class="m-badge ok">已识别</span>`
            : `<span class="m-badge no">未识别</span>`;
        const upd = m.matched ? state.updateMap[m.project_id] : null;
        const updBadge = upd
            ? `<span class="m-badge upd" title="当前 ${escapeHtml(upd.current_version)} → 最新 ${escapeHtml(upd.latest_version)}${upd.changelog ? "\n" + escapeHtml(upd.changelog) : ""}">有更新 ${escapeHtml(upd.latest_version)}</span>`
            : `<span class="m-badge no" style="visibility:hidden">有更新</span>`;
        const pid = m.project_id
            ? `<span class="m-pid">${m.project_id}</span>`
            : `<span class="m-pid">本地模组</span>`;
        const name = (m.metadata && (m.metadata.name || m.metadata.mod_id)) || m.filename;
        const checked = m.selected ? "checked" : "";
        const disabled = m.matched ? "" : "disabled";
        const clickable = m.matched ? ` data-pid="${m.project_id}"` : "";
        return `<div class="mod-item ${cls}"${clickable}>
            <input type="checkbox" class="m-check" ${checked} ${disabled} data-idx="${m._idx}" />
            <span class="m-name" title="${escapeHtml(m.filename)}">${escapeHtml(name)}</span>
            ${pid}
            <span class="m-pid">${escapeHtml((m.metadata && m.metadata.loader) || "?")}</span>
            ${badge}
            ${updBadge}
            <span class="m-size">${formatBytes(m.size)}</span>
            <span class="m-open">
                ${m.matched ? `<button class="m-ext" title="打开源页面" data-ext="${escapeHtml(m.project_id)}" data-src="${escapeHtml(m.source || "")}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                </button>` : ""}
                <span class="m-open-chev">›</span>
            </span>
        </div>`;
    }).join("");
    box.querySelectorAll(".m-check").forEach(cb => {
        cb.addEventListener("change", () => {
            state.scannedMods[Number(cb.dataset.idx)].selected = cb.checked;
            updateSelCount();
        });
    });
    updateSelCount();
}

document.getElementById("modList").addEventListener("click", (e) => {
    const ext = e.target.closest(".m-ext");
    if (ext) {
        e.stopPropagation();
        openSourcePage(ext.dataset.ext, ext.dataset.src);
        return;
    }
    const item = e.target.closest(".mod-item");
    if (!item || e.target.closest(".m-check")) return;
    const pid = item.dataset.pid;
    if (pid) {
        openDetail(pid);
    } else {
        toast("未识别模组无法查看详情", "err");
    }
});

function updateSelCount() {
    const matched = state.scannedMods.filter(m => m.matched);
    const selected = matched.filter(m => m.selected);
    const selEl = document.getElementById("selCount");
    if (selEl) selEl.textContent = selected.length;
    const totalEl = document.getElementById("selTotal");
    if (totalEl) totalEl.textContent = matched.length;
    const btnNext = document.getElementById("btnSelNext");
    if (btnNext) btnNext.textContent = selected.length
        ? `下一步：导出清单（${selected.length}）`
        : "下一步：导出清单";
}

document.getElementById("btnSelectAll").addEventListener("click", () => {
    state.scannedMods.forEach(m => { if (m.matched) m.selected = true; });
    renderModList(state.scannedMods);
});
document.getElementById("btnSelectNone").addEventListener("click", () => {
    state.scannedMods.forEach(m => { m.selected = false; });
    renderModList(state.scannedMods);
});
document.getElementById("btnSelectInvert").addEventListener("click", () => {
    state.scannedMods.forEach(m => { if (m.matched) m.selected = !m.selected; });
    renderModList(state.scannedMods);
});

// ---------- 步骤 2：更新检测（V3.1） ----------
document.getElementById("btnCheckUpdates").addEventListener("click", checkUpdates);

async function checkUpdates() {
    const mods = state.scannedMods
        .filter(m => m.matched && m.project_id)
        .map(m => ({
            project_id: m.project_id,
            version_id: m.version_id,
            version_number: m.version_number,
            version_name: m.version_name,
            source: m.source,
            name: (m.metadata && (m.metadata.name || m.metadata.mod_id)) || m.filename,
        }));
    if (!mods.length) { toast("没有可检测的已识别模组", "err"); return; }
    const btn = document.getElementById("btnCheckUpdates");
    if (btn) { btn.disabled = true; btn.textContent = "检测中…"; }
    try {
        const data = await postJSON(`${API}/check_updates`, { mods });
        state.updateMap = {};
        (data.updates || []).forEach(u => { state.updateMap[u.project_id] = u; });
        renderModList(state.scannedMods);
        const n = data.update_count || 0;
        const cnt = document.getElementById("updateCount");
        if (cnt) cnt.textContent = n ? `${n} 个有新版本` : "全部最新";
        toast(n ? `发现 ${n} 个模组有新版本` : "所有已识别模组均是最新版本", n ? "" : "ok");
    } catch (e) {
        toast("检查更新失败：" + e.message, "err");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "检查更新"; }
    }
}

// ---------- 步骤 3：导出 ----------
document.getElementById("btnBrowseExport").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_save?title=保存 modlist&filename=modlist.json&ext=json`);
    if (data.path) document.getElementById("exportPath").value = data.path;
});

document.getElementById("btnExport").addEventListener("click", async () => {
    const selected = state.scannedMods.filter(m => m.matched && m.selected);
    if (!selected.length) { toast("请先勾选要导出的模组", "err"); return; }

    let savePath = document.getElementById("exportPath").value.trim();
    if (!savePath) {
        const picked = await getJSON(`${API}/pick_save?title=保存 modlist&filename=modlist.json&ext=json`);
        if (!picked.path) return; // 用户取消
        savePath = picked.path;
        document.getElementById("exportPath").value = savePath;
    }

    const btn = document.getElementById("btnExport");
    btn.disabled = true;
    try {
        const data = await postJSON(`${API}/export_json`, {
            mods: selected,
            game_version: document.getElementById("exportMc").value.trim(),
            loader: document.getElementById("exportLoader").value,
            save_path: savePath,
        });
        toast(`已导出 ${data.count} 个模组 → ${data.save_path}`, "ok");
    } catch (e) {
        toast("导出失败：" + e.message, "err");
    } finally {
        btn.disabled = false;
    }
});

// ================================================================
// 页面 B：批量下载（四步向导：清单 → 预览勾选 → 目标配置 → 确认下载）
// ================================================================
const B_WIZARD_VIEWS = {
    1: "b-step-file",
    2: "b-step-preview",
    3: "b-step-config",
    4: "b-step-go",
};

function showBStep(n, silent) {
    state.bStep = n;
    Object.entries(B_WIZARD_VIEWS).forEach(([step, id]) => {
        document.getElementById(id).classList.toggle("active", Number(step) === n);
    });
    document.querySelectorAll("#wizardBSteps .wstep").forEach(el => {
        const step = Number(el.dataset.step);
        el.classList.toggle("active", step === n);
        el.classList.toggle("done", step < n);
    });
    if (n === 2) {
        loadPreviewList();
    }
    if (n === 4) {
        document.getElementById("cfJsonPath").textContent = document.getElementById("jsonPath").value.trim() || "—";
        const sel = state.bpItems.filter(p => p.selected);
        document.getElementById("cfCount").textContent = sel.length ? sel.length + " 个" : "—";
        document.getElementById("cfMc").textContent = document.getElementById("batchMc").value.trim() || "—";
        document.getElementById("cfLoader").textContent = LOADER_LABELS[document.getElementById("batchLoader").value] || "—";
        document.getElementById("cfSaveDir").textContent = document.getElementById("batchSaveDir").value.trim() || "—";
    }
    if (!silent) {
        const titles = { 1: "选择清单文件", 2: "预览并勾选模组", 3: "目标配置", 4: "确认并下载" };
        setStatus("步骤 " + n + "：" + titles[n], "");
    }
}

document.getElementById("wizardBSteps").addEventListener("click", (e) => {
    const ws = e.target.closest(".wstep");
    if (!ws) return;
    const step = Number(ws.dataset.step);
    if (step > 1 && !document.getElementById("jsonPath").value.trim()) {
        toast("请先选择清单文件", "err");
        return;
    }
    if (step === 3 && !validBConfig()) return;
    if (step === 4 && !validBConfig()) return;
    showBStep(step);
});

document.getElementById("jsonPath").addEventListener("input", () => {
    document.getElementById("btnBStepNext").disabled = !document.getElementById("jsonPath").value.trim();
});

document.getElementById("btnBStepNext").addEventListener("click", () => {
    if (!document.getElementById("jsonPath").value.trim()) { toast("请选择 modlist.json", "err"); return; }
    showBStep(2);
});
document.getElementById("btnBPNext").addEventListener("click", () => {
    if (!state.bpItems.some(p => p.selected)) { toast("请至少勾选一个模组", "err"); return; }
    showBStep(3);
});
document.getElementById("btnBPPrev").addEventListener("click", () => showBStep(1));
document.getElementById("btnBStepPrev").addEventListener("click", () => showBStep(2));
document.getElementById("btnBGoPrev").addEventListener("click", () => showBStep(3));
document.getElementById("btnBStepGo").addEventListener("click", () => {
    if (!validBConfig()) return;
    showBStep(4);
});

function validBConfig() {
    const mc = document.getElementById("batchMc").value.trim();
    const saveDir = document.getElementById("batchSaveDir").value.trim();
    if (!mc) { toast("请选择或输入目标游戏版本", "err"); return false; }
    if (!saveDir) { toast("请填写模组保存目录", "err"); return false; }
    return true;
}

document.getElementById("btnBrowseJson").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_file?title=选择 modlist.json&ext=json`);
    if (data.path) {
        document.getElementById("jsonPath").value = data.path;
        document.getElementById("btnBStepNext").disabled = false;
    }
});

document.getElementById("btnBrowseBatchDir").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_folder?title=选择模组保存目录`);
    if (data.folder) document.getElementById("batchSaveDir").value = data.folder;
});

// ---------- 步骤 2：预览并勾选 ----------
async function loadPreviewList() {
    const jsonPath = document.getElementById("jsonPath").value.trim();
    if (!jsonPath) return;
    const box = document.getElementById("bpList");
    box.innerHTML = `
        <div class="empty-state compact">
            <div class="empty-state-title">正在加载清单…</div>
        </div>`;
    try {
        const data = await postJSON(`${API}/preview_list`, { json_path: jsonPath });
        state.bpItems = (data.projects || []).map(p => Object.assign(p, { selected: true }));
        renderPreviewList();
    } catch (e) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">清单解析失败</div>
                <div class="empty-state-desc">${escapeHtml(e.message)}</div>
            </div>`;
    }
}

function renderPreviewList() {
    const box = document.getElementById("bpList");
    const items = state.bpItems;
    if (!items.length) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">清单中没有可下载的模组</div>
            </div>`;
    } else {
        box.innerHTML = items.map((p, i) => `
            <div class="mod-item" data-bpidx="${i}">
                <input type="checkbox" class="m-check" data-bpidx="${i}" ${p.selected ? "checked" : ""} />
                <span class="m-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
                <span class="m-pid">${escapeHtml(p.project_id)}</span>
                <span class="m-pid">${escapeHtml(p.version_number || "")}</span>
                <span class="m-size">${escapeHtml(p.filename || "")}</span>
            </div>`).join("");
        box.querySelectorAll(".m-check").forEach(cb => {
            cb.addEventListener("change", () => {
                state.bpItems[Number(cb.dataset.bpidx)].selected = cb.checked;
                updateBPCount();
            });
        });
    }
    updateBPCount();
}

function updateBPCount() {
    const total = state.bpItems.length;
    const sel = state.bpItems.filter(p => p.selected).length;
    const selEl = document.getElementById("bpSelCount");
    if (selEl) selEl.textContent = sel;
    const totalEl = document.getElementById("bpSelTotal");
    if (totalEl) totalEl.textContent = total;
    const info = document.getElementById("bpInfo");
    if (info) info.textContent = `共 ${total} 项`;
    const btn = document.getElementById("btnBPNext");
    if (btn) btn.disabled = !sel;
}

document.getElementById("bpList").addEventListener("click", (e) => {
    if (e.target.closest(".m-check")) return;
    const item = e.target.closest(".mod-item");
    if (!item || item.dataset.bpidx == null) return;
    const idx = Number(item.dataset.bpidx);
    state.bpItems[idx].selected = !state.bpItems[idx].selected;
    renderPreviewList();
});

document.getElementById("btnBPAll").addEventListener("click", () => {
    state.bpItems.forEach(p => { p.selected = true; });
    renderPreviewList();
});
document.getElementById("btnBPNone").addEventListener("click", () => {
    state.bpItems.forEach(p => { p.selected = false; });
    renderPreviewList();
});
document.getElementById("btnBPInvert").addEventListener("click", () => {
    state.bpItems.forEach(p => { p.selected = !p.selected; });
    renderPreviewList();
});

document.getElementById("btnBatchDownload").addEventListener("click", async () => {
    const jsonPath = document.getElementById("jsonPath").value.trim();
    const mcVersion = document.getElementById("batchMc").value.trim();
    const loader = document.getElementById("batchLoader").value;
    const saveDir = document.getElementById("batchSaveDir").value.trim();
    const projectIds = state.bpItems.filter(p => p.selected).map(p => p.project_id);
    if (!jsonPath) { toast("请选择 modlist.json", "err"); return; }
    if (!mcVersion) { toast("请选择或输入目标游戏版本", "err"); return; }
    if (!saveDir) { toast("请填写保存目录", "err"); return; }
    if (!projectIds.length) { toast("请至少勾选一个模组", "err"); return; }

    const btn = document.getElementById("btnBatchDownload");
    btn.disabled = true;
    try {
        const data = await postJSON(`${API}/download_from_list`, {
            json_path: jsonPath, mc_version: mcVersion, loader, save_dir: saveDir,
            project_ids: projectIds,
        });
        toast(data.queued ? "已加入下载队列排队" : "批量下载已启动", "ok");
        switchPage("pageD");
    } catch (e) {
        toast("启动失败：" + e.message, "err");
    } finally {
        btn.disabled = false;
    }
});

// ================================================================
// 页面 C：模组列表（分页 / 筛选 / 搜索 / 详情下载）
// ================================================================
document.getElementById("btnCatSearch").addEventListener("click", () => searchCatalog(1));
document.getElementById("catQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchCatalog(1);
});
document.getElementById("btnCatPrev").addEventListener("click", () => searchCatalog(catalogState.page - 1));
document.getElementById("btnCatNext").addEventListener("click", () => searchCatalog(catalogState.page + 1));

async function searchCatalog(page) {
    catalogState.query = document.getElementById("catQuery").value.trim();
    catalogState.loader = document.getElementById("catLoader").value;
    catalogState.type = document.getElementById("catType").value;
    catalogState.page = page || 1;

    const btn = document.getElementById("btnCatSearch");
    btn.disabled = true;
    setStatus("搜索中…", "busy");
    try {
        const data = await postJSON(`${API}/search_mod`, {
            query: catalogState.query,
            loader: catalogState.loader || null,
            project_type: catalogState.type || null,
            limit: CAT_PAGE_SIZE,
            offset: (catalogState.page - 1) * CAT_PAGE_SIZE,
        });
        catalogState.total = data.total_hits || 0;
        catalogState.loaded = true;
        renderCatalog(data.hits || []);
        setStatus("就绪");
    } catch (e) {
        setStatus("就绪");
        toast("搜索失败：" + e.message, "err");
    } finally {
        btn.disabled = false;
    }
}

function renderCatalog(hits) {
    const box = document.getElementById("modCatalog");
    document.getElementById("catInfo").textContent = catalogState.total
        ? `共 ${formatCount(catalogState.total)} 条结果`
        : "未找到匹配的模组";
    document.getElementById("catTotal").textContent = formatCount(catalogState.total);
    document.getElementById("catCurPage").textContent = catalogState.page;

    const pages = Math.max(1, Math.ceil(catalogState.total / CAT_PAGE_SIZE));
    document.getElementById("catPageNum").textContent = catalogState.page;
    document.getElementById("catPageTotal").textContent = pages;
    document.getElementById("btnCatPrev").disabled = catalogState.page <= 1;
    document.getElementById("btnCatNext").disabled = catalogState.page >= pages;

    if (!hits.length) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">未找到匹配的模组</div>
                <div class="empty-state-desc">请尝试更精确的关键词，或直接输入 project ID 精确搜索。</div>
            </div>`;
        return;
    }

    box.innerHTML = hits.map(h => {
        const icon = h.icon_url
            ? `<img class="cat-icon" src="${escapeHtml(h.icon_url)}" onerror="this.style.display='none'" />`
            : `<div class="cat-icon cat-icon-ph">${escapeHtml((h.title || "?").charAt(0).toUpperCase())}</div>`;
        const cats = (h.categories || []).slice(0, 4).map(c =>
            `<span class="chip">${escapeHtml(c)}</span>`).join("");
        const ld = (h.loaders && h.loaders[0])
            ? `<span class="chip chip-loader">${escapeHtml(h.loaders[0])}</span>` : "";
        const pid = h.project_id ? ` · <span class="m-pid">${escapeHtml(h.project_id)}</span>` : "";
        return `<div class="cat-item" data-pid="${escapeHtml(h.project_id)}">
            ${icon}
            <div class="cat-main">
                <div class="cat-title">${escapeHtml(h.title)}</div>
                <div class="cat-desc">${escapeHtml(h.description || "").slice(0, 90)}</div>
                <div class="cat-tags">${cats}${ld}${pid}</div>
            </div>
            <div class="cat-meta">
                <span class="cat-stat"><b>${formatCount(h.downloads)}</b> 下载</span>
                <span class="cat-stat"><b>${formatCount(h.followers)}</b> 收藏</span>
            </div>
            <span class="cat-open">
                <button class="m-ext" title="打开源页面" data-ext="${escapeHtml(h.project_id)}" data-src="modrinth">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                </button>
                <span class="cat-open-chev">›</span>
            </span>
        </div>`;
    }).join("");
}

document.getElementById("modCatalog").addEventListener("click", (e) => {
    const ext = e.target.closest(".m-ext");
    if (ext) {
        e.stopPropagation();
        openSourcePage(ext.dataset.ext, ext.dataset.src);
        return;
    }
    const item = e.target.closest(".cat-item");
    if (item) openDetail(item.dataset.pid);
});

// ================================================================
// 模组详情（页面 C 子视图）
// ================================================================
function openDetail(pid) {
    state.catDetail = true;
    state.detailPid = pid;
    switchPage("pageC");
    loadDetail(pid);
}

document.getElementById("btnBackCatalog").addEventListener("click", () => {
    state.catDetail = false;
    showCView("list");
});

async function loadDetail(pid) {
    const box = document.getElementById("modDetail");
    box.innerHTML = `
        <div class="empty-state compact">
            <div class="empty-state-title">正在加载模组详情…</div>
        </div>`;
    try {
        const data = await getJSON(`${API}/project/${encodeURIComponent(pid)}`);
        lastDetail = data;
        renderDetail(box, data);
    } catch (e) {
        lastDetail = null;
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">加载详情失败</div>
                <div class="empty-state-desc">${escapeHtml(e.message)}</div>
            </div>`;
    }
}

let lastDetail = null;

function renderDetail(box, d) {
    const titleEl = document.getElementById("detailTitle");
    if (titleEl) titleEl.textContent = d.title || d.project_id;

    const cats = (d.categories || []).slice(0, 6).map(c =>
        `<span class="chip">${escapeHtml(c)}</span>`).join("");
    const loaders = (d.loaders || []).slice(0, 6).map(c =>
        `<span class="chip">${escapeHtml(c)}</span>`).join("");
    const authors = (d.authors || []).map(a => `
        <div class="author-item" title="${escapeHtml(a.role || "")}">
            <img class="author-avatar" src="${escapeHtml(a.avatar_url || "")}" onerror="this.style.display='none'" />
            <span class="author-name">${escapeHtml(a.name || "?")}</span>
        </div>`).join("") || `<span class="text-mute">暂无</span>`;

    const rvs = (d.versions || []).slice(0, 10).map(v => {
        const gv = (v.game_versions || []).slice(0, 4).join(", ");
        const lds = (v.loaders || []).join("/");
        const date = v.date_published ? v.date_published.slice(0, 10) : "—";
        const changelog = (v.changelog || "").trim();
        const cl = changelog
            ? `<div class="rv-changelog"><div class="rv-cl-box">${escapeHtml(changelog)}</div></div>`
            : "";
        return `<div class="rv-item${changelog ? " has-cl" : ""}" data-open="0">
            <span class="rv-chev${changelog ? "" : " none"}">›</span>
            <span class="chip mono">${escapeHtml(v.version_number || v.name || "—")}</span>
            <span class="rv-date">${escapeHtml(date)}</span>
            <span class="rv-tags">${escapeHtml(gv)}${lds ? " · " + escapeHtml(lds) : ""}</span>
            ${cl}
        </div>`;
    }).join("") || `<div class="empty-state compact"><div class="empty-state-title">暂无版本信息</div></div>`;

    const ldOpts = Object.entries(LOADER_LABELS).map(([v, label]) =>
        `<option value="${v}" ${pref.loader === v ? "selected" : ""}>${label}</option>`).join("");

    box.innerHTML = `
        <div class="card">
            <div class="card-body">
                <div class="d-header">
                    <img class="d-icon" src="${escapeHtml(d.icon_url || "")}" onerror="this.style.display='none'" />
                    <div class="d-head-main">
                        <div class="d-title-line">
                            <h3 class="d-title">${escapeHtml(d.title)}</h3>
                            <span class="chip">${escapeHtml(d.project_type || "mod")}</span>
                            <button class="btn btn-outline btn-sm" id="btnOpenSourcePage">源页面</button>
                        </div>
                        <div class="d-sub">${escapeHtml(d.project_id)}${d.slug ? " · " + escapeHtml(d.slug) : ""}</div>
                        <p class="d-desc">${escapeHtml(d.description || "（无简介）")}</p>
                        <div class="d-chips">${cats}${loaders}</div>
                    </div>
                    <div class="d-stats">
                        <div class="d-stat"><b>${formatCount(d.downloads)}</b><span>下载量</span></div>
                        <div class="d-stat"><b>${formatCount(d.followers)}</b><span>收藏</span></div>
                        <div class="d-stat"><b>${escapeHtml(d.license || "?")}</b><span>许可</span></div>
                        ${d.source_url ? `<a class="d-stat link" href="${escapeHtml(d.source_url)}" target="_blank"><b>源码</b><span>GitHub</span></a>` : ""}
                    </div>
                </div>
                <div class="d-authors">
                    <span class="d-label">作者</span>
                    <div class="author-list">${authors}</div>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="ch-title"><span class="ch-step">◈</span> 最近版本</div>
                <span class="ch-hint">最新 10 个版本</span>
            </div>
            <div class="card-body no-pad">
                <div class="rv-list">${rvs}</div>
            </div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="ch-title"><span class="ch-step">⇩</span> 下载该模组</div>
                <span class="ch-hint">自动解析并下载 required 前置依赖</span>
            </div>
            <div class="card-body">
                <div class="form-row form-row-grid">
                    <div class="form-field">
                        <label>项目 ID（自动填入）</label>
                        <input type="text" id="dlPid" class="input monospaced" value="${escapeHtml(d.project_id)}" readonly />
                    </div>
                    <div class="form-field">
                        <label>目标游戏版本</label>
                        <input type="text" id="dlMc" class="input" list="mcVersionsList" placeholder="选择或输入 MC 版本，如 1.21.1" value="${escapeHtml(pref.mc)}" />
                    </div>
                    <div class="form-field">
                        <label>目标加载器</label>
                        <select id="dlLoader" class="input">${ldOpts}</select>
                    </div>
                    <div class="form-field form-field-2col">
                        <label>保存目录</label>
                        <div class="input-group">
                            <input type="text" id="dlSaveDir" class="input" placeholder="模组保存目录" value="${escapeHtml(pref.saveDir)}" />
                            <button class="btn btn-outline" id="btnBrowseDlDir">浏览文件夹</button>
                        </div>
                    </div>
                </div>
                <div class="form-actions">
                    <button class="btn btn-primary btn-lg" id="btnDlDownload">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        下载该模组
                    </button>
                    <div class="field-hint">有任务执行中时将自动加入队列排队。</div>
                </div>
            </div>
        </div>`;
}

// 详情页：浏览目录 / 下载按钮 / 版本日志折叠（事件委托）
document.getElementById("modDetail").addEventListener("click", async (e) => {
    const rv = e.target.closest(".rv-item.has-cl");
    if (rv) {
        const open = rv.dataset.open === "1" ? "0" : "1";
        rv.dataset.open = open;
        const chev = rv.querySelector(".rv-chev");
        if (chev) chev.classList.toggle("open", open === "1");
        return;
    }
    const browse = e.target.closest("#btnBrowseDlDir");
    if (browse) {
        const data = await getJSON(`${API}/pick_folder?title=选择模组保存目录`);
        if (data.folder) document.getElementById("dlSaveDir").value = data.folder;
        return;
    }
    const ext = e.target.closest("#btnOpenSourcePage");
    if (ext) {
        if (lastDetail) openSourcePage(lastDetail.project_id, lastDetail.source);
        return;
    }
    const dl = e.target.closest("#btnDlDownload");
    if (dl) {
        const pid = document.getElementById("dlPid").value.trim();
        const mc = document.getElementById("dlMc").value.trim();
        const loader = document.getElementById("dlLoader").value;
        const saveDir = document.getElementById("dlSaveDir").value.trim();
        if (!mc) { toast("请填写目标游戏版本", "err"); return; }
        if (!saveDir) { toast("请填写保存目录", "err"); return; }
        savePref(mc, loader, saveDir);
        try {
            const data = await postJSON(`${API}/download_single_mod`, {
                project_id: pid, mc_version: mc, loader, save_dir: saveDir,
            });
            toast(data.queued ? "已加入下载队列排队" : "单模组下载已启动", "ok");
            switchPage("pageD");
        } catch (err) {
            toast("启动失败：" + err.message, "err");
        }
    }
});

// ================================================================
// 页面 E：本地模组管理（V3.3）——扫描 / 启用 / 禁用 / 删除 / 检查更新 / 一键更新
// ================================================================
document.getElementById("btnBrowseMan").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_folder?title=选择本地 mods 目录`);
    if (data.folder) document.getElementById("manFolder").value = data.folder;
});

document.getElementById("btnManScan").addEventListener("click", scanInstalledMods);

async function scanInstalledMods() {
    const folder = document.getElementById("manFolder").value.trim();
    if (!folder) { toast("请先选择 mods 目录", "err"); return; }
    const btn = document.getElementById("btnManScan");
    btn.disabled = true;
    setStatus("扫描中…", "busy");
    try {
        const data = await postJSON(`${API}/manage_scan`, { folder });
        state.manMods = (data.mods || []).map((m, i) => Object.assign(m, { _idx: i, selected: false }));
        state.manUpdateMap = {};
        const active = state.manMods.filter(m => !m.disabled).length;
        document.getElementById("manTotal").textContent = state.manMods.length;
        document.getElementById("manActive").textContent = active;
        document.getElementById("manDisabled").textContent = state.manMods.length - active;
        document.getElementById("manUpdates").textContent = 0;
        document.getElementById("btnManUpdate").disabled = true;
        const cnt = document.getElementById("manUpdateCount");
        if (cnt) cnt.textContent = "";
        renderManList();
        setStatus("就绪");
        toast(`扫描完成：${data.matched}/${data.total} 已识别`, "ok");
    } catch (e) {
        setStatus("就绪");
        toast("扫描失败：" + e.message, "err");
    } finally {
        btn.disabled = false;
    }
}

function renderManList() {
    const box = document.getElementById("manList");
    const mods = state.manMods;
    const info = document.getElementById("manInfo");
    if (info) info.textContent = mods.length ? `共 ${mods.length} 个模组文件` : "—";
    if (!mods.length) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">目录中没有模组文件</div>
                <div class="empty-state-desc">支持 jar 与 jar.disabled（已禁用）文件。</div>
            </div>`;
        updateManCount();
        return;
    }
    box.innerHTML = mods.map(m => {
        const cls = m.disabled ? "disabled" : (m.matched ? "" : "unmatched");
        const stateBadge = m.disabled
            ? `<span class="m-badge off">已禁用</span>`
            : `<span class="m-badge ok">已启用</span>`;
        const upd = m.matched ? state.manUpdateMap[m.project_id] : null;
        const updBadge = upd
            ? `<span class="m-badge upd" title="当前 ${escapeHtml(upd.current_version)} → 最新 ${escapeHtml(upd.latest_version)}${upd.changelog ? "\n" + escapeHtml(upd.changelog) : ""}">有更新 ${escapeHtml(upd.latest_version)}</span>`
            : `<span class="m-badge no" style="visibility:hidden">有更新</span>`;
        const pid = m.project_id
            ? `<span class="m-pid">${m.project_id}</span>`
            : `<span class="m-pid">本地模组</span>`;
        const name = (m.metadata && (m.metadata.name || m.metadata.mod_id)) || m.filename;
        const checked = m.selected ? "checked" : "";
        return `<div class="mod-item ${cls}">
            <input type="checkbox" class="m-check" ${checked} data-idx="${m._idx}" />
            <span class="m-name" title="${escapeHtml(m.filename)}">${escapeHtml(name)}</span>
            ${pid}
            <span class="m-pid">${escapeHtml((m.metadata && m.metadata.loader) || "?")}</span>
            ${stateBadge}
            ${updBadge}
            <span class="m-size">${formatBytes(m.size)}</span>
            <span class="m-open">
                ${m.matched ? `<button class="m-ext" title="打开源页面" data-ext="${escapeHtml(m.project_id)}" data-src="${escapeHtml(m.source || "")}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                </button>` : ""}
                ${m.matched ? `<button class="q-btn btn-text man-open" data-pid="${escapeHtml(m.project_id)}" title="查看详情">查看</button>` : ""}
            </span>
        </div>`;
    }).join("");
    box.querySelectorAll(".m-check").forEach(cb => {
        cb.addEventListener("change", () => {
            state.manMods[Number(cb.dataset.idx)].selected = cb.checked;
            updateManCount();
        });
    });
    updateManCount();
}

function updateManCount() {
    const sel = state.manMods.filter(m => m.selected).length;
    const selEl = document.getElementById("manSelCount");
    if (selEl) selEl.textContent = sel;
    const totalEl = document.getElementById("manSelTotal");
    if (totalEl) totalEl.textContent = state.manMods.length;
}

document.getElementById("manList").addEventListener("click", (e) => {
    const ext = e.target.closest(".m-ext");
    if (ext) {
        e.stopPropagation();
        openSourcePage(ext.dataset.ext, ext.dataset.src);
        return;
    }
    const dt = e.target.closest(".man-open");
    if (dt) {
        e.stopPropagation();
        openDetail(dt.dataset.pid);
    }
});

// ---------- 批量选中操作：全选 / 清空 / 反选 ----------
document.getElementById("btnManAll").addEventListener("click", () => {
    state.manMods.forEach(m => { m.selected = true; });
    renderManList();
});
document.getElementById("btnManNone").addEventListener("click", () => {
    state.manMods.forEach(m => { m.selected = false; });
    renderManList();
});
document.getElementById("btnManInvert").addEventListener("click", () => {
    state.manMods.forEach(m => { m.selected = !m.selected; });
    renderManList();
});

// ---------- 启用 / 禁用 / 删除 ----------
async function batchManAction(action) {
    const sel = state.manMods.filter(m => m.selected);
    if (!sel.length) { toast("请先勾选模组", "err"); return; }
    const folder = document.getElementById("manFolder").value.trim();
    if (!folder) { toast("缺少 mods 目录", "err"); return; }
    const label = { disable: "禁用", enable: "启用", delete: "删除" }[action] || action;
    let ok = 0, fail = 0;
    for (const m of sel) {
        try {
            await postJSON(`${API}/manage_mod`, { folder, filename: m.filename, action });
            ok++;
        } catch (e) {
            fail++;
            toast(`${label}失败：${m.filename} ${e.message}`, "err");
        }
    }
    toast(`已${label} ${ok} 个模组${fail ? `，失败 ${fail} 个` : ""}`, fail ? "warn" : "ok");
    await scanInstalledMods();
}

document.getElementById("btnManDisable").addEventListener("click", () => batchManAction("disable"));
document.getElementById("btnManEnable").addEventListener("click", () => batchManAction("enable"));
document.getElementById("btnManDelete").addEventListener("click", () => {
    const sel = state.manMods.filter(m => m.selected).length;
    if (!sel) { toast("请先勾选模组", "err"); return; }
    if (!confirm(`确认删除选中的 ${sel} 个模组文件？此操作不可恢复。`)) return;
    batchManAction("delete");
});

// ---------- 检查更新（复用 /api/check_updates） ----------
document.getElementById("btnManCheckUpdates").addEventListener("click", checkInstalledUpdates);

async function checkInstalledUpdates() {
    const mods = state.manMods
        .filter(m => m.matched && m.project_id && !m.disabled)
        .map(m => ({
            project_id: m.project_id,
            version_id: m.version_id,
            version_number: m.version_number,
            version_name: m.version_name,
            source: m.source,
            name: (m.metadata && (m.metadata.name || m.metadata.mod_id)) || m.filename,
        }));
    if (!mods.length) { toast("没有可检测的已识别模组", "err"); return; }
    const btn = document.getElementById("btnManCheckUpdates");
    if (btn) { btn.disabled = true; btn.textContent = "检测中…"; }
    try {
        const mc = document.getElementById("manMc").value.trim() || null;
        const loader = document.getElementById("manLoader").value;
        const data = await postJSON(`${API}/check_updates`, { mods, mc_version: mc, loader });
        state.manUpdateMap = {};
        (data.updates || []).forEach(u => { state.manUpdateMap[u.project_id] = u; });
        renderManList();
        const n = data.update_count || 0;
        document.getElementById("manUpdates").textContent = n;
        const cnt = document.getElementById("manUpdateCount");
        if (cnt) cnt.textContent = n ? `${n} 个可更新` : "全部最新";
        document.getElementById("btnManUpdate").disabled = !n;
        toast(n ? `发现 ${n} 个模组可更新` : "所有已识别模组均是最新版本", n ? "" : "ok");
    } catch (e) {
        toast("检查更新失败：" + e.message, "err");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "检查更新"; }
    }
}

// ---------- 一键更新（/api/download_updates） ----------
document.getElementById("btnManUpdate").addEventListener("click", downloadInstalledUpdates);

async function downloadInstalledUpdates() {
    const mc = document.getElementById("manMc").value.trim();
    const loader = document.getElementById("manLoader").value;
    const saveDir = document.getElementById("manFolder").value.trim();
    if (!mc) { toast("请填写目标游戏版本", "err"); return; }
    if (!saveDir) { toast("请选择 mods 目录", "err"); return; }
    const updates = Object.values(state.manUpdateMap).map(u => {
        const m = state.manMods.find(x => x.project_id === u.project_id);
        return {
            project_id: u.project_id,
            name: u.name || (m ? ((m.metadata && (m.metadata.name || m.metadata.mod_id)) || m.filename) : u.project_id),
            source: u.source || "auto",
            old_filename: m ? m.filename : "",
        };
    });
    if (!updates.length) { toast("没有可更新的模组", "err"); return; }
    if (!confirm(`确认更新 ${updates.length} 个模组？\n将下载最新适配版本并移除旧文件。`)) return;
    const btn = document.getElementById("btnManUpdate");
    btn.disabled = true;
    try {
        const data = await postJSON(`${API}/download_updates`, {
            updates, mc_version: mc, loader, save_dir: saveDir,
        });
        toast(data.queued ? "更新任务已加入队列" : "模组更新已启动", "ok");
        switchPage("pageD");
    } catch (e) {
        toast("启动更新失败：" + e.message, "err");
    } finally {
        btn.disabled = false;
    }
}

// ================================================================
// 页面 D：任务中心（进行中 / 已完成 + 结算页 + 日志弹窗）
// ================================================================
const STATUS_META = {
    pending: { label: "排队中", cls: "pending" },
    running: { label: "下载中", cls: "running" },
    paused: { label: "已暂停", cls: "paused" },
    stopped: { label: "已停止", cls: "stopped" },
    completed: { label: "已完成", cls: "completed" },
    failed: { label: "已失败", cls: "failed" },
};

const ICONS = {
    pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
    resume: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    log: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`,
    export: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    settle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function taskPct(t) {
    const total = t.total || 0;
    const done = t.done || 0;
    const itemPct = total ? (done / total) * 100 : 0;
    let filePct = 0;
    if (t.progress_total) filePct = (t.progress_done / t.progress_total) * 100;
    return Math.round(total ? Math.min(100, itemPct + filePct / Math.max(total, 1)) : filePct);
}

const QBTN_TITLES = { pause: "暂停", resume: "继续", stop: "停止", delete: "删除", log: "查看日志", export: "导出日志", settle: "结算" };

function qbtn(action, tid, extraCls) {
    return `<button class="q-btn q-${action}${extraCls ? " " + extraCls : ""}" data-action="${action}" data-tid="${tid}" title="${QBTN_TITLES[action] || action}">${ICONS[action] || ""}</button>`;
}

function taskTitle(t) {
    if (t.kind === "batch") return "批量下载";
    if (t.kind === "update") return "模组更新" + (t.mc_version ? ` ${t.mc_version}/${t.loader}` : "");
    return "单模组下载" + (t.mc_version ? ` ${t.mc_version}/${t.loader}` : "");
}

function taskKindLabel(kind) {
    if (kind === "batch") return "批量";
    if (kind === "update") return "更新";
    return "单个";
}

function formatDuration(sec) {
    if (!sec || sec < 0) return "—";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function dirOf(p) {
    if (!p) return "";
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i > 0 ? p.slice(0, i) : p;
}

function subtaskText(t) {
    const total = t.total || 0;
    const idx = t.subtask_index || 0;
    if (!total) return "";
    if (total <= 1) return "处理 1 项";
    return `正在处理第 ${idx} / ${total} 项`;
}

// ---------- 进行中任务 ----------
function renderActiveTasks(tasks) {
    const listEl = document.getElementById("queueList");
    if (!tasks.length) {
        listEl.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">暂无进行中的任务</div>
                <div class="empty-state-desc">在批量下载或单模组下载页发起任务后，将在此排队执行。</div>
            </div>`;
        document.getElementById("taskDetailCard").style.display = "none";
        hideMiniProgress();
        return;
    }
    // 选择要展示详情/迷你进度条的任务
    if (!tasks.some(t => t.task_id === state.selectedTaskId)) {
        const active = tasks.find(t => t.status === "running") ||
                       tasks.find(t => t.status === "paused") ||
                       tasks[0];
        state.selectedTaskId = active ? active.task_id : null;
    }
    const sel = tasks.find(t => t.task_id === state.selectedTaskId) || tasks[0];

    listEl.innerHTML = tasks.map(t => {
        const st = STATUS_META[t.status] || { label: t.status, cls: "pending" };
        const pct = taskPct(t);
        const pos = t.position ? `<span class="q-pos">#${t.position}</span>` : "";
        const active = t.task_id === sel.task_id ? " active" : "";
        const sub = subtaskText(t);
        return `<div class="queue-item${active}" data-tid="${t.task_id}">
            <div class="q-top">
                <span class="q-kind ${t.kind}">${taskKindLabel(t.kind)}</span>
                <span class="q-status st-${st.cls}">${st.label}</span>
                <span class="q-title">${escapeHtml(taskTitle(t))}</span>
                ${pos}
                <span class="q-spacer"></span>
                <span class="q-actions">${qbtn("log", t.task_id)}${qbtn("export", t.task_id)}${taskControlBtns(t)}</span>
            </div>
            <div class="q-bar"><div class="q-fill st-${st.cls}" style="width:${pct}%"></div></div>
            <div class="q-bottom">
                <span class="q-filewrap">${t.current_file ? `<span class="q-file" title="${escapeHtml(t.current_file)}">${escapeHtml(t.current_file)}</span>` : `<span class="q-file mute">—</span>`}</span>
                ${sub ? `<span class="q-sub">${escapeHtml(sub)}</span>` : ""}
                <span class="q-cnts">成功 ${t.success_count} · 跳过 ${t.skipped_count} · 失败 ${t.failed_count} · 缺失 ${t.missing_count}</span>
                <span class="q-pct">${pct}%</span>
            </div>
        </div>`;
    }).join("");

    renderTaskDetail(sel);
    updateMiniProgress(sel);
}

function taskControlBtns(t) {
    const s = t.status;
    let btns = "";
    if (s === "running") btns += qbtn("pause", t.task_id);
    if (s === "paused") btns += qbtn("resume", t.task_id);
    if (s === "running" || s === "paused" || s === "pending") btns += qbtn("stop", t.task_id);
    btns += qbtn("delete", t.task_id);
    return btns;
}

// 进行中任务列表：点击按钮操作 / 点击行选中
document.getElementById("queueList").addEventListener("click", (e) => {
    const btn = e.target.closest(".q-btn");
    const row = e.target.closest(".queue-item");
    if (btn) {
        handleTaskAction(btn.dataset.action, btn.dataset.tid, true);
        return;
    }
    if (row && row.dataset.tid) {
        state.selectedTaskId = row.dataset.tid;
        renderActiveTasks(state.queue || []);
    }
});

// ---------- 已完成任务（历史） ----------
function renderHistoryTasks(history) {
    const listEl = document.getElementById("historyList");
    if (!history.length) {
        listEl.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">暂无已完成任务</div>
                <div class="empty-state-desc">历史任务持久化保存在本机 cache/temp，重启后仍可查看。</div>
            </div>`;
        return;
    }
    listEl.innerHTML = history.map(h => {
        const meta = STATUS_META[h.status] || { label: h.status, cls: "pending" };
        const src = h.source ? dirOf(h.source) : "";
        return `<div class="h-item" data-tid="${h.task_id}">
            <div class="q-top">
                <span class="q-kind ${h.kind}">${taskKindLabel(h.kind)}</span>
                <span class="q-status st-${meta.cls}">${meta.label}</span>
                <span class="q-title">${escapeHtml(taskTitle(h))}</span>
                <span class="q-spacer"></span>
                <span class="h-actions">
                    ${qbtn("settle", h.task_id, "btn-text")}
                    ${qbtn("log", h.task_id)}
                    ${qbtn("export", h.task_id)}
                    ${qbtn("delete", h.task_id)}
                </span>
            </div>
            <div class="q-bottom">
                <span class="q-cnts">成功 ${h.success_count || 0} · 跳过 ${h.skipped_count || 0} · 失败 ${h.failed_count || 0} · 缺失 ${h.missing_count || 0}</span>
                <span class="q-sub">用时 ${formatDuration(h.duration)}</span>
                <span class="q-file mute">${escapeHtml(h.mc_version || "")}/${escapeHtml(h.loader || "")}${src ? " · " + escapeHtml(src) : ""}</span>
            </div>
        </div>`;
    }).join("");
}

// 已完成任务列表：结算 / 日志 / 导出 / 删除
document.getElementById("historyList").addEventListener("click", (e) => {
    const btn = e.target.closest(".q-btn");
    const row = e.target.closest(".h-item");
    if (btn) {
        handleTaskAction(btn.dataset.action, btn.dataset.tid, false);
        return;
    }
    if (row && row.dataset.tid) openSettlement(row.dataset.tid);
});

// ---------- 统一任务操作分发 ----------
async function handleTaskAction(action, tid, isActive) {
    switch (action) {
        case "log":
            openLogModal(tid, isActive);
            return;
        case "export":
            exportLog(tid);
            return;
        case "settle":
            openSettlement(tid);
            return;
        default:
            try {
                await postJSON(`${API}/task_${action}`, { task_id: tid });
                if (action === "delete" && state.settleTaskId === tid) {
                    state.settleTaskId = null;
                    showQueueView("list");
                }
                pollQueue();
            } catch (e) {
                toast("操作失败：" + e.message, "err");
            }
    }
}

// ---------- 任务详情面板（进行中） ----------
function filePct(t) {
    if (!t.progress_total) return 0;
    return Math.round(Math.min(100, (t.progress_done / t.progress_total) * 100));
}

function renderTaskDetail(t) {
    const card = document.getElementById("taskDetailCard");
    card.style.display = "";
    const st = STATUS_META[t.status] || { label: t.status, cls: "pending" };

    document.getElementById("dTaskTitle").textContent = taskTitle(t) + " · " + t.task_id;
    const badge = document.getElementById("dTaskBadge");
    badge.textContent = st.label;
    badge.className = "chip st-" + st.cls;

    const total = t.total || 0;
    const done = t.done || 0;
    const overallPct = total ? Math.round((done / total) * 100) : 0;
    document.getElementById("dProgressText").textContent = total
        ? `总进度 ${done} / ${total}${t.position ? ` · 队列第 ${t.position} 位` : ""}`
        : (t.status === "running" ? "等待任务数据…" : "等待任务…");
    document.getElementById("dProgressPercent").textContent = overallPct + "%";
    const fill = document.getElementById("dProgressFill");
    fill.style.width = overallPct + "%";
    fill.className = "progress-fill st-" + st.cls;

    const fpct = filePct(t);
    document.getElementById("dSubtask").textContent = t.current_file || "—";
    document.getElementById("dFilePct").textContent = fpct + "%";
    const ffill = document.getElementById("dFileFill");
    ffill.style.width = fpct + "%";
    ffill.className = "progress-fill st-" + st.cls;

    document.getElementById("dSpeed").textContent =
        t.status === "running" ? (t.speed_text || "0 B/s") : "0 B/s";
    document.getElementById("dCntOk").textContent = t.success_count;
    document.getElementById("dCntSkip").textContent = t.skipped_count;
    document.getElementById("dCntFail").textContent = t.failed_count;
    document.getElementById("dCntMiss").textContent = t.missing_count;

    document.getElementById("dTaskActions").innerHTML =
        qbtn("log", t.task_id, "btn-text") + qbtn("export", t.task_id, "btn-text") + taskControlBtns(t);
}

// 详情面板操作按钮
document.getElementById("dTaskActions").addEventListener("click", (e) => {
    const btn = e.target.closest(".q-btn");
    if (btn) handleTaskAction(btn.dataset.action, btn.dataset.tid, true);
});

// ---------- 结算页 ----------
function openSettlement(tid) {
    const h = (state.history || []).find(x => x.task_id === tid);
    if (!h) { toast("任务不存在", "err"); return; }
    state.settleTaskId = tid;
    showQueueView("settle");
    renderSettlement(h);
}

document.getElementById("btnBackQueue").addEventListener("click", () => {
    state.settleTaskId = null;
    showQueueView("list");
});

function renderSettlement(h) {
    const st = h;
    const meta = STATUS_META[st.status] || { label: st.status, cls: "pending" };
    document.getElementById("settleTitle").textContent =
        taskTitle(st) + " · 任务结算";

    const failed = st.failed || [];
    const missing = st.missing || [];
    const hasRetry = failed.length || missing.length;
    const srcDir = st.source ? dirOf(st.source) : "";

    const body = document.getElementById("settleBody");
    body.innerHTML = `
        <div class="card">
            <div class="card-head">
                <div class="ch-title"><span class="ch-step">✓</span> 任务总结</div>
                <span class="chip st-${meta.cls}">${meta.label}</span>
            </div>
            <div class="card-body">
                <div class="settle-stats">
                    <div class="stat-card stat-ok"><div class="stat-num">${st.success_count || 0}</div><div class="stat-label">成功</div></div>
                    <div class="stat-card stat-skip"><div class="stat-num">${st.skipped_count || 0}</div><div class="stat-label">跳过</div></div>
                    <div class="stat-card stat-err"><div class="stat-num">${st.failed_count || 0}</div><div class="stat-label">失败</div></div>
                    <div class="stat-card stat-warn"><div class="stat-num">${st.missing_count || 0}</div><div class="stat-label">缺失</div></div>
                </div>
                <div class="settle-meta">
                    <div class="settle-meta-item span2"><span>任务</span><b>${escapeHtml(taskTitle(st))} · ${escapeHtml(h.task_id)}</b></div>
                    <div class="settle-meta-item"><span>目标版本</span><b>${escapeHtml(st.mc_version || "—")} / ${escapeHtml(st.loader || "—")}</b></div>
                    <div class="settle-meta-item"><span>耗时</span><b>${formatDuration(st.duration)}</b></div>
                    <div class="settle-meta-item span2"><span>保存目录</span><b class="break">${escapeHtml(st.save_dir || "—")}</b></div>
                    <div class="settle-meta-item span2"><span>清单文件</span><b class="break">${escapeHtml(st.source || "单模组任务")}</b></div>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="ch-title"><span class="ch-step">⚙</span> 后续操作</div>
            </div>
            <div class="card-body">
                <div class="settle-actions">
                    <button class="btn btn-outline" id="btnOpenSaveDir">打开保存目录</button>
                    ${srcDir ? `<button class="btn btn-outline" id="btnOpenSourceDir">打开清单目录</button>` : ""}
                    <button class="btn btn-primary" id="btnRetryTask" ${hasRetry ? "" : "disabled"}>重试失败与缺失（${failed.length + missing.length}）</button>
                    <button class="btn btn-outline" id="btnRetryFailed" ${failed.length ? "" : "disabled"}>仅重试失败（${failed.length}）</button>
                    <button class="btn btn-outline" id="btnRetryMissing" ${missing.length ? "" : "disabled"}>仅重试缺失（${missing.length}）</button>
                    <button class="btn btn-outline" id="btnAddMods">继续添加模组</button>
                    <button class="btn btn-outline btn-danger" id="btnDeleteSettle">删除任务</button>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="ch-title"><span class="ch-step">!</span> 待处理（${failed.length + missing.length}）</div>
            </div>
            <div class="card-body no-pad">
                <div class="list-items" id="settleMergeList">${renderSettleList(failed, missing)}</div>
            </div>
        </div>`;
}

function renderSettleList(failed, missing) {
    const items = [];
    (failed || []).forEach(f => items.push({ type: "fail", name: f.name || f.project_id || "?", pid: f.project_id || "", reason: f.reason || "未知错误" }));
    (missing || []).forEach(m => items.push({ type: "missing", name: m.name || m.project_id || "?", pid: m.project_id || "", reason: m.reason || "无适配版本" }));
    if (!items.length) {
        return `<div class="empty-state compact"><div class="empty-state-title">全部处理完成</div></div>`;
    }
    return items.map((it, i) => `
        <div class="settle-item st-${it.type}">
            <div class="si-head">
                <span class="si-badge">${it.type === "fail" ? "失败" : "缺失"}</span>
                <b class="si-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</b>
                <button class="q-btn btn-text si-similar" data-query="${escapeHtml(it.name)}" title="搜索类似模组">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    查找类似
                </button>
            </div>
            <div class="si-sub">
                <span class="reason">${escapeHtml(it.reason)}</span>
                <span class="m-pid">${escapeHtml(it.pid)}</span>
            </div>
        </div>`).join("");
}

// 结算页操作（事件委托）
document.getElementById("settleBody").addEventListener("click", (e) => {
    const h = (state.history || []).find(x => x.task_id === state.settleTaskId);
    if (!h) return;
    const st = h;
    if (e.target.closest("#btnOpenSaveDir")) {
        openFolder(st.save_dir);
    } else if (e.target.closest("#btnOpenSourceDir")) {
        openFolder(dirOf(st.source));
    } else if (e.target.closest("#btnRetryTask")) {
        retryTask(h.task_id, "all");
    } else if (e.target.closest("#btnRetryFailed")) {
        retryTask(h.task_id, "failed");
    } else if (e.target.closest("#btnRetryMissing")) {
        retryTask(h.task_id, "missing");
    } else if (e.target.closest("#btnAddMods")) {
        switchPage("pageC");
    } else if (e.target.closest("#btnDeleteSettle")) {
        handleTaskAction("delete", h.task_id, false);
    } else if (e.target.closest(".si-similar")) {
        const q = e.target.closest(".si-similar").dataset.query;
        if (!q) return;
        state.settleTaskId = null;
        switchPage("pageC");
        document.getElementById("catQuery").value = q;
        searchCatalog(1);
    }
});

async function retryTask(tid, scope) {
    scope = scope || "all";
    try {
        const data = await postJSON(`${API}/retry_task`, { task_id: tid, scope });
        const scopes = { all: "失败 / 缺失", failed: "失败", missing: "缺失" };
        toast(`已为 ${data.count} 个${scopes[scope] || ""}模组生成重试任务`, "ok");
        pollQueue();
    } catch (e) {
        toast(e.message, "err");
    }
}

async function openFolder(path) {
    if (!path) { toast("目录不存在", "err"); return; }
    try {
        await postJSON(`${API}/open_folder`, { path });
    } catch (e) {
        toast(e.message, "err");
    }
}

// ---------- 日志弹窗 ----------
function openLogModal(tid, running) {
    state.logModalTid = tid;
    document.getElementById("lmTitle").textContent = "任务日志 · " + tid;
    const m = document.getElementById("logModal");
    m.style.display = "";
    loadLogModal();
    clearInterval(state.logModalTimer);
    if (running) {
        state.logModalTimer = setInterval(() => {
            if (document.getElementById("logModal").style.display === "none") {
                clearInterval(state.logModalTimer);
                state.logModalTimer = null;
                return;
            }
            loadLogModal();
        }, 2000);
    } else {
        state.logModalTimer = null;
    }
}

async function loadLogModal() {
    const tid = state.logModalTid;
    if (!tid) return;
    const body = document.getElementById("lmBody");
    try {
        const data = await getJSON(`${API}/logs/${encodeURIComponent(tid)}`);
        const logs = data.logs || [];
        if (!logs.length) {
            body.innerHTML = `<div class="empty-state compact"><div class="empty-state-title">暂无日志</div></div>`;
            return;
        }
        body.innerHTML = logs.map(lg =>
            `<div class="log-line ${lg.level || "info"}">
                <span class="log-time">${escapeHtml(lg.time || "")}</span>
                <span class="log-msg">${escapeHtml(lg.msg || "")}</span>
            </div>`).join("");
        body.scrollTop = body.scrollHeight;
    } catch (e) {
        body.innerHTML = `<div class="empty-state compact"><div class="empty-state-title">读取日志失败</div><div class="empty-state-desc">${escapeHtml(e.message)}</div></div>`;
    }
}

function exportLog(tid) {
    window.open(`${API}/logs/${encodeURIComponent(tid)}/download`, "_blank");
}

function closeLogModal() {
    clearInterval(state.logModalTimer);
    state.logModalTimer = null;
    state.logModalTid = null;
    document.getElementById("logModal").style.display = "none";
}

document.getElementById("lmClose").addEventListener("click", closeLogModal);
document.getElementById("lmExport").addEventListener("click", () => {
    if (state.logModalTid) exportLog(state.logModalTid);
});
document.getElementById("logModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("logModal")) closeLogModal();
});

// ---------- 迷你进度条（顶栏） ----------
function updateMiniProgress(t) {
    const box = document.getElementById("miniProgress");
    if (!box) return;
    const pct = taskPct(t);
    if (t.status === "running" || t.status === "paused") {
        box.style.display = "";
        document.getElementById("mpText").textContent = t.status === "running" ? "下载中" : "已暂停";
        document.getElementById("mpPct").textContent = pct + "%";
        document.getElementById("mpFill").style.width = pct + "%";
    } else {
        hideMiniProgress();
    }
}

function hideMiniProgress() {
    const box = document.getElementById("miniProgress");
    if (box) box.style.display = "none";
}

// ---------- 队列轮询 ----------
let pollTimer = null;
function startQueuePoll() {
    if (pollTimer) return;
    pollQueue();
    pollTimer = setInterval(pollQueue, 900);
}

// 下载完成通知（V3.2）：全部任务结束时 toast + 提示音 + 系统通知
let downloadDoneNotified = false;
let stateHistoryLen = 0;

function notifyDownloadsDone(hist) {
    downloadDoneNotified = true;
    const ok = hist.reduce((a, h) => a + (h.success_count || 0), 0);
    const fail = hist.reduce((a, h) => a + (h.failed_count || 0), 0);
    const msg = fail > 0
        ? `全部任务已完成：成功 ${ok}，失败 ${fail}（详见任务中心）`
        : `全部任务已完成：成功 ${ok} 个模组`;
    toast(msg, fail > 0 ? "warn" : "ok");
    try {
        if (window.Notification && Notification.permission === "granted") {
            new Notification("ModList-Weaver", { body: msg });
        }
    } catch (_) {}
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 1108, 1318].forEach((f, i) => {
            const t = i * 0.18;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.value = f;
            gain.gain.setValueAtTime(0.12, ctx.currentTime + t);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.16);
            osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.17);
        });
    } catch (_) {}
}

async function pollQueue() {
    try {
        const data = await getJSON(`${API}/queue`);
        const tasks = data.tasks || [];
        const hist = data.history || [];
        state.queue = tasks;
        state.history = hist;
        renderActiveTasks(tasks);
        renderHistoryTasks(hist);
        if (state.settleTaskId) {
            const h = hist.find(x => x.task_id === state.settleTaskId);
            if (h) renderSettlement(h);
            else { state.settleTaskId = null; showQueueView("list"); }
        }
        // 下载完成检测：有任务进行中 → 置位；从有→无 → 通知一次
        const hasActive = tasks.some(t =>
            t.status === "running" || t.status === "paused" || t.status === "pending");
        if (hasActive) {
            state.wasDownloading = true;
            downloadDoneNotified = false;
        } else if (state.wasDownloading && !downloadDoneNotified) {
            const fresh = hist.length > stateHistoryLen
                ? hist.slice(0, hist.length - stateHistoryLen)
                : hist.slice(0, 3);
            state.wasDownloading = false;
            notifyDownloadsDone(fresh.length ? fresh : hist.slice(0, 3));
        }
        stateHistoryLen = hist.length;
    } catch (_) { /* 轮询出错静默，下次重试 */ }
}

// ================================================================
// 页面 H：设置
// ================================================================
async function loadSettings() {
    try {
        const s = await getJSON(`${API}/settings`);
        const con = document.getElementById("setConcurrency");
        if (con) con.value = String(s.max_concurrency ?? 3);
        const rate = document.getElementById("setRateLimit");
        if (rate) rate.value = s.rate_limit_mbps ?? 0;
        const theme = document.getElementById("setTheme");
        if (theme) theme.value = s.theme || "auto";
        const src = document.getElementById("setSource");
        if (src) src.value = s.source || "auto";
        const cfk = document.getElementById("setCfKey");
        if (cfk) cfk.value = s.curseforge_api_key || "";
        if (s.theme) applyTheme(s.theme);
        const saved = document.getElementById("settingsSaved");
        if (saved) saved.textContent = "";
    } catch (_) {}
}

document.getElementById("btnSaveSettings").addEventListener("click", async () => {
    const patch = {
        max_concurrency: parseInt(document.getElementById("setConcurrency").value, 10) || 3,
        rate_limit_mbps: parseFloat(document.getElementById("setRateLimit").value) || 0,
        theme: document.getElementById("setTheme").value,
        source: document.getElementById("setSource").value || "auto",
        curseforge_api_key: (document.getElementById("setCfKey").value || "").trim(),
    };
    if (patch.max_concurrency < 1) patch.max_concurrency = 1;
    if (patch.rate_limit_mbps < 0) patch.rate_limit_mbps = 0;
    if (!["auto", "modrinth", "curseforge"].includes(patch.source)) patch.source = "auto";
    const btn = document.getElementById("btnSaveSettings");
    btn.disabled = true;
    try {
        const s = await postJSON(`${API}/settings`, patch);
        applyTheme(s.theme || "auto");
        const saved = document.getElementById("settingsSaved");
        if (saved) saved.textContent = "已保存";
        setTimeout(() => { if (saved) saved.textContent = ""; }, 2000);
        toast("设置已保存", "ok");
    } catch (e) {
        toast("保存失败：" + e.message, "err");
    } finally {
        btn.disabled = false;
    }
});

// ---------- 存储与清理（V3.2） ----------
function formatCacheBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + units[i];
}

async function refreshStorageInfo() {
    try {
        const s = await getJSON(`${API}/storage_info`);
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set("stLogs", formatCacheBytes(s.logs_bytes));
        set("stDropped", formatCacheBytes(s.dropped_bytes));
        set("stHistory", String(s.history_count));
        const hint = document.getElementById("storageHint");
        if (hint) hint.textContent = `缓存总计 ${formatCacheBytes(s.total_bytes)}`;
    } catch (_) {}
}

async function clearCacheKind(what, label) {
    const el = document.getElementById(`btnClear${label}`);
    if (el) el.disabled = true;
    try {
        const r = await postJSON(`${API}/clear_cache`, { what });
        toast(`已清理${label === "History" ? "任务历史" : label === "Logs" ? "日志" : "导入临时文件"}（${r.removed} 项）`, "ok");
    } catch (e) {
        toast("清理失败：" + e.message, "err");
    } finally {
        if (el) el.disabled = false;
        refreshStorageInfo();
    }
}

document.getElementById("btnRefreshStorage").addEventListener("click", refreshStorageInfo);
document.getElementById("btnClearLogs").addEventListener("click", () => clearCacheKind("logs", "Logs"));
document.getElementById("btnClearDropped").addEventListener("click", () => clearCacheKind("dropped", "Dropped"));
document.getElementById("btnClearHistory").addEventListener("click", () => clearCacheKind("history", "History"));

// ================================================================
// 软件更新检查（V3.1）：启动自动查 GitHub Release，发现新版本显示横幅
// ================================================================
const APP_UPDATE_IGNORE_KEY = "mlw_ignored_version";
let appUpdateInfo = null;

function renderAppUpdateBanner(info) {
    const banner = document.getElementById("appUpdateBanner");
    if (!banner || !info || !info.has_update) return;
    let ignored = "";
    try { ignored = localStorage.getItem(APP_UPDATE_IGNORE_KEY) || ""; } catch (_) {}
    if (ignored === info.latest_version) return;
    const verEl = document.getElementById("aubVersion");
    if (verEl) verEl.textContent = info.latest_version;
    const bodyEl = document.getElementById("aubBody");
    if (bodyEl) {
        const line = String(info.body || "").split("\n").map(s => s.replace(/^#+\s*/, "").trim()).find(Boolean);
        bodyEl.textContent = line || "软件有新版本，前往 GitHub 下载更新。";
        bodyEl.title = info.release_url || "";
    }
    banner.style.display = "flex";
}

async function checkAppUpdate(force) {
    try {
        appUpdateInfo = await getJSON(`${API}/check_app_update${force ? "?force=true" : ""}`);
        renderAppUpdateBanner(appUpdateInfo);
        return appUpdateInfo;
    } catch (_) {
        return null;
    }
}

document.getElementById("btnAubDownload").addEventListener("click", () => {
    const url = (appUpdateInfo && appUpdateInfo.release_url)
        || "https://github.com/JonathanSssst/ModList-Weaver/releases/latest";
    window.open(url, "_blank");
});

document.getElementById("btnAubIgnore").addEventListener("click", () => {
    if (appUpdateInfo && appUpdateInfo.latest_version) {
        try { localStorage.setItem(APP_UPDATE_IGNORE_KEY, appUpdateInfo.latest_version); } catch (_) {}
    }
    const banner = document.getElementById("appUpdateBanner");
    if (banner) banner.style.display = "none";
});

document.getElementById("btnCheckAppUpdate").addEventListener("click", async () => {
    const el = document.getElementById("appUpdateResult");
    if (el) el.textContent = "检查中…";
    const info = await checkAppUpdate(true);
    if (!info) { if (el) el.textContent = "检查失败（网络异常）"; return; }
    if (info.has_update) {
        if (el) el.textContent = "发现新版本 v" + info.latest_version;
    } else if (info.error) {
        if (el) el.textContent = "检查失败：" + info.error;
    } else {
        if (el) el.textContent = "已是最新版本 v" + info.current_version;
    }
});

// ================================================================
// 拖拽支持（V3.1）：文件夹 → 扫描目录；modlist.json → 批量下载
// ================================================================
function importDroppedJson(path) {
    document.getElementById("jsonPath").value = path;
    switchPage("pageB");
    showBStep(1, true);
    toast("已导入清单：" + String(path).split(/[\\/]/).pop(), "ok");
}

function showDropOverlay() {
    const ov = document.getElementById("dropOverlay");
    if (ov) ov.style.display = "flex";
}
function hideDropOverlay() {
    const ov = document.getElementById("dropOverlay");
    if (ov) ov.style.display = "none";
}

function isPywebviewRuntime() {
    return !!(window.pywebview && (window.pywebview.api || window.pywebview.platform));
}

// pywebview 主机通过 main.py 注入完整绝对路径后回调本函数
window.__pywebviewDropped = function (items) {
    if (!Array.isArray(items) || !items.length) return;
    const folder = items.find(i => i.is_dir);
    const jsonFile = items.find(i => !i.is_dir && i.ext === ".json");
    if (folder) {
        const input = document.getElementById("scanFolder");
        if (input) input.value = folder.path;
        switchPage("pageA");
        showWizardStep(1, true);
        toast(`已填入模组目录：${folder.path}`, "ok");
    } else if (jsonFile) {
        importDroppedJson(jsonFile.path);
    } else if (items.length === 1) {
        importDroppedJson(items[0].path);
    } else {
        toast("请拖入 mods 文件夹或 modlist.json 文件", "err");
    }
};

// 纯浏览器开发态降级：无完整路径时读取 json 文件内容导入
(function setupNativeDrop() {
    let dragDepth = 0;
    document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragDepth++;
        showDropOverlay();
    });
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) hideDropOverlay();
    });
    document.addEventListener("drop", (e) => {
        e.preventDefault();
        dragDepth = 0;
        hideDropOverlay();
        if (isPywebviewRuntime()) return; // 由 pywebview 主机处理（含完整路径）
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        const f = files[0];
        if (f.name && f.name.toLowerCase().endsWith(".json")) {
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const data = await postJSON(`${API}/import_modlist`, {
                        filename: f.name,
                        content: String(reader.result || ""),
                    });
                    importDroppedJson(data.path);
                } catch (err) {
                    toast("导入清单失败：" + err.message, "err");
                }
            };
            reader.onerror = () => toast("读取文件失败", "err");
            reader.readAsText(f);
        } else {
            toast("请拖入 mods 文件夹或 modlist.json 文件", "err");
        }
    });
})();

// ================================================================
// 启动
// ================================================================
setStatus("就绪");
loadMcVersions();
startQueuePoll();
loadSettings();
checkAppUpdate(false); // 启动检查软件更新（V3.1）
// 请求系统通知权限（下载完成提示用，V3.2）；WebView2 可能不支持，静默失败
try {
    if (window.Notification && Notification.permission === "default") {
        Notification.requestPermission();
    }
} catch (_) {}
// 从后端拉取真实版本号覆盖静态显示（单一事实来源 backend.api.CURRENT_VERSION）
// 并缓存 changelog 供「关于」页渲染
(async function bootstrapVersion() {
    try {
        const v = await getJSON(`${API}/version`);
        if (!v) return;
        const ver = v.version || "";
        // 侧边栏
        const sbSub = document.querySelector(".sb-sub");
        if (sbSub && ver) sbSub.textContent = `模组迁移工具 v${ver}`;
        // 关于页
        const aboutVer = document.querySelector(".about-ver");
        if (aboutVer && ver) aboutVer.textContent = `版本 v${ver}`;
        const aboutDesc = document.querySelector(".about-desc");
        if (aboutDesc) {
            aboutDesc.textContent = "Minecraft 双源（Modrinth + CurseForge）模组迁移工具：扫描旧版本 mods 目录、导出 modlist.json 清单、批量 / 单模组下载。";
        }
        // 浏览器标题
        if (v.display) document.title = `${v.display} · Minecraft 双源模组迁移工具`;
        // 更新日志（已并入「关于」页）：后端返回 changelog 则渲染，最新版本默认展开、历史版本折叠可点击展开
        const clRoot = document.getElementById("changelogRoot");
        if (clRoot) {
            if (Array.isArray(v.changelog) && v.changelog.length) {
                clRoot.innerHTML = v.changelog.map((c, idx) => {
                    const open = idx === 0;
                    return `
                    <div class="cl-item cl-fold" data-open="${open ? 1 : 0}">
                        <div class="cl-head" role="button" title="点击展开/收起">
                            <span class="cl-ver">v${c.version || ''}</span>
                            <span class="cl-fold-hint">${open ? '▾' : '▸'}</span>
                        </div>
                        ${c.date ? `<div class="cl-date">${c.date}${open ? ' · 最新正式版' : ''}</div>` : ''}
                        <div class="cl-fold-body">
                            ${c.title ? `<div class="cl-title">${c.title}</div>` : ''}
                            <ul class="cl-list">${(c.items || []).map(i => `<li>${i}</li>`).join('')}</ul>
                        </div>
                    </div>`;
                }).join('');
            }
            clRoot.addEventListener("click", (e) => {
                const head = e.target.closest(".cl-head");
                if (!head) return;
                const item = head.closest(".cl-item");
                if (!item) return;
                const next = item.getAttribute("data-open") === "1" ? "0" : "1";
                item.setAttribute("data-open", next);
                const hint = head.querySelector(".cl-fold-hint");
                if (hint) hint.textContent = next === "1" ? "▾" : "▸";
            });
        }
    } catch (_) {}
})();
