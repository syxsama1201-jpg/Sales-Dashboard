/**
 * history_sales_query.js — 历史销量查询页专属逻辑
 * 依赖：common.js 必须先加载。
 *
 * 本页只复用 history.html 的历史销量数据源，不新增后端接口。
 * 搜索按 ASIN 精确匹配，是为了避免父 ASIN / 子 ASIN 部分字符相同导致误聚合。
 */

// ==================== 字段与时间范围配置 ====================

var PRODUCT_FIELD = '品名';
var PARENT_ASIN_FIELD = '父ASIN';
var CHILD_ASIN_FIELD = '子ASIN';
var LEGACY_ASIN_FIELD = 'ASIN';

var HISTORY_QUERY_YEARS = [2024, 2025, 2026, 2027];
var HISTORY_QUERY_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// ==================== 页面状态 ====================

var historyQueryRecords = [];
var historyQueryDataLoaded = false;
var historyQueryCurrentTerm = '';

// ==================== 页面初始化 ====================

function onLoginSuccess() {
    requireFreshAuth({
        pageTag: 'history',
        onAuthorized: fetchHistoryQueryData,
        activeKey: 'history'
    });
}

initProtectedPage('history', fetchHistoryQueryData, 'history');

// ==================== 基础工具 ====================

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

function normalizeAsin(value) {
    return valueToText(value).trim().toLowerCase();
}

function getHistoryField(fields, fieldName) {
    return valueToText(fields ? fields[fieldName] : '').trim();
}

function getChildAsin(fields) {
    return getHistoryField(fields, CHILD_ASIN_FIELD) || getHistoryField(fields, LEGACY_ASIN_FIELD);
}

function toNumber(value) {
    var text = valueToText(value).replace(/,/g, '').trim();
    if (text === '') return 0;
    var num = Number(text);
    return isFinite(num) ? num : 0;
}

function formatNumber(value) {
    return Math.round(value).toLocaleString('zh-CN', {
        maximumFractionDigits: 0
    });
}

function formatDailyAverage(value) {
    return (value / 360).toLocaleString('zh-CN', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    });
}

function formatMonthlyDailyAverage(value) {
    var dailyAverage = value / 30;
    var rounded = Math.round(dailyAverage);

    // 月份列展示日均销量；当原始月份有销量但日均四舍五入后为 0 时，用 0.1 保留低销量信号。
    if (value > 0 && rounded === 0) return '0.1';
    return rounded.toLocaleString('zh-CN', {
        maximumFractionDigits: 0
    });
}

function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value || '-';
}

function setHidden(id, hidden) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !!hidden);
}

// ==================== 数据获取 ====================

function fetchHistoryQueryData() {
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
            historyQueryRecords = result.data || [];
            historyQueryDataLoaded = true;
            if (historyQueryCurrentTerm) renderHistoryQuery(historyQueryCurrentTerm);
        } else {
            showMessage('获取历史销量数据失败，请稍后重试。');
            console.error('获取历史销量数据失败:', result);
        }
    }).catch(function(error) {
        if (error !== 'unauthorized' && error !== 'forbidden') {
            showMessage('无法连接服务器，请稍后重试。');
            console.error('无法连接服务器:', error);
        }
    });
}

// ==================== 搜索入口 ====================

function handleHistoryQuery(event) {
    historyQueryCurrentTerm = event.target.value.trim();

    if (!historyQueryCurrentTerm) {
        resetQueryView();
        return;
    }

    if (!historyQueryDataLoaded) {
        showMessage('历史销量数据加载中...');
        return;
    }

    renderHistoryQuery(historyQueryCurrentTerm);
}

function resetQueryView() {
    document.getElementById('querySearchPanel').classList.remove('has-result');
    setHidden('queryResults', true);
    setHidden('queryMessage', true);
}

function showMessage(text) {
    document.getElementById('querySearchPanel').classList.add('has-result');
    setHidden('queryResults', true);
    var el = document.getElementById('queryMessage');
    el.textContent = text;
    el.classList.remove('hidden');
}

// ==================== 查询与聚合 ====================

function findRowsByChildAsin(asin) {
    var target = normalizeAsin(asin);
    return historyQueryRecords.filter(function(record) {
        return normalizeAsin(getChildAsin(record.fields)) === target;
    });
}

