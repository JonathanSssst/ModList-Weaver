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

// 按钮忙碌状态：禁用 + spinner（V3.7）
function setBtnBusy(btn, busy) {
    if (!btn) return;
    btn.classList.toggle("is-loading", busy);
    btn.disabled = busy;
}

// 列表骨架屏占位（V3.7）
function showSkeleton(boxId, rows) {
    const box = document.getElementById(boxId);
    if (!box) return;
    box.innerHTML = Array.from({ length: rows }, () => `
        <div class="skel-row">
            <div class="skeleton skel-sm"></div>
            <div class="skeleton skel-md"></div>
            <div class="skeleton skel-sm"></div>
        </div>`).join("");
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
// 主题（明 / 暗）+ 配色 + 对比度：localStorage 偏好 + 服务端设置（V3.7）
// ================================================================
const THEME_KEY = "mlw_theme";
const ACCENT_KEY = "mlw_accent";
const CONTRAST_KEY = "mlw_contrast";

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
let accentPref = "default";
try { accentPref = localStorage.getItem(ACCENT_KEY) || "default"; } catch (_) {}
let contrastPref = "normal";
try { contrastPref = localStorage.getItem(CONTRAST_KEY) || "normal"; } catch (_) {}

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
    document.documentElement.setAttribute("data-accent", accentPref);
    document.documentElement.setAttribute("data-contrast", contrastPref);
    try { localStorage.setItem(THEME_KEY, themePref); } catch (_) {}
    const sel = document.getElementById("setTheme");
    if (sel) sel.value = themePref;
    const acc = document.getElementById("setAccent");
    if (acc) acc.value = accentPref;
    const con = document.getElementById("setContrast");
    if (con) con.value = contrastPref;
}

// 切换配色 / 对比度（预览即时生效，保存设置时同步到服务端）
function setAccent(val) {
    accentPref = ["default", "green", "indigo"].includes(val) ? val : "default";
    document.documentElement.setAttribute("data-accent", accentPref);
    try { localStorage.setItem(ACCENT_KEY, accentPref); } catch (_) {}
}
function setContrast(val) {
    contrastPref = ["normal", "high"].includes(val) ? val : "normal";
    document.documentElement.setAttribute("data-contrast", contrastPref);
    try { localStorage.setItem(CONTRAST_KEY, contrastPref); } catch (_) {}
}
document.getElementById("setAccent").addEventListener("change", (e) => setAccent(e.target.value));
document.getElementById("setContrast").addEventListener("change", (e) => setContrast(e.target.value));

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
    pageA: "导出",
    pageB: "导入",
    pageI: "迁移",
    pageJ: "我的清单",
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
    pageI: "工作流",
    pageJ: "工作流",
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
    detailBackPage: "pageC",   // 详情页返回来源（V3.5）
    selectedTaskId: null,
    settleTaskId: null,   // 结算页当前任务（已完成历史）
    logModalTid: null,    // 日志弹窗当前任务
    logModalTimer: null,
    updateMap: {},        // project_id -> 更新信息（检查更新结果，V3.1）
    wasDownloading: false, // 是否有任务进行中（完成通知判定，V3.2）
    manMods: [],          // 本地模组管理（页面 E）：扫描结果（V3.3）
    manUpdateMap: {},     // 页面 E：project_id -> 更新信息（V3.3）
    manStep: 1,           // 页面 E：向导步骤（V3.7）
    migMods: [],          // 模组迁移（页面 I）：扫描结果（V3.5）
    migStep: 1,           // 模组迁移（页面 I）：向导步骤（V3.6）
    customMods: [],       // 自定义模组包（页面 J）：清单（V3.5）
    customSel: new Map(),   // 添加悬浮框（V3.6）：已勾选 pid -> {pid, name, source}
    customDepInfo: {},      // 添加悬浮框（V3.6）：pid -> [{project_id, name}] 必需依赖
    customDepLoading: {},   // 添加悬浮框（V3.6）：依赖读取中标记
    customLastHits: [],     // 添加悬浮框（V3.6）：最近搜索结果（依赖行刷新用）
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
    lastHits: [], // V3.5：当前页命中结果
};

// 下载偏好（详情页下载表单记忆，localStorage 持久化）
function loadPref() {
    const p = { mc: "", loader: "fabric", saveDir: "", manFolder: "" };
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
function saveManFolder(folder) {
    pref.manFolder = folder || "";
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
        // 预填目标版本 / 加载器 / 记忆目录；已扫描则回到列表，否则自动扫描（V3.7）
        const mc = document.getElementById("manMc");
        const ldr = document.getElementById("manLoader");
        const folder = document.getElementById("manFolder");
        if (mc && !mc.value) mc.value = pref.mc || "";
        if (ldr) ldr.value = pref.loader || "fabric";
        if (folder && !folder.value && pref.manFolder) folder.value = pref.manFolder;
        if (state.manMods.length) {
            showManStep(2, true);
        } else if (pref.manFolder) {
            showManStep(1, true);
            autoScanMan();
        } else {
            showManStep(1, true);
        }
    }
    if (pageId === "pageI") {
        // 预填迁移目标（V3.5）；恢复向导步骤（V3.6）
        const mc = document.getElementById("migMc");
        const ldr = document.getElementById("migLoader");
        if (mc && !mc.value) mc.value = pref.mc || "";
        if (ldr) ldr.value = pref.loader || "fabric";
        const step = state.migMods.length ? (state.migStep || 1) : 1;
        showIStep(step, true);
        updateMigCount();
    }
    if (pageId === "pageJ") {
        renderCustomList();
    }
    if (pageId === "pageD") {
        showQueueView(state.settleTaskId ? "settle" : "list");
    }
    if (pageId === "pageH") {
        loadSettings();
        refreshStorageInfo();
    }
}

