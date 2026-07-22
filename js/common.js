/**
 * common.js — 所有页面共享的基础模块
 * 包含：登录认证、时间工具、图片容错、悬浮下拉框、列宽拖拽
 */

// ==================== 全局常量 ====================
const AUTH_KEY = 'salesReport_auth';
const API_BASE = 'http://192.168.50.105:5000';
const FRONT_PAGE = 'index.html';
const PAGE_ACCESS_MAP = {
    'sales.html': 'sales',
    'inventory.html': 'inventory',
    'inventory_value.html': 'value',
    'finance_profit.html': 'finance',
    'vc_replenishment_model.html': 'replenishment',
    'shipment_audit.html': 'replenishment',
    'history.html': 'history',
    'history_sales_query.html': 'history'
};
const NAV_ITEMS = [
    { key: 'home', label: '首页', href: FRONT_PAGE, tag: null },
    { key: 'sales', label: '销售', href: 'sales.html', tag: 'sales' },
    { key: 'inventory', label: '库存', href: 'inventory.html', tag: 'inventory' },
    { key: 'value', label: '库存金额', href: 'inventory_value.html', tag: 'value' },
    { key: 'finance', label: '财务', href: 'finance_profit.html', tag: 'finance' },
    { key: 'replenishment', label: '发货', href: 'vc_replenishment_model.html', tag: 'replenishment' },
    { key: 'history', label: '历史', href: 'history.html', tag: 'history' },
    { key: 'product', label: '产品', href: 'duffle-bag-report.html', tag: null }
];

// ==================== 登录认证 ====================

function getStoredAuth() {
    try {
        const raw = localStorage.getItem(AUTH_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
}

function saveAuth(data) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(data));
}

function mergeAuth(partial) {
    const current = getStoredAuth() || {};
    saveAuth(Object.assign({}, current, partial));
}

function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
}

function getToken() {
    const auth = getStoredAuth();
    if (!auth || !auth.token) return null;
    // 客户端侧粗略检查过期（精确校验在服务端）
    if (auth.expires_at && Date.now() / 1000 > auth.expires_at) {
        clearAuth();
        return null;
    }
    return auth.token;
}

function isLoggedIn() {
    return !!getToken();
}

function getUserTags() {
    const auth = getStoredAuth();
    return auth ? auth.tags || [] : [];
}

function getCurrentPageName() {
    const name = window.location.pathname.split('/').pop() || FRONT_PAGE;
    return name.toLowerCase();
}

function getCurrentPageTag() {
    return PAGE_ACCESS_MAP[getCurrentPageName()] || null;
}

function hasPageTag(pageTag) {
    if (!pageTag) return true;
    return getUserTags().indexOf(pageTag) !== -1;
}

function requirePageTag(pageTag) {
    if (!hasPageTag(pageTag)) {
        alert('您没有权限访问此页面');
        return false;
    }
    return true;
}

function showLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    const errorEl = document.getElementById('loginError');
    const passEl = document.getElementById('loginPass');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    if (errorEl) errorEl.textContent = '';
    if (passEl) passEl.value = '';
}

function hideLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.add('hidden');
}

function logout() {
    clearAuth();
    renderSidebar('home');
    renderLogoutButton();
    if (getCurrentPageName() === FRONT_PAGE) {
        showLoginOverlay();
        return;
    }
    window.location.href = FRONT_PAGE + '?login=1';
}

function renderLogoutButton() {
    const loggedIn = !!getToken();
    document.querySelectorAll('.logout-btn').forEach(function(btn) {
        btn.remove();
    });

    if (!loggedIn) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'logout-btn';
    btn.textContent = '退出登录';
    btn.onclick = logout;

    const headerRight = document.querySelector('.top-header .header-right');
    if (headerRight) {
        headerRight.insertBefore(btn, headerRight.firstChild);
        return;
    }

    if (getCurrentPageName() === FRONT_PAGE) {
        const frontContent = document.querySelector('.front-content');
        if (frontContent) {
            btn.classList.add('front-logout-btn');
            frontContent.insertBefore(btn, frontContent.firstChild);
        }
    }
}

