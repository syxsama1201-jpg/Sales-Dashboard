/**
 * inventory.js — 库存管理专属逻辑
 * 依赖：common.js 必须先加载
 *
 * 卡片和表格的字段映射可根据飞书多维表格的实际字段名，
 * 修改下方的 FIELD_MAP 配置对象即可。
 */

// ==================== 字段映射配置（按你的飞书表格字段名修改） ====================
const FIELD_MAP = {
    // 卡片汇总字段
    '包含在途': '包含在途',
    '不含在途': '不含在途',
    '海外库存总量': '海外库存总量',
    '供应商库存总量': '供应商库存总量',
    '供应商在途总量': '供应商在途总量',
    // 表格显示字段
    '产品名称': '产品名称',
    '产品图': '产品图',
    '父ASIN': '父ASIN',
    '子ASIN': '子ASIN',
    'MSKU': 'MSKU',
    'FBA库存': 'FBA库存',
    'FBA在途': 'FBA在途',
    '西邮库存': '西邮库存',
    'LNK库存': 'LNK库存',
    '杰戈工厂库存': '杰戈工厂库存',
    '惠安工厂库存': '惠安工厂库存',
    '泉州工厂库存': '泉州工厂库存',
    '江西工厂库存': '江西工厂库存',
    '杰戈工厂在途': '杰戈工厂在途',
    '惠安工厂在途': '惠安工厂在途',
    '泉州工厂在途': '泉州工厂在途',
    '江西工厂在途': '江西工厂在途',
};

// ==================== 库存页全局状态 ====================
let globalRecords = [];
let currentSort = { key: null, direction: 'none' };
let currentSearchTerm = '';

// ==================== 页面初始化 ====================

function onLoginSuccess() {
    fetchInventoryData();
}

document.addEventListener('DOMContentLoaded', function() {
    if (isLoggedIn()) {
        hideLoginOverlay();
        fetchInventoryData();
    } else {
        showLoginOverlay();
    }
});

// ==================== 数据获取 ====================