// 操作完成后页面初始化（V3.3.2）：清理向导与表单，回到初始状态
function resetPage(pageId) {
    switch (pageId) {
        case "pageA":
            state.scannedMods = [];
            state.updateMap = {};
            state.wizardStep = 1;
            ["scanFolder", "exportPath"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = "";
            });
            const exportMc = document.getElementById("exportMc");
            if (exportMc) exportMc.value = "";
            ["statTotal", "statMatched", "statUnmatched"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = "0";
            });
            const upCount = document.getElementById("updateCount");
            if (upCount) upCount.textContent = "";
            renderModList(state.scannedMods);
            showWizardStep(1, true);
            break;
        case "pageB":
            state.bpItems = [];
            state.bStep = 1;
            ["jsonPath", "batchMc", "batchSaveDir"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = "";
            });
            const bpList = document.getElementById("bpList");
            if (bpList) bpList.innerHTML = `
                <div class="empty-state compact">
                    <div class="empty-state-title">暂无预览</div>
                    <div class="empty-state-desc">请先选择 modlist.json 清单文件。</div>
                </div>`;
            const bpInfo = document.getElementById("bpInfo");
            if (bpInfo) bpInfo.textContent = "—";
            const btnBStep = document.getElementById("btnBStepNext");
            if (btnBStep) btnBStep.disabled = true;
            const btnBPrev = document.getElementById("btnBPNext");
            if (btnBPrev) btnBPrev.disabled = true;
            updateBPCount();
            showBStep(1, true);
            break;
        case "pageC":
            state.catDetail = false;
            showCView("list");
            break;
        case "pageE":
            state.manMods = [];
            state.manUpdateMap = {};
            state.manStep = 1;
            const manFolder = document.getElementById("manFolder");
            if (manFolder) manFolder.value = "";
            const manMc = document.getElementById("manMc");
            if (manMc) manMc.value = "";
            ["manTotal", "manActive", "manDisabled", "manUpdates"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = "0";
            });
            const manCnt = document.getElementById("manUpdateCount");
            if (manCnt) manCnt.textContent = "";
            const manBtn = document.getElementById("btnManUpdate");
            if (manBtn) manBtn.disabled = true;
            renderManList();
            showManStep(1, true);
            break;
        case "pageI":
            state.migMods = [];
            state.migStep = 1;
            const migFolder = document.getElementById("migFolder");
            if (migFolder) migFolder.value = "";
            const migMc = document.getElementById("migMc");
            if (migMc) migMc.value = "";
            const migSave = document.getElementById("migSaveDir");
            if (migSave) migSave.value = "";
            renderMigList();
            updateMigCount();
            showIStep(1, true);
            break;
        case "pageJ":
            state.customMods = [];
            state.customSel = new Map();
            state.customDepInfo = {};
            const customPath = document.getElementById("customPath");
            if (customPath) customPath.value = "";
            saveCustomMods();
            renderCustomList();
            break;
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
    const t = e.target.closest("#sidebarToggle");
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
    setBtnBusy(btn, true);
    showSkeleton("modList", 5);
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
        setBtnBusy(btn, false);
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
    setBtnBusy(btn, true);
    if (btn) btn.textContent = "检测中…";
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
        if (btn) btn.textContent = "检查更新";
        setBtnBusy(btn, false);
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
        resetPage("pageA");
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
        resetPage("pageB");
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
    setBtnBusy(btn, true);
    showSkeleton("modCatalog", 6);
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
        catalogState.lastHits = data.hits || [];
        renderCatalog(data.hits || []);
        setStatus("就绪");
    } catch (e) {
        setStatus("就绪");
        toast("搜索失败：" + e.message, "err");
    } finally {
        setBtnBusy(btn, false);
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
function openDetail(pid, fromPage) {
    state.catDetail = true;
    state.detailPid = pid;
    state.detailBackPage = fromPage || state.currentPage || "pageC"; // V3.5：返回来源跟踪
    switchPage("pageC");
    loadDetail(pid);
}

document.getElementById("btnBackCatalog").addEventListener("click", () => {
    state.catDetail = false;
    const from = state.detailBackPage || "pageC";
    if (from === "pageC") {
        showCView("list");
        return;
    }
    switchPage(from);
});

async function loadDetail(pid) {
    const box = document.getElementById("modDetail");
    box.innerHTML = `
        <div class="empty-state compact">
            <div class="empty-state-title">正在加载模组详情…</div>
        </div>`;
    try {
        const data = await getJSON(`${API}/project/${encodeURIComponent(pid)}`);
        renderDetail(box, data);
    } catch (e) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">加载详情失败</div>
                <div class="empty-state-desc">${escapeHtml(e.message)}</div>
            </div>`;
    }
}

const DEP_LABELS = { required: "必需依赖", optional: "可选依赖", incompatible: "不兼容", embedded: "内置依赖" };

function renderDetail(box, d) {
    const titleEl = document.getElementById("detailTitle");
    if (titleEl) titleEl.textContent = d.title || d.project_id;

    const cats = (d.categories || []).slice(0, 6).map(c =>
        `<span class="chip">${escapeHtml(c)}</span>`).join("");
    const loaders = (d.loaders || []).slice(0, 6).map(c =>
        `<span class="chip">${escapeHtml(c)}</span>`).join("");
    const authors = (d.authors || []).map(a => `
        <div class="author-item">
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

    // V3.6.1：右侧来源链接 —— 源码 GitHub / Modrinth / MC百科（若支持）
    const srcLinks = [];
    if (d.source_url) {
        srcLinks.push(`<a class="d-stat link" href="${escapeHtml(d.source_url)}" target="_blank" title="源码仓库"><b>源码</b><span>GitHub</span></a>`);
    }
    if (d.source === "modrinth" && (d.slug || d.project_id)) {
        srcLinks.push(`<a class="d-stat link" href="https://modrinth.com/project/${escapeHtml(d.slug || d.project_id)}" target="_blank" title="Modrinth 项目页"><b>Modrinth</b><span>项目页</span></a>`);
    }
    if (d.source === "curseforge" && d.slug) {
        srcLinks.push(`<a class="d-stat link" href="https://www.curseforge.com/minecraft/mc-mods/${escapeHtml(d.slug)}" target="_blank" title="CurseForge 项目页"><b>CurseForge</b><span>项目页</span></a>`);
    }
    if (d.title) {
        srcLinks.push(`<a class="d-stat link" href="https://search.mcmod.cn/s?key=${encodeURIComponent(d.title)}" target="_blank" title="在 MC百科 搜索"><b>MC百科</b><span>搜索</span></a>`);
    }

    // 前置依赖（V3.6.1）：下拉选择最近版本查看对应依赖，默认最新版本
    const recentVersions = (d.versions || []).slice(0, 6);
    detailVersionsCache = recentVersions.map(v => ({
        label: v.version_number || v.name || "—",
        deps: extractDeps(v),
    }));
    const verOptions = detailVersionsCache.map((v, i) =>
        `<option value="${i}">${escapeHtml(v.label)}${v.deps.length ? "（" + v.deps.length + " 个依赖）" : ""}</option>`
    ).join("");
    const depHtml = buildDepGroups(detailVersionsCache[0] ? detailVersionsCache[0].deps : []);

    box.innerHTML = `
        <div class="card">
            <div class="card-body">
                <div class="d-header">
                    <img class="d-icon" src="${escapeHtml(d.icon_url || "")}" onerror="this.style.display='none'" />
                    <div class="d-head-main">
                        <div class="d-title-line">
                            <h3 class="d-title">${escapeHtml(d.title)}</h3>
                            <span class="chip">${escapeHtml(d.project_type || "mod")}</span>
                            <button class="btn btn-primary btn-sm btn-icon-only" id="btnDlOpen" title="下载该模组">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                    <polyline points="7 10 12 15 17 10"/>
                                    <line x1="12" y1="15" x2="12" y2="3"/>
                                </svg>
                            </button>
                        </div>
                        <div class="d-sub">${escapeHtml(d.project_id)}${d.slug ? " · " + escapeHtml(d.slug) : ""}</div>
                        <p class="d-desc">${escapeHtml(d.description || "（无简介）")}</p>
                        <div class="d-chips">${cats}${loaders}</div>
                    </div>
                    <div class="d-stats">
                        <div class="d-stat"><b>${formatCount(d.downloads)}</b><span>下载量</span></div>
                        <div class="d-stat"><b>${formatCount(d.followers)}</b><span>收藏</span></div>
                        <div class="d-stat"><b>${escapeHtml(d.license || "?")}</b><span>许可</span></div>
                        ${srcLinks.join("")}
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
                <div class="ch-title"><span class="ch-step">⊘</span> 前置依赖</div>
                <select class="input dep-ver-select" id="depVerSel" title="选择版本查看对应依赖">${verOptions}</select>
            </div>
            <div class="card-body" id="depGroups">
                ${depHtml || `<span class="text-mute">该模组没有已声明的依赖。</span>`}
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
        </div>`;

    // V3.6.1：异步补全前置依赖名称与图标
    if (detailVersionsCache[0] && detailVersionsCache[0].deps.length) loadDetailDepNames(detailVersionsCache[0].deps);
}

// V3.6.1：从版本对象提取前置依赖列表（project_id / version_id -> pid）
function extractDeps(v) {
    const deps = [];
    for (const dep of (v && v.dependencies) || []) {
        if (!dep || dep.project_id === undefined || dep.project_id === null) continue;
        const t = dep.dependency_type in DEP_LABELS ? dep.dependency_type : "required";
        const target = dep.project_id ? String(dep.project_id) : dep.version_id ? String(dep.version_id) : null;
        if (!target) continue;
        deps.push({ pid: target, src: dep.source || "auto", t });
    }
    return deps;
}

// V3.6.1：按依赖类型分组渲染（名称占位「读取中…」，随后由 loadDetailDepNames 补全）
function buildDepGroups(deps) {
    if (!deps.length) return "";
    return Object.keys(DEP_LABELS).map(t => {
        const chips = deps.filter(x => x.t === t).map(dep => `
            <button class="dep-chip dep-chip-${escapeHtml(dep.t)}" data-pid="${escapeHtml(dep.pid)}" data-dsrc="${escapeHtml(dep.src)}" title="点击查看详情">
                <span class="dep-name">读取中…</span><span class="dep-type">${escapeHtml(DEP_LABELS[dep.t])}</span>
            </button>`).join("");
        return chips ? `<div class="dep-group"><span class="dep-group-label">${DEP_LABELS[t]}</span>${chips}</div>` : "";
    }).join("");
}

// V3.6.1：切换版本后重渲染对应依赖
function showDetailDeps(idx) {
    const v = detailVersionsCache[idx];
    if (!v) return;
    const groupsEl = document.getElementById("depGroups");
    if (!groupsEl) return;
    groupsEl.innerHTML = buildDepGroups(v.deps) || `<span class="text-mute">该版本没有已声明的依赖。</span>`;
    if (v.deps.length) loadDetailDepNames(v.deps);
}

let detailVersionsCache = [];

// V3.6.1：详情页前置依赖 —— 异步读取名称与图标（不显示 ID）
async function loadDetailDepNames(deps) {
    const infos = {};
    await Promise.all(deps.map(async dep => {
        const pid = dep.pid;
        try {
            const dd = await getJSON(`${API}/project/${encodeURIComponent(pid)}`);
            infos[pid] = { name: dd.title || dd.project_id || pid, icon: dd.icon_url || "" };
        } catch (_) {
            infos[pid] = { name: pid, icon: "" };
        }
    }));
    const groupsEl = document.getElementById("depGroups");
    if (!groupsEl) return;
    const html = Object.keys(DEP_LABELS).map(t => {
        const chips = deps.filter(x => x.t === t).map(dep => {
            const info = infos[dep.pid] || { name: dep.pid, icon: "" };
            const icon = info.icon
                ? `<img class="dep-icon" src="${escapeHtml(info.icon)}" onerror="this.style.display='none'" />`
                : `<span class="dep-icon dep-icon-ph">${escapeHtml((info.name || "?").charAt(0).toUpperCase())}</span>`;
            return `<button class="dep-chip dep-chip-${escapeHtml(dep.t)}" data-pid="${escapeHtml(dep.pid)}" data-dsrc="${escapeHtml(dep.src)}" title="点击查看详情">
                ${icon}<span class="dep-name">${escapeHtml(info.name)}</span><span class="dep-type">${escapeHtml(DEP_LABELS[dep.t])}</span>
            </button>`;
        }).join("");
        return chips ? `<div class="dep-group"><span class="dep-group-label">${DEP_LABELS[t]}</span>${chips}</div>` : "";
    }).join("");
    groupsEl.innerHTML = html || `<span class="text-mute">该模组没有已声明的依赖。</span>`;
}

// 详情页：版本日志折叠 / 前置依赖跳转 / 打开下载悬浮框（事件委托）
document.getElementById("modDetail").addEventListener("click", async (e) => {
    const rv = e.target.closest(".rv-item.has-cl");
    if (rv) {
        const open = rv.dataset.open === "1" ? "0" : "1";
        rv.dataset.open = open;
        const chev = rv.querySelector(".rv-chev");
        if (chev) chev.classList.toggle("open", open === "1");
        return;
    }
    const dlOpen = e.target.closest("#btnDlOpen");
    if (dlOpen) {
        openDlModal();
        return;
    }
    // V3.6.1：前置依赖跳转
    const dep = e.target.closest(".dep-chip");
    if (dep) {
        openDetail(dep.dataset.pid, state.detailBackPage);
        return;
    }
});

// V3.6.1：下拉切换前置依赖的版本
document.getElementById("modDetail").addEventListener("change", (e) => {
    if (e.target && e.target.id === "depVerSel") {
        const idx = parseInt(e.target.value, 10);
        if (!isNaN(idx)) showDetailDeps(idx);
    }
});

// V3.6.1：详情页下载悬浮框 —— 下载该模组精简为一个按钮
function openDlModal() {
    const pidEl = document.getElementById("dlPid");
    if (pidEl) pidEl.value = state.detailPid || "";
    const mc = document.getElementById("dlMc");
    if (mc && !mc.value) mc.value = pref.mc || "";
    const ldr = document.getElementById("dlLoader");
    if (ldr && !ldr.options.length) {
        ldr.innerHTML = Object.entries(LOADER_LABELS)
            .map(([v, label]) => `<option value="${v}" ${pref.loader === v ? "selected" : ""}>${label}</option>`)
            .join("");
    }
    const dir = document.getElementById("dlSaveDir");
    if (dir && !dir.value) dir.value = pref.saveDir || "";
    openModalEl("dlModal");
}

document.getElementById("btnDlClose").addEventListener("click", () => closeModalEl("dlModal"));
document.getElementById("dlModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("dlModal")) closeModalEl("dlModal");
});
document.getElementById("btnBrowseDlDir").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_folder?title=选择模组保存目录`);
    if (data.folder) document.getElementById("dlSaveDir").value = data.folder;
});
document.getElementById("btnDlDownload").addEventListener("click", async () => {
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
        closeModalEl("dlModal");
        toast(data.queued ? "已加入下载队列排队" : "单模组下载已启动", "ok");
        resetPage(state.detailBackPage || "pageC");
        switchPage("pageD");
    } catch (err) {
        toast("启动失败：" + err.message, "err");
    }
});

// ================================================================
// 页面 E：本地模组管理（V3.3）——扫描 / 启用 / 禁用 / 删除 / 检查更新 / 一键更新
// ================================================================
document.getElementById("btnBrowseMan").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_folder?title=选择本地 mods 目录`);
    if (data.folder) {
        document.getElementById("manFolder").value = data.folder;
        saveManFolder(data.folder);
    }
});