function renderSidebar(activeKey) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    const tags = getUserTags();
    const loggedIn = !!getToken();
    const currentPage = getCurrentPageName();
    const currentTag = getCurrentPageTag();
    const resolvedActiveKey = activeKey || sidebar.getAttribute('data-active-page') || currentTag || (currentPage === FRONT_PAGE ? 'home' : '');

    const visibleItems = NAV_ITEMS.filter(function(item) {
        if (!loggedIn) return item.key === 'home';
        return !item.tag || tags.indexOf(item.tag) !== -1;
    });

    sidebar.innerHTML = '<div class="sidebar-logo"></div>' + visibleItems.map(function(item) {
        const activeClass = item.key === resolvedActiveKey ? ' active' : '';
        const iconStyle = item.key === resolvedActiveKey ? ' style="background-color:#fff;"' : '';
        return '<a class="nav-item' + activeClass + '" href="' + item.href + '">' +
            '<div class="nav-icon-placeholder"' + iconStyle + '></div>' + item.label +
            '</a>';
    }).join('');
    renderLogoutButton();
}

function goToFrontPage(reason) {
    const query = reason ? ('?' + encodeURIComponent(reason) + '=1') : '';
    if (getCurrentPageName() === FRONT_PAGE) {
        showLoginOverlay();
        return;
    }
    window.location.href = FRONT_PAGE + query;
}

async function refreshCurrentUser() {
    const token = getToken();
    if (!token) return null;

    const res = await fetch(API_BASE + '/api/user/info', {
        headers: { 'Authorization': 'Bearer ' + token }
    });

    if (res.status === 401) {
        clearAuth();
        return null;
    }

    const data = await res.json();
    if (!res.ok || data.status !== 'success') {
        throw new Error(data.detail || ('HTTP ' + res.status));
    }

    // 每次进入页面都以服务端返回的 tags 覆盖本地缓存，避免权限变动后继续沿用旧权限。
    mergeAuth({
        user: data.user,
        tags: data.tags || []
    });
    return getStoredAuth();
}

async function requireFreshAuth(options) {
    options = options || {};
    const pageTag = options.pageTag !== undefined ? options.pageTag : getCurrentPageTag();
    const onAuthorized = options.onAuthorized;
    const activeKey = options.activeKey;

    if (!getToken()) {
        clearAuth();
        goToFrontPage('login');
        return null;
    }

    // 先用本地缓存渲染一次侧边栏，避免等待 /api/user/info 时出现空白菜单。
    // 数据加载和权限放行仍然必须等服务端校验通过，所以下方会在刷新 tags 后再渲染一次。
    renderSidebar(activeKey);

    let auth = null;
    try {
        auth = await refreshCurrentUser();
    } catch(e) {
        console.error('登录状态校验失败:', e);
        clearAuth();
        goToFrontPage('login');
        return null;
    }

    if (!auth) {
        goToFrontPage('login');
        return null;
    }

    renderSidebar(activeKey);

    if (!hasPageTag(pageTag)) {
        goToFrontPage('denied');
        return null;
    }

    hideLoginOverlay();
    if (typeof onAuthorized === 'function') {
        onAuthorized(auth);
    }
    return auth;
}

function initProtectedPage(pageTag, onAuthorized, activeKey) {
    document.addEventListener('DOMContentLoaded', function() {
        requireFreshAuth({
            pageTag: pageTag,
            onAuthorized: onAuthorized,
            activeKey: activeKey
        });
    });
}

