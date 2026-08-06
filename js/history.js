/**
 * history.js — 历史销量数据专属逻辑
 * 依赖：common.js 必须先加载
 *
 * 数据来源：飞书多维表格《历史销量数据》
 * APP_TOKEN = "VSuPbf0usaGOUasEluUcWdFwnvg"
 * TABLE_ID  = "tbl2RWkEIMJ5fzJP"
 */

// ==================== 月份列定义 ====================
// 月份字段由接口返回数据自动识别，兼容“26年1月”和“2026年1月”两种飞书列名。
// 这样新增月份后无需手动维护年份列表，页面和 CSV 会使用同一份动态列定义。

// 月份列不能再固定写到某一年：飞书表会持续新增月份，固定列表会导致接口虽返回了
// 新字段、页面和导出的 CSV 却完全看不到。数据加载后再根据实际返回字段构建列。
var MONTH_COLUMNS = [];
var MONTH_FIELD_PATTERN = /^(\d{2}|\d{4})年(0?[1-9]|1[0-2])月$/;

function getMonthFieldInfo(fieldName) {
    var match = MONTH_FIELD_PATTERN.exec(String(fieldName || ''));
    if (!match) return null;

    var rawYear = match[1];
    var year = Number(rawYear);
    // 历史表同时使用过“26年1月”和“2026年1月”。短年份统一按 2000 年后解释，
    // 仅用于排序和归并；读取时仍保留原始飞书字段名，避免改变既有数据映射。
    if (rawYear.length === 2) year += 2000;

    return {
        year: year,
        month: Number(match[2]),
        isFullYear: rawYear.length === 4,
        field: String(fieldName)
    };
}

function buildMonthColumns(records) {
    var columnsByMonth = {};

    (records || []).forEach(function(record) {
        var fields = record && record.fields;
        if (!fields) return;

        Object.keys(fields).forEach(function(fieldName) {
            var info = getMonthFieldInfo(fieldName);
            if (!info) return;

            var key = info.year + '-' + String(info.month).padStart(2, '0');
            if (!columnsByMonth[key]) {
                columnsByMonth[key] = {
                    year: info.year,
                    month: info.month,
                    fullYearField: '',
                    shortYearField: ''
                };
            }

            if (info.isFullYear) {
                columnsByMonth[key].fullYearField = info.field;
            } else {
                columnsByMonth[key].shortYearField = info.field;
            }
        });
    });

    return Object.keys(columnsByMonth).map(function(key) {
        return columnsByMonth[key];
    }).sort(function(a, b) {
        return a.year - b.year || a.month - b.month;
    }).map(function(column) {
        var fields = [column.fullYearField, column.shortYearField].filter(Boolean);
        return {
            // 同月双字段属于命名迁移兼容，而非两份销量；全年份字段优先，空值时回退短年份字段。
            display: column.year + '年' + column.month + '月',
            fields: fields
        };
    });
}

function getMonthColumnValue(fields, column) {
    if (!fields || !column || !column.fields) return undefined;

    for (var index = 0; index < column.fields.length; index++) {
        var value = fields[column.fields[index]];
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
}

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
            globalRecords = Array.isArray(result.data) ? result.data : [];
            MONTH_COLUMNS = buildMonthColumns(globalRecords);
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
            var val = getMonthColumnValue(f, col);
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