document.getElementById("btnManScan").addEventListener("click", scanInstalledMods);

// ---------- 步骤切换（V3.7：本地模组向导） ----------
const MAN_VIEWS = { 1: "m-step-scan", 2: "m-step-list" };
let manScanning = false;

function showManStep(n, silent) {
    state.manStep = n;
    Object.entries(MAN_VIEWS).forEach(([step, id]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle("active", Number(step) === n);
    });
    document.querySelectorAll("#manWizardSteps .wstep").forEach(el => {
        const step = Number(el.dataset.step);
        el.classList.toggle("active", step === n);
        el.classList.toggle("done", step < n);
    });
    const next = document.getElementById("btnManScanNext");
    if (next) next.disabled = !state.manMods.length;
    if (n === 2) renderManList();
    if (!silent) {
        const titles = { 1: "选择 mods 目录并扫描", 2: "已安装模组管理" };
        setStatus("步骤 " + n + "：" + titles[n], "");
    }
}

document.getElementById("manWizardSteps").addEventListener("click", (e) => {
    const ws = e.target.closest(".wstep");
    if (!ws) return;
    const step = Number(ws.dataset.step);
    if (step > 1 && !state.manMods.length) {
        toast("请先在步骤 1 完成扫描", "err");
        return;
    }
    showManStep(step);
});