function initPublicPage(options) {
    options = options || {};
    document.addEventListener('DOMContentLoaded', async function() {
        showEntryNotice();
        if (!getToken()) {
            if (options.redirectAnonymous) {
                goToFrontPage('login');
            } else {
                renderSidebar(options.activeKey || 'home');
                showLoginOverlay();
            }
            return;
        }

        try {
            await refreshCurrentUser();
            renderSidebar(options.activeKey);
            renderLogoutButton();
            hideLoginOverlay();
            if (typeof options.onAuthorized === 'function') {
                options.onAuthorized(getStoredAuth());
            }
        } catch(e) {
            console.error('登录状态校验失败:', e);
            clearAuth();
            if (options.redirectAnonymous) {
                goToFrontPage('login');
            } else {
                renderSidebar(options.activeKey || 'home');
                renderLogoutButton();
                showLoginOverlay();
            }
        }
    });
}

function showEntryNotice() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('denied') === '1') {
        alert('您没有权限访问该页面');
        history.replaceState(null, '', FRONT_PAGE);
    }
}

async function doLogin() {
    const username = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');

    if (!username || !password) {
        errorEl.textContent = '请输入用户名和密码';
        return;
    }

    btn.textContent = '登录中...';
    btn.disabled = true;
    errorEl.textContent = '';

    try {
        const res = await fetch(API_BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        });
        const data = await res.json();

        if (res.ok && data.status === 'success') {
            saveAuth({
                token: data.token,
                user: data.user,
                tags: data.tags,
                expires_at: Math.floor(Date.now() / 1000) + data.expires_in
            });
            hideLoginOverlay();
            renderSidebar();
            renderLogoutButton();
            // 由各页面自行注册 onLoginSuccess 回调来加载数据
            if (typeof onLoginSuccess === 'function') {
                onLoginSuccess();
            }
        } else {
            errorEl.textContent = data.detail || '登录失败，请重试';
        }
    } catch(e) {
        errorEl.textContent = '无法连接服务器，请检查网络';
        console.error('登录异常:', e);
    } finally {
        btn.textContent = '登 录';
        btn.disabled = false;
    }
}

// ==================== 时间工具 ====================

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getCalculatedTime() {
    const now = new Date();
    const currentMinutes = now.getMinutes();
    if (currentMinutes < 10) now.setHours(now.getHours() - 1);
    now.setMinutes(10);
    return formatDate(now);
}

function startTimeDisplay() {
    const timeElement = document.getElementById('target-time');
    if (!timeElement) return;
    timeElement.textContent = getCalculatedTime();
    setInterval(() => { timeElement.textContent = getCalculatedTime(); }, 10000);
}

// ==================== 图片容错 ====================

window.handleImageError = function(imgElement) {
    let retries = parseInt(imgElement.getAttribute('data-retries') || '0');
    const maxRetries = 3;

    if (retries < maxRetries) {
        imgElement.setAttribute('data-retries', retries + 1);
        const waitTime = 1500 * (retries + 1);
        setTimeout(() => {
            let currentSrc = imgElement.src;
            if (currentSrc.includes('&_t=')) {
                currentSrc = currentSrc.replace(/&_t=\d+/, '&_t=' + new Date().getTime());
            } else {
                currentSrc = currentSrc + '&_t=' + new Date().getTime();
            }
            imgElement.src = currentSrc;
        }, waitTime);
    } else {
        imgElement.onerror = null;
        imgElement.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';
    }
};

// ==================== 悬浮下拉框 ====================

/**
 * 为 ASIN 文本添加亚马逊跳转小按钮
 * 按钮默认透明，仅在行悬浮时显示，防止复制 ASIN 时误触
 */
function renderAsinWithLink(asin) {
    if (!asin || asin === '-' || asin.trim() === '') return asin || '-';
    var encoded = encodeURIComponent(asin);
    return '<span class="asin-cell">' + asin +
        '<a class="asin-link-btn" href="https://www.amazon.com/dp/' + encoded +
        '" target="_blank" title="在亚马逊查看 ' + asin + '">↗</a></span>';
}

