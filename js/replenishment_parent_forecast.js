/**
 * replenishment_parent_forecast.js — 整款预测页专属逻辑。
 *
 * 页面不保存用户修改的日均销量。预测只服务于当前查询会话，重新输入父 ASIN、
 * 刷新或重新打开页面都会从历史销量和海外库存的最新源数据重新建立默认模型。
 */

var PARENT_ASIN_FIELD = '父ASIN';
var HISTORY_YEARS = [2024, 2025, 2026, 2027];
var HISTORY_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
var VISIBLE_PROJECTION_MONTH_COUNT = 6;
var THEORY_INVENTORY_MONTH_COUNT = 4;
// 末三行的理论库存仍需要各自后续三个月销量，因此实际读取 6 + 3 个月。
var PROJECTION_SOURCE_MONTH_COUNT = VISIBLE_PROJECTION_MONTH_COUNT + THEORY_INVENTORY_MONTH_COUNT - 1;

var parentForecastHistoryRecords = [];
var parentForecastInventoryByParent = {};
var parentForecastDataLoaded = false;
var parentForecastCurrentTerm = '';
var parentForecastState = null;

function onLoginSuccess() {
    requireFreshAuth({
        pageTag: 'replenishment_parent_forecast',
        onAuthorized: fetchParentForecastSourceData,
        activeKey: 'logistics'
    });
}

initProtectedPage('replenishment_parent_forecast', fetchParentForecastSourceData, 'logistics');

// ==================== 基础字段与格式工具 ====================

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

function normalizeParentAsin(value) {
    return valueToText(value).trim().toUpperCase();
}

function getHistoryField(fields, fieldName) {
    return valueToText(fields ? fields[fieldName] : '').trim();
}

function toNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    var text = valueToText(value).replace(/,/g, '').replace(/[^\d.-]/g, '').trim();
    var number = Number(text);
    return isFinite(number) ? number : 0;
}

function formatRoundedNumber(value) {
    return Math.round(toNumber(value)).toLocaleString('zh-CN', {
        maximumFractionDigits: 0
    });
}