document.getElementById("btnManScanNext").addEventListener("click", () => {
    if (!state.manMods.length) { toast("请先扫描模组", "err"); return; }
    showManStep(2);
});
document.getElementById("btnManListPrev").addEventListener("click", () => showManStep(1));

// 进入页面时检测到已记忆目录自动扫描（V3.7）
async function autoScanMan() {
    if (manScanning) return;
    const folder = document.getElementById("manFolder").value.trim();
    if (!folder) return;
    manScanning = true;
    try {
        await scanInstalledMods();
        if (state.manMods.length) showManStep(2, true);
    } catch (_) {
    } finally {
        manScanning = false;
    }
}

async function scanInstalledMods() {
    const folder = document.getElementById("manFolder").value.trim();
    if (!folder) { toast("请先选择 mods 目录", "err"); return; }
    const btn = document.getElementById("btnManScan");
    setBtnBusy(btn, true);
    showSkeleton("manList", 5);
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
        saveManFolder(folder);
        setStatus("就绪");
        toast(`扫描完成：${data.matched}/${data.total} 已识别`, "ok");
    } catch (e) {
        setStatus("就绪");
        toast("扫描失败：" + e.message, "err");
    } finally {
        setBtnBusy(btn, false);
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
    setBtnBusy(btn, true);
    if (btn) btn.textContent = "检测中…";
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
        if (btn) btn.textContent = "检查更新";
        setBtnBusy(btn, false);
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
    const warnMsg = "⚠ 注意：一键更新将同时更新多个模组，目前无法检测模组之间的版本兼容性。\n请确保更新后模组列表仍能正常启动游戏，如有冲突请手动回退。";
    if (!confirm(`确认更新 ${updates.length} 个模组？\n将下载最新适配版本并移除旧文件。\n\n${warnMsg}`)) return;
    const btn = document.getElementById("btnManUpdate");
    btn.disabled = true;
    try {
        const data = await postJSON(`${API}/download_updates`, {
            updates, mc_version: mc, loader, save_dir: saveDir,
        });
        toast(data.queued ? "更新任务已加入队列" : "模组更新已启动", "ok");
        resetPage("pageE");
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
    if (t.kind === "migrate") return "模组迁移" + (t.mc_version ? ` ${t.mc_version}/${t.loader}` : "");
    return "单模组下载" + (t.mc_version ? ` ${t.mc_version}/${t.loader}` : "");
}

function taskKindLabel(kind) {
    if (kind === "batch") return "批量";
    if (kind === "update") return "更新";
    if (kind === "migrate") return "迁移";
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

function formatEta(sec) {
    if (!sec || !isFinite(sec) || sec <= 0) return "—";
    if (sec < 60) return Math.ceil(sec) + " 秒";
    if (sec < 3600) return Math.ceil(sec / 60) + " 分钟";
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h} 小时${m ? " " + m + " 分" : ""}`;
}

// 解析后端速度文本（如 "1.2 MB/s"）为字节/秒
function parseSpeed(text) {
    const m = String(text || "").match(/^([\d.]+)\s*([KMG]?)B\/s$/i);
    if (!m) return 0;
    const n = parseFloat(m[1]) || 0;
    const u = m[2].toUpperCase();
    const mult = u === "K" ? 1024 : u === "M" ? 1048576 : u === "G" ? 1073741824 : 1;
    return n * mult;
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

// ---------- 任务中心实时统计（V3.7）：运行/排队/已完成 + 整体进度汇总 ----------
function updateTaskStats(tasks, hist) {
    const runEl = document.getElementById("runCount");
    const queEl = document.getElementById("queueCount");
    const doneEl = document.getElementById("doneCount");
    if (runEl) runEl.textContent = tasks.filter(t => t.status === "running").length;
    if (queEl) queEl.textContent = tasks.filter(t => t.status === "pending").length;
    if (doneEl) doneEl.textContent = (hist || []).filter(h => h.status === "completed").length;

    const running = tasks.filter(t => t.status === "running");
    const card = document.getElementById("overallCard");
    if (!card) return;
    if (!running.length) { card.style.display = "none"; return; }
    card.style.display = "";

    let wSum = 0, filesDone = 0, filesTotal = 0, bytesDone = 0, bytesTotal = 0, cumSpeed = 0;
    running.forEach(t => {
        const total = t.total || 0;
        if (total > 0) {
            filesDone += t.done || 0;
            filesTotal += total;
            wSum += taskPct(t) * total;
        }
        bytesDone += t.progress_done || 0;
        bytesTotal += t.progress_total || 0;
        cumSpeed += parseSpeed(t.speed_text);
    });
    const pct = filesTotal ? Math.min(100, wSum / filesTotal) : 0;
    const eta = cumSpeed > 0 && bytesTotal > 0 ? (bytesTotal - bytesDone) / cumSpeed : 0;

    const ovText = document.getElementById("ovText");
    if (ovText) ovText.textContent = running.length > 1 ? `共 ${running.length} 个任务下载中` : "任务下载中";
    const percentEl = document.getElementById("ovPercent");
    if (percentEl) percentEl.textContent = Math.round(pct) + "%";
    const fill = document.getElementById("ovFill");
    if (fill) fill.style.width = pct + "%";
    const speedEl = document.getElementById("ovSpeed");
    if (speedEl) speedEl.textContent = formatBytes(cumSpeed) + "/s";
    const doneFEl = document.getElementById("ovDone");
    if (doneFEl) doneFEl.textContent = filesDone;
    const totalFEl = document.getElementById("ovTotal");
    if (totalFEl) totalFEl.textContent = filesTotal;
    const etaEl = document.getElementById("ovEta");
    if (etaEl) etaEl.textContent = formatEta(eta);
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
        updateTaskStats(tasks, hist);
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
        const accent = document.getElementById("setAccent");
        if (accent && s.accent) { accent.value = s.accent; setAccent(s.accent); }
        const contrast = document.getElementById("setContrast");
        if (contrast && s.contrast) { contrast.value = s.contrast; setContrast(s.contrast); }
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
        accent: document.getElementById("setAccent").value,
        contrast: document.getElementById("setContrast").value,
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
        if (s.accent) setAccent(s.accent);
        if (s.contrast) setContrast(s.contrast);
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
// 页面 I：模组迁移（V3.5）——扫描源目录 → 勾选 → 直接下载到新目录
// ================================================================
document.getElementById("btnBrowseMig").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_folder?title=选择源 mods 目录`);
    if (data.folder) document.getElementById("migFolder").value = data.folder;
});