function renderCollapsibleList(listData, withLinks) {
    if (!listData || listData.length === 0) return '-';
    if (listData.length === 1) return withLinks ? renderAsinWithLink(listData[0]) : listData[0];

    var first = withLinks ? renderAsinWithLink(listData[0]) : listData[0];
    var allItems = listData.map(function(item) {
        return withLinks ? renderAsinWithLink(item) : item;
    }).join('<br>');
    return `
        <div class="dropdown-container">
            <span>${first}</span><br>
            <span class="action-link" style="font-size: 10px;" onclick="toggleDropdown(event, this)">展开...</span>
            <div class="dropdown-list">${allItems}</div>
        </div>
    `;
}

window.toggleDropdown = function(event, btn) {
    event.stopPropagation();

    const dropdown = btn.nextElementSibling;
    const isCurrentlyShow = dropdown.classList.contains('show');

    document.querySelectorAll('.dropdown-list').forEach(list => {
        list.classList.remove('show');
    });

    if (!isCurrentlyShow) {
        dropdown.classList.add('show');
    }
};

// ==================== 列宽拖拽 + localStorage 持久化 ====================

(function initColumnResize() {
    const pageName = window.location.pathname.split('/').pop().replace('.html', '') || 'dashboard';
    const STORAGE_KEY = `dashboard_columns_${pageName}`;

    let resizeState = null;

    function getSavedWidths() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch(e) { return {}; }
    }

    function saveAllWidths() {
        try {
            const ths = document.querySelectorAll('table thead th');
            const widthMap = {};
            ths.forEach((th, i) => {
                widthMap[i] = th.offsetWidth;
            });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(widthMap));
            // 通知页面列宽已变更（如冻结列需要更新偏移）
            if (typeof window._onColumnWidthsChanged === 'function') {
                window._onColumnWidthsChanged();
            }
        } catch(e) {}
    }

    function applySavedWidths() {
        const widths = getSavedWidths();
        const ths = document.querySelectorAll('table thead th');
        ths.forEach((th, i) => {
            if (widths[i]) {
                th.style.width = widths[i] + 'px';
                th.style.minWidth = widths[i] + 'px';
                th.style.maxWidth = 'none';
                th.dataset.resized = 'true';
            }
        });
        // 应用已保存宽度后通知页面更新冻结列
        if (typeof window._onColumnWidthsChanged === 'function') {
            window._onColumnWidthsChanged();
        }
    }

    function initResizeHandles() {
        const ths = document.querySelectorAll('table thead th');
        ths.forEach((th, i) => {
            const handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                resizeState = {
                    th: th,
                    index: i,
                    startX: e.clientX,
                    startWidth: th.offsetWidth
                };
                handle.classList.add('active');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
            });
            th.appendChild(handle);
        });
    }

    document.addEventListener('mousemove', function(e) {
        if (!resizeState) return;
        const diff = e.clientX - resizeState.startX;
        const newWidth = Math.max(40, resizeState.startWidth + diff);
        const th = resizeState.th;
        th.style.width = newWidth + 'px';
        th.style.minWidth = newWidth + 'px';
        th.style.maxWidth = 'none';
        th.dataset.resized = 'true';
    });

    document.addEventListener('mouseup', function() {
        if (!resizeState) return;
        document.querySelectorAll('.resize-handle').forEach(function(h) { h.classList.remove('active'); });
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        saveAllWidths();
        resizeState = null;
    });

    // 延迟初始化，确保 DOM 中的表格已渲染
    window._initColumnResize = function() {
        initResizeHandles();
        applySavedWidths();
    };
})();

// ==================== 全局事件监听 ====================

// 回车键快捷登录
document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !isLoggedIn()) {
        doLogin();
    }
});

// 点击页面空白处自动关闭悬浮框
document.addEventListener('click', function(e) {
    if (!e.target.closest('.dropdown-container')) {
        document.querySelectorAll('.dropdown-list').forEach(list => {
            list.classList.remove('show');
        });
    }
});