function formatRecommendedNumber(value) {
    return toNumber(value).toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatDailyInput(value) {
    // 输入框保留四位小数，避免用户看到的日均与计算使用的月销量产生明显偏差。
    var number = toNumber(value);
    return String(Math.round(number * 10000) / 10000);
}

function setHidden(id, hidden) {
    var element = document.getElementById(id);
    if (element) element.classList.toggle('hidden', !!hidden);
}

function showParentForecastMessage(text) {
    document.getElementById('parentForecastSearchPanel').classList.add('has-result');
    setHidden('parentForecastResults', true);
    var message = document.getElementById('parentForecastMessage');
    message.textContent = text;
    message.classList.remove('hidden');
}

function resetParentForecastView() {
    parentForecastState = null;
    document.getElementById('parentForecastSearchPanel').classList.remove('has-result');
    setHidden('parentForecastResults', true);
    setHidden('parentForecastMessage', true);
}

// ==================== 受权限保护的数据读取 ====================

async function fetchParentForecastJson(url, token) {
    var response = await fetch(API_BASE + url, {
        headers: { 'Authorization': 'Bearer ' + token }
    });

    if (response.status === 401) {
        clearAuth();
        goToFrontPage('login');
        throw new Error('unauthorized');
    }
    if (response.status === 403) {
        goToFrontPage('denied');
        throw new Error('forbidden');
    }

    var payload = await response.json();
    if (!response.ok || payload.status !== 'success') {
        throw new Error(payload.detail || '数据读取失败');
    }
    return payload;
}

async function fetchParentForecastSourceData() {
    var token = getToken();
    if (!token) {
        goToFrontPage('login');
        return;
    }

    parentForecastDataLoaded = false;
    try {
        // 两个源表独立，使用并发读取减少首次打开页面时的等待时间。
        var results = await Promise.all([
            fetchParentForecastJson('/api/history', token),
            fetchParentForecastJson('/api/replenishment/parent-overseas-inventory', token)
        ]);
        var historyResult = results[0];
        var inventoryResult = results[1];

        parentForecastHistoryRecords = historyResult.data || [];
        parentForecastInventoryByParent = {};
        (inventoryResult.data || []).forEach(function(item) {
            var parentAsin = normalizeParentAsin(item.parent_asin);
            if (!parentAsin) return;
            parentForecastInventoryByParent[parentAsin] = toNumber(item.overseas_total);
        });
        parentForecastDataLoaded = true;

        if (parentForecastCurrentTerm) {
            renderParentForecast(parentForecastCurrentTerm);
        }
    } catch (error) {
        if (error.message === 'unauthorized' || error.message === 'forbidden') return;
        showParentForecastMessage('无法读取历史销量或海外库存数据，请稍后重试。');
        console.error('整款预测数据读取失败:', error);
    }
}

// ==================== 父 ASIN 查询与默认模型 ====================

function handleParentForecastInput(event) {
    parentForecastCurrentTerm = event.target.value.trim();

    if (!parentForecastCurrentTerm) {
        resetParentForecastView();
        return;
    }
    if (!parentForecastDataLoaded) {
        showParentForecastMessage('历史销量与海外库存数据加载中...');
        return;
    }
    renderParentForecast(parentForecastCurrentTerm);
}

function findHistoryRowsByParentAsin(parentAsin) {
    var target = normalizeParentAsin(parentAsin);
    return parentForecastHistoryRecords.filter(function(record) {
        return normalizeParentAsin(getHistoryField(record.fields, PARENT_ASIN_FIELD)) === target;
    });
}

function getMonthRawValue(fields, year, month) {
    // 历史销量表仍同时存在短年份（26年7月）和全年份（2026年7月）字段，
    // 先取全年份以兼容后续新列，再回退短年份以复用现有历史数据。
    var fullYearField = year + '年' + month + '月';
    var shortYearField = String(year).slice(2) + '年' + month + '月';
    if (fields && fields[fullYearField] !== undefined && fields[fullYearField] !== null && fields[fullYearField] !== '') {
        return fields[fullYearField];
    }
    return fields ? fields[shortYearField] : undefined;
}

function getMonthlySales(rows, year, month) {
    var total = 0;
    rows.forEach(function(record) {
        // 缺失销量按 0 处理，保证未来字段为空时整款模型仍可连续计算。
        total += toNumber(getMonthRawValue(record.fields, year, month));
    });
    return total;
}

function getProjectionMonth(baseDate, offset) {
    var date = new Date(baseDate.getFullYear(), baseDate.getMonth() + offset, 1);
    var month = date.getMonth() + 1;
    return {
        year: date.getFullYear(),
        month: month,
        label: date.getFullYear() + '-' + String(month).padStart(2, '0')
    };
}

function getRemainingDaysIncludingToday(date) {
    var daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return daysInMonth - date.getDate() + 1;
}

function createParentForecastState(parentAsin, rows) {
    var now = new Date();
    var months = [];
    var sourceMonthlySales = [];

    for (var index = 0; index < PROJECTION_SOURCE_MONTH_COUNT; index++) {
        var monthInfo = getProjectionMonth(now, index);
        months.push(monthInfo);
        sourceMonthlySales.push(getMonthlySales(rows, monthInfo.year, monthInfo.month));
    }

    return {
        parentAsin: normalizeParentAsin(parentAsin),
        rows: rows,
        months: months,
        sourceMonthlySales: sourceMonthlySales,
        dailyOverrides: {},
        initialOverseasInventory: parentForecastInventoryByParent[normalizeParentAsin(parentAsin)] || 0,
        firstMonthRemainingDays: getRemainingDaysIncludingToday(now)
    };
}

function getProjectionMonthlySales(state, index) {
    if (Object.prototype.hasOwnProperty.call(state.dailyOverrides, index)) {
        return state.dailyOverrides[index] * 30;
    }
    return state.sourceMonthlySales[index] || 0;
}

function getProjectionDailySales(state, index) {
    if (Object.prototype.hasOwnProperty.call(state.dailyOverrides, index)) {
        return state.dailyOverrides[index];
    }
    return getProjectionMonthlySales(state, index) / 30;
}

function calculateProjectionRows(state) {
    var monthlySales = state.months.map(function(_, index) {
        return getProjectionMonthlySales(state, index);
    });
    var calculatedRows = [];

    for (var index = 0; index < VISIBLE_PROJECTION_MONTH_COUNT; index++) {
        var currentOverseasInventory = index === 0
            ? state.initialOverseasInventory
            : calculatedRows[index - 1].monthEndInventory + calculatedRows[index - 1].recommendedShipment;
        var consumptionDays = index === 0 ? state.firstMonthRemainingDays : 30;
        var dailySales = getProjectionDailySales(state, index);
        var monthEndInventory = currentOverseasInventory - dailySales * consumptionDays;
        var theoreticalInventory = 0;

        for (var offset = 0; offset < THEORY_INVENTORY_MONTH_COUNT; offset++) {
            theoreticalInventory += monthlySales[index + offset] || 0;
        }

        calculatedRows.push({
            month: state.months[index].label,
            forecastMonthlySales: monthlySales[index],
            dailySales: dailySales,
            currentOverseasInventory: currentOverseasInventory,
            monthEndInventory: monthEndInventory,
            theoreticalInventory: theoreticalInventory,
            // 负值保留：它代表理论库存已充足，不能在页面端擅自改为 0。
            recommendedShipment: theoreticalInventory - monthEndInventory
        });
    }

    return calculatedRows;
}

function renderParentForecast(parentAsin) {
    var normalizedParentAsin = normalizeParentAsin(parentAsin);
    var rows = findHistoryRowsByParentAsin(normalizedParentAsin);
    if (!rows.length) {
        parentForecastState = null;
        showParentForecastMessage('未找到匹配的父 ASIN。');
        return;
    }

    // 输入不同父 ASIN 时创建全新状态，确保手工日均不会串到下一次查询。
    if (!parentForecastState || parentForecastState.parentAsin !== normalizedParentAsin) {
        parentForecastState = createParentForecastState(normalizedParentAsin, rows);
    }

    document.getElementById('parentForecastSearchPanel').classList.add('has-result');
    setHidden('parentForecastMessage', true);
    setHidden('parentForecastResults', false);
    renderProjectionTable(parentForecastState);
    renderParentHistoryTable(rows);
}

// ==================== 推测表及日均编辑 ====================

function renderProjectionTable(state) {
    var head = '<tr>' +
        '<th>月份</th>' +
        '<th>预测月销量</th>' +
        '<th>当月日均</th>' +
        '<th>当前海外库存</th>' +
        '<th>月末库存推演</th>' +
        '<th>当月理论库存</th>' +
        '<th class="recommendation-head">推荐发货量</th>' +
        '</tr>';
    var rows = calculateProjectionRows(state);
    var body = rows.map(function(row, index) {
        return '<tr>' +
            '<td>' + escapeHtml(row.month) + '</td>' +
            '<td>' + formatRoundedNumber(row.forecastMonthlySales) + '</td>' +
            '<td><input class="parent-forecast-daily-input" type="number" min="0" step="0.0001" aria-label="' + escapeHtml(row.month) + ' 当月日均" value="' + escapeHtml(formatDailyInput(row.dailySales)) + '" onchange="updateProjectionDailyAverage(' + index + ', this)"></td>' +
            '<td>' + formatRoundedNumber(row.currentOverseasInventory) + '</td>' +
            '<td>' + formatRoundedNumber(row.monthEndInventory) + '</td>' +
            '<td>' + formatRoundedNumber(row.theoreticalInventory) + '</td>' +
            '<td class="recommendation-cell">' + formatRecommendedNumber(row.recommendedShipment) + '</td>' +
            '</tr>';
    }).join('');

    document.getElementById('parentForecastTableHead').innerHTML = head;
    document.getElementById('parentForecastTableBody').innerHTML = body;
}

function updateProjectionDailyAverage(index, input) {
    if (!parentForecastState) return;

    var value = Number(valueToText(input.value).trim());
    if (!isFinite(value) || value < 0) {
        // 只接受非负数，避免输入过程中的空值或非法值污染整张库存递推表。
        input.setCustomValidity('当月日均必须为非负数字');
        input.reportValidity();
        input.setCustomValidity('');
        input.value = formatDailyInput(getProjectionDailySales(parentForecastState, index));
        return;
    }

    parentForecastState.dailyOverrides[index] = value;
    // 一个日均会影响本行月销量、前 3 行理论库存及全部后续库存递推，因此必须整表重算。
    renderProjectionTable(parentForecastState);
}

// ==================== 父 ASIN 历史销量表 ====================

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

    return { hasValue: hasValue, sum: sum };
}