document.getElementById("btnMigScan").addEventListener("click", scanMigMods);

async function scanMigMods() {
    const folder = document.getElementById("migFolder").value.trim();
    if (!folder) { toast("请先选择源 mods 目录", "err"); return; }
    const btn = document.getElementById("btnMigScan");
    setBtnBusy(btn, true);
    showSkeleton("migList", 5);
    setStatus("扫描中…", "busy");
    try {
        const data = await postJSON(`${API}/scan_mods`, { folder });
        state.migMods = (data.mods || []).map((m, i) => Object.assign(m, { _idx: i, selected: false }));
        renderMigList();
        updateMigCount();
        setStatus("就绪");
        toast(`扫描完成：${data.matched}/${data.total} 已识别`, "ok");
        showIStep(2, true); // V3.6：扫描完成进入勾选步骤
    } catch (e) {
        setStatus("就绪");
        toast("扫描失败：" + e.message, "err");
    } finally {
        setBtnBusy(btn, false);
    }
}

function renderMigList() {
    const box = document.getElementById("migList");
    const mods = state.migMods;
    if (!mods.length) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">暂无扫描结果</div>
                <div class="empty-state-desc">请先选择源目录并点击「扫描源目录」。</div>
            </div>`;
        return;
    }
    const list = [...mods].sort((a, b) => (a.matched ? 1 : 0) - (b.matched ? 1 : 0));
    box.innerHTML = list.map(m => {
        const cls = m.matched ? "" : "unmatched";
        const badge = m.matched
            ? `<span class="m-badge ok">已识别</span>`
            : `<span class="m-badge no">未识别</span>`;
        const src = m.matched
            ? `<span class="chip chip-loader">${escapeHtml(m.source || "modrinth")}</span>` : "";
        const name = (m.metadata && (m.metadata.name || m.metadata.mod_id)) || m.filename;
        const checked = m.selected ? "checked" : "";
        const disabled = m.matched ? "" : "disabled";
        const clickable = m.matched ? ` data-pid="${escapeHtml(m.project_id)}"` : "";
        return `<div class="mod-item ${cls}"${clickable}>
            <input type="checkbox" class="m-check" ${checked} ${disabled} data-idx="${m._idx}" />
            <span class="m-name" title="${escapeHtml(m.filename)}">${escapeHtml(name)}</span>
            ${m.project_id ? `<span class="m-pid">${escapeHtml(m.project_id)}</span>` : `<span class="m-pid">本地模组</span>`}
            <span class="m-pid">${escapeHtml((m.metadata && m.metadata.loader) || "?")}</span>
            ${src}
            ${badge}
            <span class="m-size">${formatBytes(m.size)}</span>
            <span class="m-open"><span class="m-open-chev">›</span></span>
        </div>`;
    }).join("");
    box.querySelectorAll(".m-check").forEach(cb => {
        cb.addEventListener("change", () => {
            state.migMods[Number(cb.dataset.idx)].selected = cb.checked;
            updateMigCount();
        });
    });
    updateMigCount();
}

function updateMigCount() {
    const mods = state.migMods;
    const matched = mods.filter(m => m.matched);
    const selected = matched.filter(m => m.selected);
    const totalEl = document.getElementById("migTotal");
    const selEl = document.getElementById("migSelected");
    if (totalEl) totalEl.textContent = matched.length;
    if (selEl) selEl.textContent = selected.length;
    const sc = document.getElementById("migSelCount");
    if (sc) sc.textContent = selected.length;
    const st = document.getElementById("migSelTotal");
    if (st) st.textContent = matched.length;
    const selNext = document.getElementById("btnISelNext");
    if (selNext) selNext.disabled = !selected.length;
}

// ================================================================
// 页面 I：迁移向导步骤（V3.6）——扫描 → 勾选 → 目标配置 → 确认迁移
// ================================================================
const MIG_WIZARD_VIEWS = {
    1: "i-step-scan",
    2: "i-step-select",
    3: "i-step-config",
    4: "i-step-go",
};

function showIStep(n, silent) {
    state.migStep = n;
    Object.entries(MIG_WIZARD_VIEWS).forEach(([step, id]) => {
        document.getElementById(id).classList.toggle("active", Number(step) === n);
    });
    document.querySelectorAll("#wizardISteps .wstep").forEach(el => {
        const step = Number(el.dataset.step);
        el.classList.toggle("active", step === n);
        el.classList.toggle("done", step < n);
    });
    const hasScan = state.migMods.length > 0;
    const selCount = state.migMods.filter(m => m.matched && m.selected).length;
    const btnScanNext = document.getElementById("btnIScanNext");
    if (btnScanNext) btnScanNext.disabled = !hasScan;
    const btnSelNext = document.getElementById("btnISelNext");
    if (btnSelNext) btnSelNext.disabled = !selCount;
    if (n === 2) renderMigList();
    if (n === 4) fillMigConfirm();
    if (!silent) {
        const titles = { 1: "源目录扫描", 2: "勾选模组", 3: "目标配置", 4: "确认迁移" };
        setStatus("步骤 " + n + "：" + titles[n], "");
    }
}

function fillMigConfirm() {
    document.getElementById("cfMigFolder").textContent = document.getElementById("migFolder").value.trim() || "—";
    const sel = state.migMods.filter(m => m.matched && m.selected && m.project_id);
    document.getElementById("cfMigCount").textContent = sel.length ? sel.length + " 个" : "—";
    document.getElementById("cfMigMc").textContent = document.getElementById("migMc").value.trim() || "—";
    document.getElementById("cfMigLoader").textContent = LOADER_LABELS[document.getElementById("migLoader").value] || "—";
    document.getElementById("cfMigSaveDir").textContent = document.getElementById("migSaveDir").value.trim() || "—";
}

// 步骤指示器点击（仅可回到已完成步骤，后续步骤需校验）
document.getElementById("wizardISteps").addEventListener("click", (e) => {
    const ws = e.target.closest(".wstep");
    if (!ws) return;
    const step = Number(ws.dataset.step);
    if (step > 1 && !state.migMods.length) {
        toast("请先在步骤 1 完成扫描", "err");
        return;
    }
    if ((step === 3 || step === 4) && !state.migMods.some(m => m.matched && m.selected)) {
        toast("请先在步骤 2 勾选模组", "err");
        return;
    }
    if (step === 4 && !document.getElementById("migMc").value.trim()) {
        toast("请先填写目标游戏版本", "err");
        return;
    }
    showIStep(step);
});

document.getElementById("btnIScanNext").addEventListener("click", () => {
    if (!state.migMods.length) { toast("请先扫描源目录", "err"); return; }
    showIStep(2);
});
document.getElementById("btnISelPrev").addEventListener("click", () => showIStep(1));
document.getElementById("btnISelNext").addEventListener("click", () => {
    if (!state.migMods.some(m => m.matched && m.selected)) { toast("请至少勾选一个模组", "err"); return; }
    showIStep(3);
});
document.getElementById("btnIConfPrev").addEventListener("click", () => showIStep(2));
document.getElementById("btnIConfNext").addEventListener("click", () => {
    if (!state.migMods.some(m => m.matched && m.selected)) { toast("请至少勾选一个模组", "err"); return; }
    showIStep(4);
});
document.getElementById("btnIGoPrev").addEventListener("click", () => showIStep(3));

document.getElementById("btnMigAll").addEventListener("click", () => {
    state.migMods.forEach(m => { if (m.matched) m.selected = true; });
    renderMigList();
});
document.getElementById("btnMigNone").addEventListener("click", () => {
    state.migMods.forEach(m => { m.selected = false; });
    renderMigList();
});
document.getElementById("btnMigInvert").addEventListener("click", () => {
    state.migMods.forEach(m => { if (m.matched) m.selected = !m.selected; });
    renderMigList();
});

document.getElementById("migList").addEventListener("click", (e) => {
    if (e.target.closest(".m-check")) return;
    const item = e.target.closest(".mod-item");
    if (!item) return;
    const pid = item.dataset.pid;
    if (pid) openDetail(pid, "pageI");
    else toast("未识别模组无法查看详情", "err");
});

document.getElementById("btnBrowseMigDir").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_folder?title=选择目标保存目录`);
    if (data.folder) document.getElementById("migSaveDir").value = data.folder;
});

