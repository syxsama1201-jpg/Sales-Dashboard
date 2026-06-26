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
        var endMonth = (year === 26) ? 5 : 12;
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

// ==================== ASIN 字段映射 ====================
// 飞书中 ASIN 列的字段名（通常为 "ASIN"）
var ASIN_FIELD = 'ASIN';

// ==================== 历史页全局状态 ====================
var globalRecords = [];
var currentSort = { key: null, direction: 'none' };
var currentSearchTerm = '';

// ==================== 页面初始化 ====================

function onLoginSuccess() {
    if (!requirePageTag('history')) { showLoginOverlay(); return; }
    fetchHistoryData();
}

document.addEventListener('DOMContentLoaded', function() {
    buildTableHeader();
    if (isLoggedIn()) {
        if (!requirePageTag('history')) return;
        hideLoginOverlay();
        fetchHistoryData();
    } else {
        showLoginOverlay();
    }
});

// ==================== 表格头构建 ====================

function buildTableHeader() {
    var thead = document.getElementById('table-head');
    var html = '<tr>';
    html += '<th class="col-asin">ASIN</th>';
    MONTH_COLUMNS.forEach(function(col) {
        html += '<th class="col-month">' + col.display + '</th>';
    });
    html += '</tr>';
    thead.innerHTML = html;
}

// ==================== 数据获取 ====================

function fetchHistoryData() {
    var token = getToken();
    if (!token) {
        showLoginOverlay();
        return;
    }
    fetch(API_BASE + '/api/history', {
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(response) {
        if (response.status === 401) {
            clearAuth();
            showLoginOverlay();
            return Promise.reject('unauthorized');
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

    // 1. 仅按 ASIN 列搜索
    if (currentSearchTerm) {
        processedRecords = processedRecords.filter(function(record) {
            var f = record.fields;
            var asin = (f[ASIN_FIELD] || '').toString().toLowerCase();
            return asin.indexOf(currentSearchTerm) !== -1;
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

        // ASIN 列
        var asin = f[ASIN_FIELD] || '-';
        var html = '<td class="col-asin">' + asin + '</td>';

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
    var headers = ['ASIN'];
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
