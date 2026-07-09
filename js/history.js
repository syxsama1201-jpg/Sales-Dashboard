/**
 * history.js — 历史销量数据专属逻辑
 * 依赖：common.js 必须先加载
 *
 * 数据来源：飞书多维表格《历史销量数据》
 * APP_TOKEN = "VSuPbf0usaGOUasEluUcWdFwnvg"
 * TABLE_ID  = "tbl2RWkEIMJ5fzJP"
 */

// ==================== 月份列定义 ====================
// 显示名称 → 飞书字段名（如飞书字段名与显示名一致，可不用修改）
// 如需修改飞书字段名映射，只需调整下方 MONTH_COLUMNS 中每项的 field 值

var MONTH_COLUMNS = (function() {
    var cols = [];
    var years = [22, 23, 24, 25, 26];
    years.forEach(function(year) {
        var endMonth = 12;
        for (var m = 1; m <= endMonth; m++) {
            var displayName = year + '年' + m + '月';
            cols.push({
                display: displayName,
                field: displayName  // 飞书字段名，若不一致请修改此处
            });
        }
    });
    return cols;
})();

// ==================== 产品字段映射 ====================
// 历史表前置三列来自飞书字段。保留 ASIN 兜底，是为了兼容旧表尚未完全迁移时的子 ASIN 数据。
var PRODUCT_FIELD = '品名';
var PARENT_ASIN_FIELD = '父ASIN';
var CHILD_ASIN_FIELD = '子ASIN';
var LEGACY_ASIN_FIELD = 'ASIN';

// ==================== 历史页全局状态 ====================
var globalRecords = [];
var currentSort = { key: null, direction: 'none' };
var currentSearchTerm = '';

// ==================== 页面初始化 ====================

function onLoginSuccess() {
    requireFreshAuth({ pageTag: 'history', onAuthorized: fetchHistoryData, activeKey: 'history' });
}

document.addEventListener('DOMContentLoaded', function() {
    buildTableHeader();
    requireFreshAuth({ pageTag: 'history', onAuthorized: fetchHistoryData, activeKey: 'history' });
});

// ==================== 表格头构建 ====================

function buildTableHeader() {
    var thead = document.getElementById('table-head');
    var html = '<tr>';
    html += '<th class="history-meta-col history-product-col">品名</th>';
    html += '<th class="history-meta-col history-parent-col">父ASIN</th>';
    html += '<th class="history-meta-col history-child-col">子ASIN</th>';
    MONTH_COLUMNS.forEach(function(col) {
        html += '<th class="col-month">' + col.display + '</th>';
    });
    html += '</tr>';
    thead.innerHTML = html;
}

function valueToText(value) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) {
        return value.map(function(item) {
            if (item === undefined || item === null) return '';
            if (typeof item === 'object') return item.text || item.name || item.url || '';
            return String(item);
        }).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') return value.text || value.name || value.url || '';
    return String(value);
}

function escapeHtml(value) {
    return valueToText(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getHistoryField(fields, fieldName) {
    return valueToText(fields[fieldName]);
}

function getChildAsin(fields) {
    return getHistoryField(fields, CHILD_ASIN_FIELD) || getHistoryField(fields, LEGACY_ASIN_FIELD);
}

function renderMetaCell(value, className) {
    var text = valueToText(value);
    var display = text || '-';
    return '<td class="history-meta-col ' + className + '" title="' + escapeHtml(display) + '">' + escapeHtml(display) + '</td>';
}

// ==================== 数据获取 ====================

function fetchHistoryData() {
    var token = getToken();
    if (!token) {
        goToFrontPage('login');
        return;
    }
    fetch(API_BASE + '/api/history', {
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(response) {
        if (response.status === 401) {
            clearAuth();
            goToFrontPage('login');
            return Promise.reject('unauthorized');
        }
        if (response.status === 403) {
            goToFrontPage('denied');
            return Promise.reject('forbidden');
        }
        return response.json();
    }).then(function(result) {
        if (result.status === 'success') {
            globalRecords = result.data;
            applyFilterAndSort();
        } else {
            console.error('获取历史销量数据失败:', result);
        }
    }).catch(function(error) {
        if (error !== 'unauthorized') {
            console.error('无法连接服务器:', error);
        }
    });
}

// ==================== 搜索 ====================

function handleSearch(event) {
    currentSearchTerm = event.target.value.trim().toLowerCase();
    applyFilterAndSort();
}

// ==================== 核心：过滤 + 渲染 ====================

function applyFilterAndSort() {
    var processedRecords = globalRecords.slice();

    // 1. 同时按品名、父 ASIN、子 ASIN 搜索，便于用户从任一产品标识定位历史销量。
    if (currentSearchTerm) {
        processedRecords = processedRecords.filter(function(record) {
            var f = record.fields;
            var searchText = [
                getHistoryField(f, PRODUCT_FIELD),
                getHistoryField(f, PARENT_ASIN_FIELD),
                getChildAsin(f)
            ].join(' ').toLowerCase();
            return searchText.indexOf(currentSearchTerm) !== -1;
        });
    }

    // 2. 排序（暂不启用列头点击排序，保留能力供日后扩展）
    if (currentSort.direction !== 'none' && currentSort.key) {
        processedRecords.sort(function(a, b) {
            var key = currentSort.key;
            var valA = parseFloat(a.fields[key]) || 0;
            var valB = parseFloat(b.fields[key]) || 0;
            if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
            return 0;
        });
    }

    // 3. 渲染
    renderTable(processedRecords);
    document.getElementById('toolbar-total-count').innerText = '共 ' + processedRecords.length + ' 条';
}

// ==================== 表格渲染 ====================

function renderTable(records) {
    var tbody = document.querySelector('tbody');
    tbody.innerHTML = '';

    records.forEach(function(record) {
        var f = record.fields;
        if (!f || Object.keys(f).length === 0) return;

        var tr = document.createElement('tr');

        var html = '';
        html += renderMetaCell(getHistoryField(f, PRODUCT_FIELD), 'history-product-col');
        html += renderMetaCell(getHistoryField(f, PARENT_ASIN_FIELD), 'history-parent-col');
        html += renderMetaCell(getChildAsin(f), 'history-child-col');

        // 各月份销量数据
        MONTH_COLUMNS.forEach(function(col) {
            var val = f[col.field];
            if (val !== undefined && val !== null && val !== '') {
                html += '<td class="col-month">' + val + '</td>';
            } else {
                html += '<td class="col-month" style="color:#c9cdd4;">-</td>';
            }
        });

        tr.innerHTML = html;
        tbody.appendChild(tr);
    });

    // 表格渲染完成后初始化列宽拖拽
    if (window._initColumnResize) {
        window._initColumnResize();
    }
}

// ==================== CSV 下载 ====================

function downloadCSV() {
    // 1. 构建表头
    var headers = ['品名', '父ASIN', '子ASIN'];
    MONTH_COLUMNS.forEach(function(col) {
        headers.push(col.display);
    });

    // 2. 读取当前显示的表格数据
    var rows = [];
    document.querySelectorAll('tbody tr').forEach(function(tr) {
        var row = [];
        tr.querySelectorAll('td').forEach(function(td) {
            row.push(td.textContent.trim());
        });
        rows.push(row);
    });

    if (rows.length === 0) return;

    // 3. CSV 转义
    function csvEscape(str) {
        if (!str && str !== '0') return '';
        str = String(str);
        if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    // 4. 构建 CSV 内容（BOM + 表头 + 数据行）
    var bom = '\uFEFF';
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
    a.download = 'history_sales_' + today + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