document.getElementById("btnMigGo").addEventListener("click", async () => {
    const mc = document.getElementById("migMc").value.trim();
    const loader = document.getElementById("migLoader").value;
    const saveDir = document.getElementById("migSaveDir").value.trim();
    const mods = state.migMods
        .filter(m => m.matched && m.selected && m.project_id)
        .map(m => ({
            project_id: m.project_id,
            name: (m.metadata && (m.metadata.name || m.metadata.mod_id)) || m.filename,
            source: m.source || "modrinth",
        }));
    if (!mods.length) { toast("请至少勾选一个已识别模组", "err"); return; }
    if (!mc) { toast("请填写目标游戏版本", "err"); return; }
    if (!saveDir) { toast("请填写目标保存目录", "err"); return; }
    const source = document.getElementById("migSource").value;
    const btn = document.getElementById("btnMigGo");
    btn.disabled = true;
    setStatus("正在创建迁移任务…", "busy");
    try {
        const data = await postJSON(`${API}/migrate_mods`, {
            mods, mc_version: mc, loader, save_dir: saveDir, source: source || null,
        });
        savePref(mc, loader, saveDir);
        toast(data.queued ? "迁移任务已加入队列排队" : `迁移任务已启动（${mods.length} 个模组）`, "ok");
        resetPage("pageI");
        switchPage("pageD");
    } catch (err) {
        toast("启动失败：" + err.message, "err");
    } finally {
        btn.disabled = false;
        setStatus("就绪");
    }
});

// ================================================================
// 页面 J：自定义模组包（V3.6）——悬浮框搜索添加（自动附带依赖）/ 自定义文件名 / 导出同格式 JSON
// ================================================================
const CUSTOM_KEY = "mlw_custom_mods";

function loadCustomMods() {
    try {
        state.customMods = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]");
    } catch (_) {
        state.customMods = [];
    }
    if (!Array.isArray(state.customMods)) state.customMods = [];
}
function saveCustomMods() {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(state.customMods)); } catch (_) {}
}

// ================================================================
// 页面 J：我的清单 / 自定义模组包（V3.6）——悬浮框搜索添加 + 自动前置依赖 + 悬浮框导出
// ================================================================

// 悬浮框开合动效（V3.6.1）：关闭时先播反向动画再隐藏
function openModalEl(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("closing");
    el.style.display = "flex";
}
function closeModalEl(id) {
    const el = document.getElementById(id);
    if (!el || el.classList.contains("closing")) return;
    el.classList.add("closing");
    setTimeout(() => {
        el.classList.remove("closing");
        el.style.display = "none";
    }, 170);
}

// ---------- 添加模组悬浮框 ----------
function openCustomAddModal() {
    state.customSel = new Map();
    const q = document.getElementById("customQuery");
    if (q) q.value = "";
    document.getElementById("customLoader").value = "";
    const box = document.getElementById("customResults");
    box.innerHTML = `
        <div class="empty-state compact">
            <div class="empty-state-title">输入关键词搜索模组并勾选添加</div>
            <div class="empty-state-desc">勾选模组后将显示其前置依赖，确认时自动一并添加。</div>
        </div>`;
    updateCustomSelUI();
    openModalEl("customAddModal");
    setTimeout(() => { if (q) q.focus(); }, 60);
}
function closeCustomAddModal() {
    closeModalEl("customAddModal");
}
document.getElementById("btnCustomAdd").addEventListener("click", openCustomAddModal);
document.getElementById("btnCustomAddClose").addEventListener("click", closeCustomAddModal);
document.getElementById("customAddModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("customAddModal")) closeCustomAddModal();
});

document.getElementById("btnCustomSearch").addEventListener("click", () => searchCustom());
document.getElementById("customQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") searchCustom(); });
document.getElementById("customLoader").addEventListener("change", () => searchCustom());

async function searchCustom() {
    const query = document.getElementById("customQuery").value.trim();
    const loader = document.getElementById("customLoader").value;
    const box = document.getElementById("customResults");
    setBtnBusy(document.getElementById("btnCustomSearch"), true);
    showSkeleton("customResults", 4);
    try {
        const data = await postJSON(`${API}/search_mod`, {
            query, loader: loader || null, limit: 20, offset: 0,
        });
        state.customLastHits = data.hits || [];
        renderCustomResults(state.customLastHits);
    } catch (e) {
        box.innerHTML = `<div class="empty-state compact"><div class="empty-state-title">搜索失败</div><div class="empty-state-desc">${escapeHtml(e.message)}</div></div>`;
    } finally {
        setBtnBusy(document.getElementById("btnCustomSearch"), false);
    }
}

