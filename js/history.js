/**
 * history.js — 历史销量数据专属逻辑
 * 依赖：common.js 必须先加载
 *
 * 数据来源：飞书多维表格《历史销量数据》
 * APP_TOKEN = "VSuPbf0usaGOUasEluUcWdFwnvg"
 * TABLE_ID  = "tbl2RWkEIMJ5fzJP"
 *
 * 月份列不再硬编码，改为从飞书返回的实际数据中动态发现。
 * 只要飞书表格新增了月份字段，页面会自动显示，无需改代码。
 */

// ==================== 月份列定义（动态发现，不再硬编码） ====================
var MONTH_COLUMNS = [];

// ==================== ASIN 字段映射 ====================
var ASIN_FIELD = 'ASIN';

// ==================== 历史页全局状态 ====================
var globalRecords = [];
var currentSort = { key: null, direction: 'none' };
var currentSearchTerm = '';

// ==================== 从数据中动态发现月份列 ====================

/**
 * 扫描所有记录的字段名，找出所有形如 "XX年X月" 的字段，
 * 按年月排序后存入 MONTH_COLUMNS。
 * 优先用 targetAllSku 行来发现（通常它包含所有月份列）。
 */
function discoverMonthColumns(records) {
    if (!records || records.length === 0) return;

    var monthSet = {};
    var monthList = [];

    // 优先扫描 targetAllSku（总量行通常包含所有月份）
    for (var i = 0; i < records.length; i++) {
        var f = records[i].fields;
        if (f && f[ASIN_FIELD] === 'targetAllSku') {
            scanFields(f, monthSet, monthList);
            break;
        }
    }

    // 如果 targetAllSku 没找到足够月份，再扫其他行补充
    if (monthList.length === 0) {
        for (var j = 0; j < records.length; j++) {
            var fields = records[j].fields;
            if (!fields || Object.keys(fields).length === 0) continue;
            scanFields(fields, monthSet, monthList);
            if (monthList.length >= 6) break;
        }
    }

    function scanFields(f, mset, mlist) {
        Object.keys(f).forEach(function(key) {
            var match = key.match(/^(\d{2})年(\d{1,2})月$/);
            if (!match) return;
            var y = parseInt(match[1]) + 2000;
            var m = parseInt(match[2]);
            var sortKey = y * 100 + m;
            if (!mset[sortKey]) {
                mset[sortKey] = true;
                mlist.push({ field: key, year: y, month: m, sortKey: sortKey });
            }
        });
    }

    // 按年月排序
    monthList.sort(function(a, b) { return a.sortKey - b.sortKey; });

    // 只保留 field 和 display 用于后续渲染
    MONTH_COLUMNS = monthList.map(function(item) {
        // display 保持原格式如 "22年1月"
        return { field: item.field, display: item.field };
    });
}

// ==================== 页面初始化 ====================

function onLoginSuccess() {
    fetchHistoryData();
}

document.addEventListener('DOMContentLoaded', function() {
    if (isLoggedIn()) {
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
            // 动态发现月份列（必须在 buildTableHeader + render 之前）
            discoverMonthColumns(result.data);
            buildTableHeader();
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

        // 各月份销量数据（按动态发现的列顺序）
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