function findRowsByParentAsin(asin) {
    var target = normalizeAsin(asin);
    return historyQueryRecords.filter(function(record) {
        return normalizeAsin(getHistoryField(record.fields, PARENT_ASIN_FIELD)) === target;
    });
}

function getMonthRawValue(fields, year, month) {
    // 兼容当前历史表的短年份字段（如 24年1月）和后续全年份字段（如 2024年1月）。
    var fullYearField = year + '年' + month + '月';
    var shortYearField = String(year).slice(2) + '年' + month + '月';
    if (fields && fields[fullYearField] !== undefined && fields[fullYearField] !== null && fields[fullYearField] !== '') {
        return fields[fullYearField];
    }
    return fields ? fields[shortYearField] : undefined;
}

function getMonthSummary(rows, year, month) {
    var hasValue = false;
    var sum = 0;

    rows.forEach(function(record) {
        var raw = getMonthRawValue(record.fields, year, month);
        if (raw !== undefined && raw !== null && valueToText(raw).trim() !== '') {
            hasValue = true;
            sum += toNumber(raw);
        }
    });

    return {
        hasValue: hasValue,
        sum: sum
    };
}

function buildTableHeaderHtml(label) {
    return '<tr><th>' + escapeHtml(label) + '</th>' +
        HISTORY_QUERY_MONTHS.map(function(month) {
            return '<th>' + month + '月</th>';
        }).join('') +
        '<th>全年日均</th></tr>';
}

function buildHistoryTableBodyHtml(rows) {
    var html = '';

    HISTORY_QUERY_YEARS.forEach(function(year) {
        var yearTotal = 0;
        var yearHasValue = false;
        var monthCells = HISTORY_QUERY_MONTHS.map(function(month) {
            var summary = getMonthSummary(rows, year, month);
            if (!summary.hasValue) return '<td style="color:#c9cdd4;">-</td>';

            yearHasValue = true;
            yearTotal += summary.sum;
            return '<td>' + formatMonthlyDailyAverage(summary.sum) + '</td>';
        }).join('');

        html += '<tr><td>' + year + '</td>' + monthCells +
            '<td>' + (yearHasValue ? formatDailyAverage(yearTotal) : '<span style="color:#c9cdd4;">-</span>') + '</td></tr>';
    });

    return html;
}

function renderHistoryTable(blockId, headId, bodyId, label, rows, shouldShow) {
    setHidden(blockId, !shouldShow);
    if (!shouldShow) return;

    document.getElementById(headId).innerHTML = buildTableHeaderHtml(label);
    document.getElementById(bodyId).innerHTML = buildHistoryTableBodyHtml(rows);
}

function renderHistoryQuery(term) {
    var childRows = findRowsByChildAsin(term);
    var parentRows;
    var firstRow;
    var mode;

    // 子 ASIN 优先，是为了避免某个子 ASIN 文本刚好也被父 ASIN 命中时展示错误口径。
    if (childRows.length > 0) {
        mode = 'child';
        firstRow = childRows[0];
        parentRows = findRowsByParentAsin(getHistoryField(firstRow.fields, PARENT_ASIN_FIELD));
    } else {
        parentRows = findRowsByParentAsin(term);
        if (parentRows.length > 0) {
            mode = 'parent';
            firstRow = parentRows[0];
        }
    }

    if (!firstRow) {
        showMessage('未找到匹配的父ASIN或子ASIN。');
        return;
    }

    document.getElementById('querySearchPanel').classList.add('has-result');
    setHidden('queryMessage', true);
    setHidden('queryResults', false);

    var fields = firstRow.fields || {};
    var parentAsin = getHistoryField(fields, PARENT_ASIN_FIELD);
    var childAsin = mode === 'child' ? getChildAsin(fields) : '-';
    var productName = getHistoryField(fields, PRODUCT_FIELD);

    setText('summaryChildAsin', childAsin);
    setText('summaryParentAsin', parentAsin);
    setText('summaryProductName', productName);

    renderHistoryTable(
        'childTableBlock',
        'childTableHead',
        'childTableBody',
        '子ASIN',
        childRows,
        mode === 'child'
    );

    renderHistoryTable(
        'parentTableBlock',
        'parentTableHead',
        'parentTableBody',
        '父ASIN',
        parentRows,
        parentRows.length > 0
    );
}
