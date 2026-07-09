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
    '包含生产在途': '包含生产在途',
    '不含生产在途': '不含生产在途',
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
    requireFreshAuth({ pageTag: 'inventory', onAuthorized: fetchInventoryData, activeKey: 'inventory' });
}

initProtectedPage('inventory', fetchInventoryData, 'inventory');

// ==================== 数据获取 ====================

async function fetchInventoryData() {
    const token = getToken();
    if (!token) {
        goToFrontPage('login');
        return;
    }
    try {
        const response = await fetch(API_BASE + '/api/inventory', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (response.status === 401) {
            clearAuth();
            goToFrontPage('login');
            return;
        }
        if (response.status === 403) {
            goToFrontPage('denied');
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
    let totalWithTransit = 0, totalOverseas = 0;
    let totalSupplierStock = 0, totalSupplierTransit = 0, totalJiegeStock = 0, skuCount = 0;
    const seenSku = new Set();

    records.forEach(record => {
        const f = record.fields;
        if (!f || Object.keys(f).length === 0) return;

        totalWithTransit += parseInt(f[FIELD_MAP['包含生产在途']]) || 0;
        totalOverseas += parseInt(f[FIELD_MAP['海外库存总量']]) || 0;
        totalSupplierStock += parseInt(f[FIELD_MAP['供应商库存总量']]) || 0;
        totalSupplierTransit += parseInt(f[FIELD_MAP['供应商在途总量']]) || 0;
        totalJiegeStock += parseInt(f[FIELD_MAP['杰戈工厂库存']]) || 0;

        const sku = f[FIELD_MAP['MSKU']];
        if (sku && !seenSku.has(sku)) {
            seenSku.add(sku);
            skuCount++;
        }
    });

    // SKU数量（不变）
    document.getElementById('card-sku-count').innerText = skuCount.toLocaleString();

    // 全渠道总库存 = 包含生产在途 求和
    document.getElementById('card-sellable').innerText = totalWithTransit.toLocaleString();

    // 海外总库存 = 海外库存总量 求和
    document.getElementById('card-unsellable').innerText = totalOverseas.toLocaleString();

    // 供应商仓总库存 = 供应商库存总量 求和
    document.getElementById('card-inbound').innerText = totalSupplierStock.toLocaleString();

    // 采购在途 = 供应商在途总量 求和
    document.getElementById('card-total-value').innerText = totalSupplierTransit.toLocaleString();

    // 杰戈库存 = 杰戈工厂库存 求和
    document.getElementById('card-alert-count').innerText = totalJiegeStock.toLocaleString();

    // 持久化海外总库存 → localStorage，供备货模型页面自动读取
    try { localStorage.setItem('inv_overseas_total', totalOverseas); } catch(e) {}
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
            imgHtml = `<img src="${API_BASE}/api/image?url=${encodeURIComponent(rawFeishuImgUrl)}&_token=${encodeURIComponent(imgToken || '')}" loading="lazy" onerror="handleImageError(this)" style="width:25px; height:25px; object-fit:cover; border-radius:2px; display:block;">`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="sticky-col-1">${f[FIELD_MAP['产品名称']] || '-'}</td>
            <td class="sticky-col-2">${imgHtml}</td>
            <td>${renderAsinWithLink(f[FIELD_MAP['父ASIN']])}</td>
            <td>${renderAsinWithLink(f[FIELD_MAP['子ASIN']])}</td>
            <td>${f[FIELD_MAP['MSKU']] || '-'}</td>
            <td>${f[FIELD_MAP['包含生产在途']] || '0'}</td>
            <td>${f[FIELD_MAP['不含生产在途']] || '0'}</td>
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

// ==================== CSV 下载 ====================

/**
 * 导出当前表格可见内容为 CSV 文件
 * 表头取第二行 thead，数据取 tbody 当前行
 * BOM 头确保 Excel 正确识别中文
 */
function downloadCSV() {
    // 1. 读取第二行表头（列名）
    var headerRows = document.querySelectorAll('table thead tr');
    if (headerRows.length < 2) return;
    var headers = [];
    headerRows[1].querySelectorAll('th').forEach(function(th) {
        headers.push(th.textContent.trim());
    });

    // 2. 读取当前显示的表格数据
    var rows = [];
    document.querySelectorAll('tbody tr').forEach(function(tr) {
        var row = [];
        tr.querySelectorAll('td').forEach(function(td) {
            // 排除链接按钮中的文字（ASIN 跳转按钮的 "↗"）
            var clone = td.cloneNode(true);
            clone.querySelectorAll('.asin-link-btn').forEach(function(btn) { btn.remove(); });
            row.push(clone.textContent.trim());
        });
        rows.push(row);
    });

    if (rows.length === 0) return;

    // 3. CSV 转义：包含逗号、双引号或换行的字段用双引号包裹
    function csvEscape(str) {
        if (!str && str !== '0') return '';
        str = String(str);
        if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    // 4. 构建 CSV 内容（BOM + 表头 + 数据行）
    var bom = '﻿';
    var csv = bom + headers.map(csvEscape).join(',') + '\n';
    rows.forEach(function(row) {
        csv += row.map(csvEscape).join(',') + '\n';
    });

    // 5. 触发浏览器下载
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    var today = new Date().toISOString().slice(0, 10);
    a.download = 'inventory_' + today + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