function renderCustomResults(hits) {
    const box = document.getElementById("customResults");
    if (!box) return;
    if (!hits.length) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">未找到匹配的模组</div>
                <div class="empty-state-desc">可尝试直接输入 project ID 精确搜索。</div>
            </div>`;
        return;
    }
    const inCustom = {};
    state.customMods.forEach(m => { inCustom[m.project_id] = true; });
    box.innerHTML = hits.map(h => {
        const pid = String(h.project_id);
        const icon = h.icon_url
            ? `<img class="cat-icon" src="${escapeHtml(h.icon_url)}" onerror="this.style.display='none'" />`
            : `<div class="cat-icon cat-icon-ph">${escapeHtml((h.title || "?").charAt(0).toUpperCase())}</div>`;
        const cats = (h.categories || []).slice(0, 4).map(c =>
            `<span class="chip">${escapeHtml(c)}</span>`).join("");
        const added = inCustom[pid];
        const checked = state.customSel.has(pid) ? "checked" : "";
        const disabled = added ? "disabled" : "";
        const stateTag = added ? `<span class="m-badge ok">已在清单</span>` : "";
        let depsLine = "";
        if (added) {
            depsLine = "";
        } else if (state.customDepLoading[pid]) {
            depsLine = `<div class="c-deps"><span class="c-deps-tag">正在读取前置依赖…</span></div>`;
        } else if (state.customDepInfo[pid]) {
            const deps = state.customDepInfo[pid];
            depsLine = deps.length
                ? `<div class="c-deps"><b>必需依赖</b>${deps.map(d => `<span class="chip">${escapeHtml(d.name)}</span>`).join("")}</div>`
                : `<div class="c-deps"><span class="c-deps-tag">无必需依赖</span></div>`;
        }
        return `<div class="cat-item" data-pid="${escapeHtml(pid)}">
            <input type="checkbox" class="c-sel" data-pid="${escapeHtml(pid)}" data-name="${escapeHtml(h.title)}" ${checked} ${disabled} title="${added ? "该模组已在清单中" : "勾选添加到清单"}" />
            ${icon}
            <div class="cat-main">
                <div class="cat-title">${escapeHtml(h.title)}${stateTag}</div>
                <div class="cat-desc">${escapeHtml(h.description || "").slice(0, 90)}</div>
                <div class="cat-tags">${cats}<span class="chip chip-loader">modrinth</span><span class="m-pid">${escapeHtml(pid)}</span></div>
                ${depsLine}
            </div>
            <div class="cat-meta">
                <span class="cat-stat"><b>${formatCount(h.downloads)}</b> 下载</span>
                <span class="cat-stat"><b>${formatCount(h.followers)}</b> 收藏</span>
            </div>
        </div>`;
    }).join("");
}

document.getElementById("customResults").addEventListener("click", (e) => {
    const cb = e.target.closest(".c-sel");
    if (!cb) return;
    const pid = cb.dataset.pid;
    if (cb.checked) {
        state.customSel.set(pid, { pid, name: cb.dataset.name, source: "modrinth" });
        loadCustomDeps(pid);
    } else {
        state.customSel.delete(pid);
    }
    updateCustomSelUI();
});

// 读取已勾选模组的必需前置依赖（用于展示与确认时自动附带）
async function loadCustomDeps(pid) {
    if (state.customDepInfo[pid] !== undefined || state.customDepLoading[pid]) return;
    state.customDepLoading[pid] = true;
    renderCustomResults(state.customLastHits);
    try {
        const d = await getJSON(`${API}/project/${encodeURIComponent(pid)}`);
        const latest = (d.versions || [])[0];
        const depPids = [];
        for (const dep of (latest && latest.dependencies) || []) {
            if (!dep || dep.project_id === undefined || dep.project_id === null) continue;
            if (dep.dependency_type === "required") depPids.push(String(dep.project_id));
        }
        const infos = [];
        await Promise.all(depPids.map(async dp => {
            try {
                const dd = await getJSON(`${API}/project/${encodeURIComponent(dp)}`);
                infos.push({ project_id: dp, name: dd.title || dd.project_id || dp });
            } catch (_) {
                infos.push({ project_id: dp, name: dp });
            }
        }));
        state.customDepInfo[pid] = infos;
    } catch (_) {
        state.customDepInfo[pid] = state.customDepInfo[pid] || [];
    } finally {
        state.customDepLoading[pid] = false;
        if (document.getElementById("customAddModal").style.display !== "none") {
            renderCustomResults(state.customLastHits);
        }
    }
}

function updateCustomSelUI() {
    const n = state.customSel.size;
    const hint = document.getElementById("customSelHint");
    const btn = document.getElementById("btnCustomAddConfirm");
    if (btn) {
        btn.disabled = !n;
        btn.textContent = `确认添加（${n}）`;
    }
    if (!hint) return;
    if (!n) { hint.textContent = "已选 0 项"; return; }
    const depSeen = new Set();
    for (const pid of state.customSel.keys()) {
        for (const d of (state.customDepInfo[pid] || [])) {
            if (!state.customSel.has(d.project_id) && !state.customMods.some(m => m.project_id === d.project_id)) {
                depSeen.add(d.project_id);
            }
        }
    }
    hint.textContent = depSeen.size ? `已选 ${n} 项 · 将附带 ${depSeen.size} 项必需依赖` : `已选 ${n} 项`;
}

document.getElementById("btnCustomAddConfirm").addEventListener("click", confirmAddCustom);

function confirmAddCustom() {
    if (!state.customSel.size) { toast("请先勾选模组", "err"); return; }
    const toAdd = [];
    const seen = new Set(state.customMods.map(m => m.project_id));
    let depAdded = 0;
    const push = (pid, name, isDep) => {
        if (seen.has(pid)) return;
        seen.add(pid);
        toAdd.push({ project_id: pid, name, source: "modrinth", custom_name: name });
        if (isDep) depAdded++;
    };
    for (const sel of state.customSel.values()) {
        push(sel.pid, sel.name, false);
        for (const d of (state.customDepInfo[sel.pid] || [])) push(d.project_id, d.name, true);
    }
    if (!toAdd.length) {
        toast("所选模组及其依赖均已在清单中", "warn");
        closeCustomAddModal();
        return;
    }
    state.customMods.push(...toAdd);
    saveCustomMods();
    renderCustomList();
    closeCustomAddModal();
    toast(depAdded
        ? `已添加 ${toAdd.length} 个模组到清单，包含 ${depAdded} 个前置模组`
        : `已添加 ${toAdd.length} 个模组到清单`, "ok");
}

// ---------- 导出悬浮框 ----------
function openCustomExportModal() {
    const mc = document.getElementById("customMc");
    if (mc && !mc.value) mc.value = pref.mc || "";
    openModalEl("customExportModal");
}
function closeCustomExportModal() {
    closeModalEl("customExportModal");
}
document.getElementById("btnCustomExport").addEventListener("click", openCustomExportModal);
document.getElementById("btnCustomExportClose").addEventListener("click", closeCustomExportModal);
document.getElementById("btnCustomExportCancel").addEventListener("click", closeCustomExportModal);
document.getElementById("customExportModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("customExportModal")) closeCustomExportModal();
});
document.getElementById("btnCustomExportGo").addEventListener("click", exportCustomList);

async function exportCustomList() {
    const mods = state.customMods;
    if (!mods.length) { toast("清单为空", "err"); return; }
    const mc = document.getElementById("customMc").value.trim();
    const loader = document.getElementById("customLoaderMeta").value;
    let savePath = document.getElementById("customPath").value.trim();
    if (!savePath) {
        const data = await getJSON(`${API}/pick_save?title=导出自定义清单&filename=modpack.json&ext=json`);
        if (!data.path) return;
        savePath = data.path;
        document.getElementById("customPath").value = savePath;
    }
    try {
        const data = await postJSON(`${API}/export_json`, {
            mods: mods.map(m => ({ project_id: m.project_id, name: m.custom_name || m.name, source: m.source || "modrinth" })),
            game_version: mc,
            loader,
            save_path: savePath,
        });
        closeCustomExportModal();
        toast(`已导出 ${data.count} 个模组到：${data.save_path}`, "ok");
    } catch (err) {
        toast("导出失败：" + err.message, "err");
    }
}

// ---------- 清单展示与操作 ----------
function renderCustomList() {
    const box = document.getElementById("customList");
    const mods = state.customMods;
    document.getElementById("customCount").textContent = mods.length;
    if (!mods.length) {
        box.innerHTML = `
            <div class="empty-state compact">
                <div class="empty-state-title">清单为空</div>
                <div class="empty-state-desc">点击右上角「添加模组」，将自动附带所需前置依赖；点击每行文件名可自定义。</div>
            </div>`;
        return;
    }
    box.innerHTML = mods.map((m, i) => `
        <div class="mod-item custom-item" data-pid="${escapeHtml(m.project_id)}">
            <span class="m-name c-name" title="点击查看详情">${escapeHtml(m.custom_name || m.name || m.project_id)}</span>
            <span class="m-pid">${escapeHtml(m.project_id)}</span>
            <span class="chip chip-loader">${escapeHtml(m.source || "modrinth")}</span>
            <input type="text" class="input input-sm c-rename" value="${escapeHtml(m.custom_name || m.name || "")}" data-idx="${i}" title="自定义文件名 / 显示名" />
            <span class="m-open custom-actions">
                <button class="c-arrow" data-idx="${i}" data-dir="-1" title="上移">↑</button>
                <button class="c-arrow" data-idx="${i}" data-dir="1" title="下移">↓</button>
                <button class="c-del" data-idx="${i}" title="移除">✕</button>
            </span>
        </div>`).join("");
}

document.getElementById("customList").addEventListener("click", (e) => {
    const up = e.target.closest(".c-arrow");
    if (up) {
        const i = Number(up.dataset.idx);
        const dir = Number(up.dataset.dir);
        const j = i + dir;
        if (j < 0 || j >= state.customMods.length) return;
        [state.customMods[i], state.customMods[j]] = [state.customMods[j], state.customMods[i]];
        saveCustomMods();
        renderCustomList();
        return;
    }
    const del = e.target.closest(".c-del");
    if (del) {
        state.customMods.splice(Number(del.dataset.idx), 1);
        saveCustomMods();
        renderCustomList();
        return;
    }
    const nameBtn = e.target.closest(".c-name");
    if (nameBtn) {
        const item = nameBtn.closest(".mod-item");
        if (item && item.dataset.pid) openDetail(item.dataset.pid, "pageJ");
        return;
    }
});

document.getElementById("customList").addEventListener("input", (e) => {
    const inp = e.target.closest(".c-rename");
    if (!inp) return;
    const i = Number(inp.dataset.idx);
    if (!state.customMods[i]) return;
    state.customMods[i].custom_name = inp.value;
    saveCustomMods();
});

document.getElementById("btnCustomClear").addEventListener("click", () => {
    if (!state.customMods.length) return;
    if (!confirm("确定清空自定义模组包清单？")) return;
    state.customMods = [];
    state.customSel = new Map();
    state.customDepInfo = {};
    saveCustomMods();
    renderCustomList();
    if (document.getElementById("customAddModal").style.display !== "none") {
        renderCustomResults(state.customLastHits);
    }
    toast("已清空清单", "ok");
});

document.getElementById("btnBrowseCustom").addEventListener("click", async () => {
    const data = await getJSON(`${API}/pick_save?title=导出自定义清单&filename=modpack.json&ext=json`);
    if (data.path) document.getElementById("customPath").value = data.path;
});

// ================================================================
// 启动
// ================================================================
setStatus("就绪");
loadMcVersions();
startQueuePoll();
loadSettings();
loadCustomMods(); // V3.5：恢复自定义模组包清单
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
        // 更新日志（V3.3.1：读取本地 CHANGELOG.md，支持点击版本号跳转 GitHub Release）
(async function initChangelog() {
    const clRoot = document.getElementById("changelogRoot");
    if (!clRoot) return;
    try {
        const resp = await fetch(`${API}/changelog`);
        const data = await resp.json();
        const md = data.content || "";
        if (!md.trim()) return;
        const sections = md.split(/^##\s+/m)
            .map(s => s.trim())
            .filter(s => /^v?\d+\.\d+\.\d+/.test(s));
        clRoot.innerHTML = sections.map((sec, idx) => {
            const lines = sec.trim().split("\n");
            const titleLine = lines[0];
            const verMatch = titleLine.match(/^v?(\d+\.\d+\.\d+)/);
            const version = verMatch ? verMatch[1] : "";
            const releaseUrl = version ? `https://github.com/JonathanSssst/ModList-Weaver/releases/tag/v${version}` : "";
            const rest = lines.slice(1).join("\n").trim();
            const open = idx === 0;
            const dateMatch = titleLine.match(/\((\d{4}-\d{2})\)/);
            const dateStr = dateMatch ? dateMatch[1] : "";
            return `
            <div class="cl-item cl-fold" data-open="${open ? 1 : 0}">
                <div class="cl-head" role="button" title="点击展开/收起">
                    <span class="cl-ver">
                        ${version ? `<a href="${releaseUrl}" target="_blank" rel="noopener">v${version}</a>` : ''}
                    </span>
                    ${dateStr ? `<span class="cl-date">${dateStr}</span>` : ''}
                    <span class="cl-fold-hint">▾</span>
                </div>
                ${rest ? `<div class="cl-fold-body">${renderChangelogBody(rest)}</div>` : ''}
            </div>`;
        }).join("");
        clRoot.addEventListener("click", (e) => {
            const head = e.target.closest(".cl-head");
            if (!head) return;
            const item = head.closest(".cl-item");
            if (!item) return;
            const next = item.getAttribute("data-open") === "1" ? "0" : "1";
            item.setAttribute("data-open", next);
        });
    } catch (_) {}
})();

function renderChangelogBody(text) {
    let html = "";
    let inList = false;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) {
            if (inList) { html += "</ul>"; inList = false; }
            continue;
        }
        if (line.startsWith("### ")) {
            if (inList) { html += "</ul>"; inList = false; }
            html += `<h4>${escapeHtml(line.slice(4))}</h4>`;
        } else if (line.startsWith("## ")) {
            if (inList) { html += "</ul>"; inList = false; }
            html += `<h3>${escapeHtml(line.slice(3))}</h3>`;
        } else if (line.startsWith("- ")) {
            if (!inList) { html += "<ul class=\"cl-list\">"; inList = true; }
            html += `<li>${renderChangelogItem(line.slice(2))}</li>`;
        } else {
            if (inList) { html += "</ul>"; inList = false; }
            html += `<p>${renderChangelogItem(line)}</p>`;
        }
    }
    if (inList) { html += "</ul>"; }
    return html;
}

function renderChangelogItem(text) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/`(.+?)`/g, "<code>$1</code>");
}
    } catch (_) {}
})();