function formatMonthlyDailyAverage(value) {
    var dailyAverage = value / 30;
    var rounded = Math.round(dailyAverage);
    // 与历史销量查询页保持一致：有销量但不足 0.5 日均时仍显示 0.1，避免丢失低销量信号。
    if (value > 0 && rounded === 0) return '0.1';
    return rounded.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function formatYearlyDailyAverage(value) {
    return (value / 360).toLocaleString('zh-CN', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    });
}

function renderParentHistoryTable(rows) {
    var head = '<tr><th>父ASIN</th>' + HISTORY_MONTHS.map(function(month) {
        return '<th>' + month + '月</th>';
    }).join('') + '<th>全年日均</th></tr>';
    var body = HISTORY_YEARS.map(function(year) {
        var yearlyTotal = 0;
        var yearlyHasValue = false;
        var monthCells = HISTORY_MONTHS.map(function(month) {
            var summary = getMonthSummary(rows, year, month);
            if (!summary.hasValue) return '<td style="color:#c9cdd4;">-</td>';
            yearlyHasValue = true;
            yearlyTotal += summary.sum;
            return '<td>' + formatMonthlyDailyAverage(summary.sum) + '</td>';
        }).join('');
        var yearlyCell = yearlyHasValue
            ? formatYearlyDailyAverage(yearlyTotal)
            : '<span style="color:#c9cdd4;">-</span>';
        return '<tr><td>' + year + '</td>' + monthCells + '<td>' + yearlyCell + '</td></tr>';
    }).join('');

    document.getElementById('parentForecastHistoryHead').innerHTML = head;
    document.getElementById('parentForecastHistoryBody').innerHTML = body;
}