async function fetchInventoryData() {
    const token = getToken();
    if (!token) {
        showLoginOverlay();
        return;
    }
    try {
        const response = await fetch(API_BASE + '/api/inventory', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (response.status === 401) {
            clearAuth();
            showLoginOverlay();
            return;
        }
        const result = await response.json();
        if (result.status === 'success') {
            globalRecords = result.data;
            calculateAndRenderCards(globalRecords);
            handleSort('海外库存总量');
        } else {
            console.error("获取库存数据失败:", result);
        }
    } catch (error) {
        console.error("无法连接服务器:", error);
    }
}

// ==================== 卡片计算与渲染 ====================

function calculateAndRenderCards(records) {
    let totalWithTransit = 0, totalWithoutTransit = 0, totalOverseas = 0;
    let totalSupplierStock = 0, totalSupplierTransit = 0, skuCount = 0;
    let alertCount = 0;
    const seenSku = new Set();

    records.forEach(record => {
        const f = record.fields;
        if (!f || Object.keys(f).length === 0) return;

        const withTransit = parseInt(f[FIELD_MAP['包含在途']]) || 0;
        const withoutTransit = parseInt(f[FIELD_MAP['不含在途']]) || 0;
        const overseas = parseInt(f[FIELD_MAP['海外库存总量']]) || 0;
        const supplierStock = parseInt(f[FIELD_MAP['供应商库存总量']]) || 0;
        const supplierTransit = parseInt(f[FIELD_MAP['供应商在途总量']]) || 0;

        totalWithTransit += withTransit;
        totalWithoutTransit += withoutTransit;
        totalOverseas += overseas;
        totalSupplierStock += supplierStock;
        totalSupplierTransit += supplierTransit;

        const sku = f[FIELD_MAP['MSKU']];
        if (sku && !seenSku.has(sku)) {
            seenSku.add(sku);
            skuCount++;
        }

        // 库存预警：不含在途库存为 0 且 SKU 存在
        if (withoutTransit <= 0 && sku) {
            alertCount++;
        }
    });

    document.getElementById('card-sku-count').innerText = skuCount.toLocaleString();
    document.getElementById('card-sku-footer').innerHTML = `<span>活跃SKU</span><span>共 ${skuCount} 个</span>`;

    document.getElementById('card-sellable').innerText = totalWithTransit.toLocaleString();
    document.getElementById('card-sellable-footer').innerHTML = `<span>含在途总量</span><span>${totalWithTransit.toLocaleString()} 件</span>`;

    document.getElementById('card-unsellable').innerText = totalWithoutTransit.toLocaleString();
    document.getElementById('card-unsellable-footer').innerHTML = `<span>不含在途总量</span><span>${totalWithoutTransit.toLocaleString()} 件</span>`;

    document.getElementById('card-inbound').innerText = totalOverseas.toLocaleString();
    document.getElementById('card-inbound-footer').innerHTML = `<span>海外库存总量</span><span>${totalOverseas.toLocaleString()} 件</span>`;

    document.getElementById('card-total-value').innerText = totalSupplierStock.toLocaleString();
    document.getElementById('card-value-footer').innerHTML = `<span>供应商库存总量</span><span>${totalSupplierStock.toLocaleString()} 件</span>`;

    document.getElementById('card-alert-count').innerText = alertCount.toLocaleString();
    document.getElementById('card-alert-footer').innerHTML = alertCount > 0
        ? `<span>库存告罄商品</span><span class="trend-down">需补货</span>`
        : `<span>库存告罄商品</span><span class="trend-up">库存正常</span>`;
}

// ==================== 搜索 / 排序 ====================

function handleSearch(event) {
    currentSearchTerm = event.target.value.trim().toLowerCase();
    applyFilterAndSort();
}

function handleSort(key) {
    if (currentSort.key === key) {
        if (currentSort.direction === 'none') currentSort.direction = 'desc';
        else if (currentSort.direction === 'desc') currentSort.direction = 'asc';
        else currentSort.direction = 'none';
    } else {
        currentSort.key = key;
        currentSort.direction = 'desc';
    }
    document.querySelectorAll('.sort-icon').forEach(icon => { icon.className = 'sort-icon sort-none'; });
    const activeIcon = document.getElementById(`sort-icon-${key}`);
    if (activeIcon) {
        if (currentSort.direction === 'desc') activeIcon.className = 'sort-icon sort-desc';
        if (currentSort.direction === 'asc') activeIcon.className = 'sort-icon sort-asc';
    }
    applyFilterAndSort();
}

// ==================== 核心：过滤 + 排序 + 渲染 ====================

function applyFilterAndSort() {
    let processedRecords = [...globalRecords];

    // 1. 关键词过滤
    if (currentSearchTerm) {
        processedRecords = processedRecords.filter(record => {
            const f = record.fields;
            const name = (f[FIELD_MAP['产品名称']] || '').toLowerCase();
            const sku = (f[FIELD_MAP['MSKU']] || '').toLowerCase();
            const asin = (f[FIELD_MAP['子ASIN']] || '').toLowerCase();
            const parentAsin = (f[FIELD_MAP['父ASIN']] || '').toLowerCase();
            return name.includes(currentSearchTerm)
                || sku.includes(currentSearchTerm)
                || asin.includes(currentSearchTerm)
                || parentAsin.includes(currentSearchTerm);
        });
    }

    // 2. 排序
    if (currentSort.direction !== 'none' && currentSort.key) {
        processedRecords.sort((a, b) => {
            const key = currentSort.key;
            let valA = parseFloat(a.fields[key]) || 0;
            let valB = parseFloat(b.fields[key]) || 0;
            if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
            return 0;
        });
    }

    // 3. 渲染
    renderTable(processedRecords);
    document.getElementById('toolbar-total-count').innerText = `共 ${processedRecords.length} 条`;
}

// ==================== 表格渲染 ====================

function renderTable(records) {
    const tbody = document.querySelector('tbody');
    tbody.innerHTML = '';

    records.forEach(record => {
        const f = record.fields;
        if (!f || Object.keys(f).length === 0) return;

        // 产品图
        let imgHtml = '<div style="width:25px; height:25px; background-color:#f2f3f5; border-radius:2px;"></div>';
        if (f[FIELD_MAP['产品图']] && f[FIELD_MAP['产品图']].length > 0) {
            const rawFeishuImgUrl = f[FIELD_MAP['产品图']][0].url;
            const imgToken = getToken();
            imgHtml = `<img src="http://121.40.126.178:5000/api/image?url=${encodeURIComponent(rawFeishuImgUrl)}&_token=${encodeURIComponent(imgToken || '')}" loading="lazy" onerror="handleImageError(this)" style="width:25px; height:25px; object-fit:cover; border-radius:2px; display:block;">`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="sticky-col-1">${f[FIELD_MAP['产品名称']] || '-'}</td>
            <td class="sticky-col-2">${imgHtml}</td>
            <td>${f[FIELD_MAP['父ASIN']] || '-'}</td>
            <td>${f[FIELD_MAP['子ASIN']] || '-'}</td>
            <td>${f[FIELD_MAP['MSKU']] || '-'}</td>
            <td>${f[FIELD_MAP['包含在途']] || '0'}</td>
            <td>${f[FIELD_MAP['不含在途']] || '0'}</td>
            <td>${f[FIELD_MAP['海外库存总量']] || '0'}</td>
            <td>${f[FIELD_MAP['FBA库存']] || '0'}</td>
            <td>${f[FIELD_MAP['FBA在途']] || '0'}</td>
            <td>${f[FIELD_MAP['西邮库存']] || '0'}</td>
            <td>${f[FIELD_MAP['LNK库存']] || '0'}</td>
            <td>${f[FIELD_MAP['供应商库存总量']] || '0'}</td>
            <td>${f[FIELD_MAP['杰戈工厂库存']] || '0'}</td>
            <td>${f[FIELD_MAP['惠安工厂库存']] || '0'}</td>
            <td>${f[FIELD_MAP['泉州工厂库存']] || '0'}</td>
            <td>${f[FIELD_MAP['江西工厂库存']] || '0'}</td>
            <td>${f[FIELD_MAP['供应商在途总量']] || '0'}</td>
            <td>${f[FIELD_MAP['杰戈工厂在途']] || '0'}</td>
            <td>${f[FIELD_MAP['惠安工厂在途']] || '0'}</td>
            <td>${f[FIELD_MAP['泉州工厂在途']] || '0'}</td>
            <td>${f[FIELD_MAP['江西工厂在途']] || '0'}</td>
        `;
        tbody.appendChild(tr);
    });

    // 表格渲染完成后初始化列宽拖拽
    if (window._initColumnResize) {
        window._initColumnResize();
    }
    // 更新冻结列位置
    updateStickyColumns();
}

// ==================== 冻结列位置更新 ====================

/**
 * 根据第一列（产品名称）的实际宽度动态设置第二列（产品图）的 left 偏移，
 * 同时同步更新 thead 和 tbody 中所有冻结列的位置。
 */
function updateStickyColumns() {
    // 从第二行 thead 中定位 sticky-col-1（产品名称）
    const headerStickyCol1 = document.querySelector('thead th.sticky-col-1');
    if (!headerStickyCol1) return;

    const col1Width = headerStickyCol1.offsetWidth;
    const leftOffset = col1Width + 'px';

    // 更新 thead 中 sticky-col-2 的 left
    const headerStickyCol2 = document.querySelector('thead th.sticky-col-2');
    if (headerStickyCol2) {
        headerStickyCol2.style.left = leftOffset;
    }

    // 更新 tbody 中所有 sticky-col-2 的 left
    document.querySelectorAll('tbody td.sticky-col-2').forEach(function(td) {
        td.style.left = leftOffset;
    });
}

// 注册为全局回调，common.js 在列宽变更后会自动调用
window._onColumnWidthsChanged = updateStickyColumns;
