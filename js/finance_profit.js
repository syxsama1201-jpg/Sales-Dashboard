/**
 * finance_profit.js — 单款财务利润页面逻辑
 *
 * Excel 只负责数据录入；表头、计算口径和权限都由页面与服务器固定控制。
 * 浏览器先校验文件可以给用户更快反馈，但服务器仍会执行同样的关键校验，
 * 不能因为前端通过就跳过后端的数据安全边界。
 */

const FINANCE_FIELDS = [
    '父ASIN', '品名', '销售额$', '销量', '客单价$', 'FBA fee', '利润额$', '利润率',
    '退货率', '广告占比', '折扣活动占比', '采购成本占比', '物流成本占比',
    'FBA fee 占比', '退货金额$', '亚马逊扣费后金额$', '仓储费占比', '广告费$',
    '折扣活动金额$', '采购成本 $', '物流成本$', 'FBA fee$', '仓储费$', '品类', '资产收益率'
];

const FINANCE_TEXT_FIELDS = new Set(['父ASIN', '品名', '品类']);
const FINANCE_RATIO_FIELDS = new Set([
    '利润率', '退货率', '广告占比', '折扣活动占比', '采购成本占比',
    '物流成本占比', 'FBA fee 占比', '仓储费占比', '资产收益率'
]);
const FINANCE_CURRENCY_FIELDS = new Set([
    '销售额$', '客单价$', 'FBA fee', '利润额$', '退货金额$', '亚马逊扣费后金额$',
    '广告费$', '折扣活动金额$', '采购成本 $', '物流成本$', 'FBA fee$', '仓储费$'
]);

let financeReports = [];
let financeRows = [];
let visibleFinanceRows = [];
let currentFinanceReport = null;
let currentFinanceSearch = '';
let financeColumnResizeInitialized = false;
let pendingFinancePayload = null;
let financeCanUpload = false;
let financeSaveInProgress = false;
let currentFinanceSort = { field: null, direction: 'none' };
let financeHistoryQueryInProgress = false;
let financeHistoryRequestVersion = 0;

function onLoginSuccess() {
    requireFreshAuth({
        pageTag: 'finance',
        onAuthorized: initializeFinancePage,
        activeKey: 'finance'
    });
}

initProtectedPage('finance', initializeFinancePage, 'finance');

async function initializeFinancePage() {
    configureFinanceUploadPermission();
    await loadFinanceMonths();
}

function configureFinanceUploadPermission() {
    // 前端隐藏用于减少误操作；真正的安全边界仍是服务器的 finance_upload 校验。
    financeCanUpload = getUserTags().indexOf('finance_upload') !== -1;
    const uploadButton = document.getElementById('financeUploadBtn');
    const saveButton = document.getElementById('financeSaveBtn');
    const fileInput = document.getElementById('financeFileInput');

    uploadButton.hidden = !financeCanUpload;
    saveButton.hidden = !financeCanUpload;
    fileInput.disabled = !financeCanUpload;
    updateFinanceSaveButton();
}

// ==================== API 与鉴权 ====================

async function financeApiRequest(path, options) {
    const token = getToken();
    if (!token) {
        goToFrontPage('login');
        throw new Error('登录已过期');
    }

    const requestOptions = Object.assign({}, options || {});
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, {
        'Authorization': 'Bearer ' + token
    });

    const response = await fetch(API_BASE + path, requestOptions);
    if (response.status === 401) {
        clearAuth();
        goToFrontPage('login');
        throw new Error('登录已过期');
    }
    if (response.status === 403) {
        goToFrontPage('denied');
        throw new Error('无财务利润权限');
    }

    let result;
    try {
        result = await response.json();
    } catch (_error) {
        throw new Error('服务器返回了无法识别的响应');
    }
    if (!response.ok) {
        throw new Error(result.detail || '请求失败');
    }
    return result;
}

async function loadFinanceMonths(preferredMonth) {
    try {
        const result = await financeApiRequest('/api/finance_profit/months');
        financeReports = Array.isArray(result.data) ? result.data : [];

        if (!financeReports.length) {
            renderFinanceMonthOptions('');
            resetFinancePage();
            return;
        }

        const preferredExists = preferredMonth && financeReports.some(function(report) {
            return report.report_month === preferredMonth;
        });
        const selectedMonth = preferredExists ? preferredMonth : financeReports[0].report_month;
        renderFinanceMonthOptions(selectedMonth);
        await loadFinanceReport(selectedMonth);
    } catch (error) {
        showFinanceStatus(error.message, 'error');
    }
}

function renderFinanceMonthOptions(selectedMonth) {
    const select = document.getElementById('reportMonthSelect');
    const pendingMonth = pendingFinancePayload ? pendingFinancePayload.reportMonth : '';
    const months = financeReports.map(function(report) { return report.report_month; });

    // 新月份尚未写入数据库，也必须在下拉框中显示，否则预览数据和页面月份会不一致。
    if (pendingMonth && months.indexOf(pendingMonth) === -1) months.unshift(pendingMonth);

    select.innerHTML = '';
    if (!months.length) {
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = '暂无数据';
        select.appendChild(emptyOption);
        select.disabled = true;
        return;
    }

    months.forEach(function(month) {
        const option = document.createElement('option');
        option.value = month;
        option.textContent = month + (month === pendingMonth ? '（待保存）' : '');
        select.appendChild(option);
    });
    select.disabled = false;
    select.value = selectedMonth || pendingMonth || months[0];
}

async function loadFinanceReport(month) {
    if (!month) {
        resetFinancePage();
        return;
    }

    showFinanceStatus('正在读取 ' + month + ' 数据…', 'loading');
    try {
        const result = await financeApiRequest('/api/finance_profit?month=' + encodeURIComponent(month));
        if (result.status === 'empty') {
            resetFinancePage();
            showFinanceStatus(month + ' 暂无数据', 'error');
            return;
        }

        currentFinanceReport = result.report || null;
        financeRows = Array.isArray(result.data) ? result.data : [];
        resetFinanceSort();
        renderFinanceCards(financeRows);
        applyFinanceFilter();

        document.getElementById('target-time').textContent = currentFinanceReport && currentFinanceReport.uploaded_at
            ? currentFinanceReport.uploaded_at
            : '--';
        showFinanceStatus(
            '已加载 ' + financeRows.length + ' 条 · ' +
            ((currentFinanceReport && currentFinanceReport.source_filename) || month),
            'success'
        );
    } catch (error) {
        showFinanceStatus(error.message, 'error');
    }
}

function handleMonthChange(event) {
    const requestedMonth = event.target.value;
    const pendingMonth = pendingFinancePayload ? pendingFinancePayload.reportMonth : '';

    if (pendingFinancePayload && requestedMonth === pendingMonth) return;
    if (pendingFinancePayload) {
        const confirmed = window.confirm('当前上传数据尚未保存。切换月份会放弃这次预览，是否继续？');
        if (!confirmed) {
            renderFinanceMonthOptions(pendingMonth);
            return;
        }
        discardPendingFinancePayload(requestedMonth);
    }
    loadFinanceReport(requestedMonth);
}

// ==================== Excel 上传 ====================

function triggerFinanceUpload() {
    if (!financeCanUpload) {
        showFinanceStatus('当前账号没有财务利润上传权限', 'error');
        return;
    }
    if (pendingFinancePayload) {
        const confirmed = window.confirm('当前上传数据尚未保存。选择新文件会替换这次预览，是否继续？');
        if (!confirmed) return;
    }
    const input = document.getElementById('financeFileInput');
    input.value = '';
    input.click();
}

async function handleFinanceFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const uploadButton = document.getElementById('financeUploadBtn');
    uploadButton.disabled = true;
    showFinanceStatus('正在校验 ' + file.name + '…', 'loading');

    try {
        const payload = await parseFinanceWorkbook(file);
        stageFinancePayload(payload);
    } catch (error) {
        const suffix = pendingFinancePayload ? '；原待保存预览仍保留' : '';
        showFinanceStatus(error.message + suffix, 'error');
    } finally {
        uploadButton.disabled = false;
        event.target.value = '';
    }
}

function stageFinancePayload(payload) {
    pendingFinancePayload = payload;
    currentFinanceReport = {
        report_month: payload.reportMonth,
        title: payload.title,
        source_filename: payload.sourceFilename,
        row_count: payload.rows.length,
        uploaded_at: null,
        uploaded_by: null
    };
    financeRows = payload.rows.slice();

    // 上传阶段仅更新浏览器内存和页面预览，不调用保存 API。
    // 这样用户可以先核对月份、卡片汇总和表格行数，再主动确认写入服务器。
    resetFinanceSort();
    renderFinanceCards(financeRows);
    applyFinanceFilter();
    renderFinanceMonthOptions(payload.reportMonth);
    document.getElementById('target-time').textContent = '待确认保存';
    updateFinanceSaveButton();
    showFinanceStatus(
        payload.reportMonth + ' 已读取，共 ' + payload.rows.length + ' 条；请点击右上角“确认保存”',
        'pending'
    );
}

async function savePendingFinanceReport() {
    if (!financeCanUpload) {
        showFinanceStatus('当前账号没有财务利润上传权限', 'error');
        return;
    }
    if (!pendingFinancePayload || financeSaveInProgress) return;

    const existing = financeReports.some(function(report) {
        return report.report_month === pendingFinancePayload.reportMonth;
    });
    if (existing) {
        const confirmed = window.confirm(
            pendingFinancePayload.reportMonth + ' 已存在。确认保存会整月替换服务器原数据，是否继续？'
        );
        if (!confirmed) {
            showFinanceStatus('已取消保存，服务器数据未改变，预览仍保留', 'pending');
            return;
        }
    }

    const payloadToSave = Object.assign({}, pendingFinancePayload, {
        replaceExisting: existing
    });
    financeSaveInProgress = true;
    updateFinanceSaveButton();
    showFinanceStatus('正在保存 ' + payloadToSave.reportMonth + '…', 'loading');

    try {
        const result = await financeApiRequest('/api/finance_profit/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadToSave)
        });

        pendingFinancePayload = null;
        await loadFinanceMonths(result.report_month);
        showFinanceStatus(
            result.report_month + ' 已保存至服务器，共 ' + result.row_count + ' 条',
            'success'
        );
    } catch (error) {
        // 保存失败时保留内存中的预览，用户修复网络或权限问题后可以再次点击保存。
        showFinanceStatus(error.message + '；待保存预览仍保留', 'error');
    } finally {
        financeSaveInProgress = false;
        updateFinanceSaveButton();
    }
}

function discardPendingFinancePayload(selectedMonth) {
    pendingFinancePayload = null;
    financeSaveInProgress = false;
    updateFinanceSaveButton();
    renderFinanceMonthOptions(selectedMonth || '');
}

function updateFinanceSaveButton() {
    const saveButton = document.getElementById('financeSaveBtn');
    const uploadButton = document.getElementById('financeUploadBtn');
    if (!saveButton || !uploadButton) return;

    saveButton.hidden = !financeCanUpload;
    uploadButton.hidden = !financeCanUpload;
    saveButton.disabled = !pendingFinancePayload || financeSaveInProgress;
    saveButton.textContent = financeSaveInProgress ? '保存中…' : '确认保存';
    uploadButton.disabled = financeSaveInProgress;
}

async function parseFinanceWorkbook(file) {
    if (!window.XLSX) {
        throw new Error('Excel 解析组件未加载，请刷新页面后重试');
    }

    const extension = file.name.split('.').pop().toLowerCase();
    if (extension !== 'xlsx' && extension !== 'xls') {
        throw new Error('仅支持 .xlsx 或 .xls 文件');
    }

    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true });
    let grid = null;

    // 历史文件可能保留多个空工作表，因此选择第一个具有模板表头的工作表，
    // 而不是盲目使用 Sheet1 或当前激活页。
    workbook.SheetNames.some(function(sheetName) {
        const candidate = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
            header: 1,
            raw: true,
            defval: null,
            blankrows: false
        });
        if (candidate.length < 2 || !Array.isArray(candidate[1])) return false;
        const firstHeader = normalizeHeader(candidate[1][0]);
        if (firstHeader !== FINANCE_FIELDS[0]) return false;
        grid = candidate;
        return true;
    });

    if (!grid) {
        throw new Error('未找到以“父ASIN”开头的财务利润工作表');
    }

    const title = valueToFinanceText(grid[0] && grid[0][2]);
    const reportMonth = parseReportMonth(title);
    const headerRow = grid[1] || [];
    const headers = FINANCE_FIELDS.map(function(_field, index) {
        return normalizeHeader(headerRow[index]);
    });

    const badHeaderIndex = FINANCE_FIELDS.findIndex(function(field, index) {
        return headers[index] !== field;
    });
    if (badHeaderIndex !== -1) {
        throw new Error(
            '第 ' + (badHeaderIndex + 1) + ' 列表头应为“' + FINANCE_FIELDS[badHeaderIndex] +
            '”，实际为“' + (headers[badHeaderIndex] || '空') + '”'
        );
    }
    if (headerRow.slice(FINANCE_FIELDS.length).some(function(value) { return !isBlankExcelValue(value); })) {
        throw new Error('模板表头超过固定的 25 列，请检查文件版本');
    }

    const rows = [];
    const seenParentAsins = new Set();
    grid.slice(2).forEach(function(sourceRow, dataIndex) {
        const values = FINANCE_FIELDS.map(function(_field, index) {
            return sourceRow ? sourceRow[index] : null;
        });
        if (values.every(isBlankExcelValue)) return;

        const row = {};
        FINANCE_FIELDS.forEach(function(field, index) {
            row[field] = values[index];
        });

        const parentAsin = valueToFinanceText(row['父ASIN']).toUpperCase();
        const excelRowNumber = dataIndex + 3;
        if (!parentAsin) {
            throw new Error('Excel 第 ' + excelRowNumber + ' 行父ASIN为空');
        }
        if (seenParentAsins.has(parentAsin)) {
            throw new Error('父ASIN重复：' + parentAsin);
        }
        seenParentAsins.add(parentAsin);
        row['父ASIN'] = parentAsin;
        rows.push(row);
    });

    if (!rows.length) {
        throw new Error('Excel 中没有可保存的数据行');
    }

    return {
        reportMonth: reportMonth,
        title: title,
        sourceFilename: file.name,
        headers: FINANCE_FIELDS.slice(),
        rows: rows
    };
}

function parseReportMonth(title) {
    const match = String(title || '').match(/(\d{4})年\s*(\d{1,2})月(?:份)?/);
    if (!match) {
        throw new Error('第一行标题中未找到形如“2026年06月份”的年月');
    }
    const monthNumber = Number(match[2]);
    if (monthNumber < 1 || monthNumber > 12) {
        throw new Error('报表月份不合法');
    }
    return match[1] + '-' + String(monthNumber).padStart(2, '0');
}

function normalizeHeader(value) {
    return valueToFinanceText(value).replace(/\s+/g, ' ').trim();
}

function isBlankExcelValue(value) {
    return value === undefined || value === null || String(value).trim() === '';
}

// ==================== 卡片与表格 ====================

function renderFinanceCards(rows) {
    if (!rows.length) {
        setFinanceCard('card-sales-amount', '--');
        setFinanceCard('card-sales-quantity', '--');
        setFinanceCard('card-unit-price', '--');
        setFinanceCard('card-profit-amount', '--');
        setFinanceCard('card-profit-margin', '--');
        setFinanceCard('card-return-rate', '--');
        return;
    }

    const totals = rows.reduce(function(result, row) {
        result.sales += toFinanceNumber(row['销售额$']);
        result.quantity += toFinanceNumber(row['销量']);
        result.profit += toFinanceNumber(row['利润额$']);
        result.returns += toFinanceNumber(row['退货金额$']);
        return result;
    }, { sales: 0, quantity: 0, profit: 0, returns: 0 });

    setFinanceCard('card-sales-amount', formatCurrency(totals.sales));
    setFinanceCard('card-sales-quantity', formatQuantity(totals.quantity));
    setFinanceCard('card-unit-price', formatCurrency(totals.quantity ? totals.sales / totals.quantity : 0));
    setFinanceCard('card-profit-amount', formatCurrency(totals.profit), totals.profit < 0);
    setFinanceCard('card-profit-margin', formatRatio(totals.sales ? totals.profit / totals.sales : 0), totals.profit < 0);
    setFinanceCard('card-return-rate', formatRatio(totals.sales ? totals.returns / totals.sales : 0));
}

function setFinanceCard(id, text, isNegative) {
    const element = document.getElementById(id);
    element.textContent = text;
    element.classList.toggle('finance-negative', !!isNegative);
}

function handleFinanceSearch(event) {
    currentFinanceSearch = event.target.value.trim().toLowerCase();
    applyFinanceFilter();
}

// ==================== 历史父 ASIN 查询 ====================

function handleFinanceHistoryQueryKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    searchFinanceHistory();
}

async function searchFinanceHistory() {
    const input = document.getElementById('financeHistoryParentAsinInput');
    const searchButton = document.getElementById('financeHistorySearchBtn');
    const parentAsin = valueToFinanceText(input.value).toUpperCase();

    // 与导入时的父 ASIN 标准化保持一致。这样用户输入小写或两侧空格时，
    // 也不会因为展示层差异漏掉本应命中的历史记录。
    input.value = parentAsin;
    if (!parentAsin) {
        showFinanceHistoryQueryStatus('请输入父 ASIN', 'error');
        input.focus();
        return;
    }
    if (financeHistoryQueryInProgress) return;

    const requestVersion = ++financeHistoryRequestVersion;
    financeHistoryQueryInProgress = true;
    searchButton.disabled = true;
    showFinanceHistoryQueryStatus('正在查询 ' + parentAsin + ' 的历史数据…', 'loading');

    try {
        // 此接口只读取服务器已归档的数据。待确认保存的 Excel 预览不能混入历史
        // 结果，否则用户会无法判断某条记录是否已经写入并可被其他账号读取。
        const result = await financeApiRequest(
            '/api/finance_profit/history?parent_asin=' + encodeURIComponent(parentAsin)
        );
        if (requestVersion !== financeHistoryRequestVersion) return;

        const rows = Array.isArray(result.data) ? result.data : [];
        renderFinanceHistoryResults(rows);
        if (result.status === 'empty') {
            showFinanceHistoryQueryStatus('数据库暂未归档财务报表', 'error');
        } else {
            const matchedTotal = Number(result.matched_total) || 0;
            showFinanceHistoryQueryStatus(
                '查询完成：' + rows.length + ' 个自然月，其中 ' + matchedTotal + ' 个月有数据',
                'success'
            );
        }
    } catch (error) {
        if (requestVersion === financeHistoryRequestVersion) {
            showFinanceHistoryQueryStatus(error.message, 'error');
        }
    } finally {
        if (requestVersion === financeHistoryRequestVersion) {
            financeHistoryQueryInProgress = false;
            searchButton.disabled = false;
        }
    }
}

function clearFinanceHistorySearch() {
    // 作废正在返回的旧请求，防止用户清空后旧响应再次把结果区显示出来。
    financeHistoryRequestVersion += 1;
    financeHistoryQueryInProgress = false;
    document.getElementById('financeHistoryParentAsinInput').value = '';
    document.getElementById('financeHistorySearchBtn').disabled = false;
    document.getElementById('financeHistoryResults').hidden = true;
    document.getElementById('financeHistoryTableHead').innerHTML = '';
    document.getElementById('financeHistoryTableBody').innerHTML = '';
    document.getElementById('financeHistoryResultCount').textContent = '';
    showFinanceHistoryQueryStatus('', '');
}

function renderFinanceHistoryResults(rows) {
    const results = document.getElementById('financeHistoryResults');
    const thead = document.getElementById('financeHistoryTableHead');
    const tbody = document.getElementById('financeHistoryTableBody');
    const count = document.getElementById('financeHistoryResultCount');
    results.hidden = false;
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const headerRow = document.createElement('tr');
    const monthHeader = document.createElement('th');
    monthHeader.className = 'finance-history-time-col';
    monthHeader.textContent = '时间';
    headerRow.appendChild(monthHeader);
    FINANCE_FIELDS.forEach(function(field) {
        const th = document.createElement('th');
        th.textContent = field;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    if (!rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = FINANCE_FIELDS.length + 1;
        td.className = 'finance-history-empty-cell';
        td.textContent = '暂无已归档的财务报表';
        tr.appendChild(td);
        tbody.appendChild(tr);
        count.textContent = '共 0 个月';
        return;
    }

    const matchedTotal = rows.filter(function(row) { return row.has_data; }).length;
    count.textContent = '共 ' + rows.length + ' 个月 · ' + matchedTotal + ' 个月有数据';
    rows.forEach(function(row) {
        const tr = document.createElement('tr');
        const monthCell = document.createElement('td');
        monthCell.className = 'finance-history-time-col';
        monthCell.textContent = valueToFinanceText(row.report_month) || '-';
        tr.appendChild(monthCell);

        if (!row.has_data) {
            const emptyCell = document.createElement('td');
            emptyCell.colSpan = FINANCE_FIELDS.length;
            emptyCell.className = 'finance-history-no-data-cell';
            emptyCell.textContent = '无数据';
            tr.appendChild(emptyCell);
        } else {
            FINANCE_FIELDS.forEach(function(field) {
                const td = document.createElement('td');
                td.textContent = formatFinanceCell(field, row[field]);
                if (FINANCE_TEXT_FIELDS.has(field)) td.title = valueToFinanceText(row[field]);
                if (!FINANCE_TEXT_FIELDS.has(field) && toFinanceNumber(row[field]) < 0) {
                    td.classList.add('finance-negative');
                }
                tr.appendChild(td);
            });
        }
        tbody.appendChild(tr);
    });
}

function showFinanceHistoryQueryStatus(message, type) {
    const element = document.getElementById('financeHistoryQueryStatus');
    element.textContent = message || '';
    element.className = 'finance-history-query-status' + (type ? ' ' + type : '');
}

function handleFinanceSort(field) {
    if (FINANCE_TEXT_FIELDS.has(field) || FINANCE_FIELDS.indexOf(field) === -1) return;

    if (currentFinanceSort.field !== field) {
        currentFinanceSort = { field: field, direction: 'desc' };
    } else if (currentFinanceSort.direction === 'desc') {
        currentFinanceSort.direction = 'asc';
    } else if (currentFinanceSort.direction === 'asc') {
        currentFinanceSort = { field: null, direction: 'none' };
    } else {
        currentFinanceSort = { field: field, direction: 'desc' };
    }

    updateFinanceSortIndicators();
    applyFinanceFilter();
}

function resetFinanceSort() {
    currentFinanceSort = { field: null, direction: 'none' };
    updateFinanceSortIndicators();
}

function updateFinanceSortIndicators() {
    document.querySelectorAll('.finance-profit-table .sort-icon').forEach(function(icon) {
        icon.className = 'sort-icon sort-none finance-sort-icon';
    });
    document.querySelectorAll('.finance-profit-table th[data-finance-sort-field]').forEach(function(th) {
        th.setAttribute('aria-sort', 'none');
    });

    if (!currentFinanceSort.field || currentFinanceSort.direction === 'none') return;
    const fieldIndex = FINANCE_FIELDS.indexOf(currentFinanceSort.field);
    const icon = document.getElementById('finance-sort-icon-' + fieldIndex);
    if (icon) {
        icon.className = 'sort-icon finance-sort-icon ' +
            (currentFinanceSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
    }
    document.querySelectorAll('.finance-profit-table th[data-finance-sort-field]').forEach(function(th) {
        if (th.getAttribute('data-finance-sort-field') === currentFinanceSort.field) {
            th.setAttribute('aria-sort', currentFinanceSort.direction === 'asc' ? 'ascending' : 'descending');
        }
    });
}

function isBlankFinanceSortValue(value) {
    return value === undefined || value === null ||
        (typeof value === 'string' && value.trim() === '');
}

function parseFinanceSortNumber(field, value) {
    if (isBlankFinanceSortValue(value)) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    let text = String(value).trim();
    if (text === '-' || text === '--') return null;
    const isPercent = text.endsWith('%');
    const isParenthesizedNegative = text.startsWith('(') && text.endsWith(')');
    text = text.replace(/,/g, '').replace(/\$/g, '').replace(/%/g, '').trim();
    if (isParenthesizedNegative) text = '-' + text.slice(1, -1).trim();

    let number = Number(text);
    if (!Number.isFinite(number)) return null;
    if (FINANCE_RATIO_FIELDS.has(field) && isPercent) number /= 100;
    return number;
}

function applyFinanceFilter() {
    let processedRows = financeRows.map(function(row, sourceIndex) {
        return { row: row, sourceIndex: sourceIndex };
    });

    if (currentFinanceSearch) {
        processedRows = processedRows.filter(function(entry) {
            const row = entry.row;
            const searchText = [row['父ASIN'], row['品名'], row['品类']]
                .map(valueToFinanceText)
                .join(' ')
                .toLowerCase();
            return searchText.indexOf(currentFinanceSearch) !== -1;
        });
    }

    if (currentFinanceSort.field && currentFinanceSort.direction !== 'none') {
        processedRows.sort(function(a, b) {
            const field = currentFinanceSort.field;
            const valueA = parseFinanceSortNumber(field, a.row[field]);
            const valueB = parseFinanceSortNumber(field, b.row[field]);

            // 空值和无法识别的数值始终放在末尾，不能与业务上的真实 0 混为一谈。
            if (valueA === null && valueB === null) return a.sourceIndex - b.sourceIndex;
            if (valueA === null) return 1;
            if (valueB === null) return -1;

            if (valueA !== valueB) {
                const difference = valueA < valueB ? -1 : 1;
                return currentFinanceSort.direction === 'asc' ? difference : -difference;
            }
            // 数值相同保持 Excel / 服务器原始行顺序，避免每次点击出现无意义抖动。
            return a.sourceIndex - b.sourceIndex;
        });
    }

    visibleFinanceRows = processedRows.map(function(entry) { return entry.row; });
    renderFinanceTable(visibleFinanceRows);
    document.getElementById('toolbar-total-count').textContent = '共 ' + visibleFinanceRows.length + ' 条';
}

function renderFinanceTable(rows) {
    const tbody = document.getElementById('financeTableBody');
    tbody.innerHTML = '';

    if (!rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = FINANCE_FIELDS.length;
        td.className = 'finance-empty-cell';
        td.textContent = financeRows.length ? '没有匹配的记录' : '尚未上传财务利润表';
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        rows.forEach(function(row) {
            const tr = document.createElement('tr');
            FINANCE_FIELDS.forEach(function(field, index) {
                const td = document.createElement('td');
                if (index === 0) td.className = 'finance-sticky-col-1';
                if (index === 1) td.className = 'finance-sticky-col-2';
                td.textContent = formatFinanceCell(field, row[field]);
                if (FINANCE_TEXT_FIELDS.has(field)) td.title = valueToFinanceText(row[field]);
                if (!FINANCE_TEXT_FIELDS.has(field) && toFinanceNumber(row[field]) < 0) {
                    td.classList.add('finance-negative');
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
    }

    if (window._initColumnResize && !financeColumnResizeInitialized) {
        window._initColumnResize();
        financeColumnResizeInitialized = true;
    }
    updateFinanceStickyColumns();
}

function updateFinanceStickyColumns() {
    const firstHeader = document.querySelector('.finance-profit-table thead .finance-sticky-col-1');
    if (!firstHeader) return;
    const firstWidth = firstHeader.getBoundingClientRect().width;
    document.querySelectorAll('.finance-profit-table .finance-sticky-col-1').forEach(function(cell) {
        cell.style.left = '0px';
    });
    document.querySelectorAll('.finance-profit-table .finance-sticky-col-2').forEach(function(cell) {
        cell.style.left = firstWidth + 'px';
    });
}

window._onColumnWidthsChanged = updateFinanceStickyColumns;
window.addEventListener('resize', updateFinanceStickyColumns);
window.addEventListener('beforeunload', function(event) {
    if (!pendingFinancePayload) return;
    // 浏览器会显示自己的标准提示文案；设置 returnValue 是为了兼容旧版浏览器。
    event.preventDefault();
    event.returnValue = '';
});

function resetFinancePage() {
    currentFinanceReport = null;
    financeRows = [];
    visibleFinanceRows = [];
    resetFinanceSort();
    document.getElementById('target-time').textContent = '--';
    renderFinanceCards([]);
    renderFinanceTable([]);
    document.getElementById('toolbar-total-count').textContent = '共 0 条';
    showFinanceStatus(
        financeCanUpload ? '请上传单款财务利润 Excel' : '暂无财务利润数据（当前账号为只读权限）',
        'success'
    );
}

// ==================== CSV 下载 ====================

function downloadFinanceCSV() {
    if (!visibleFinanceRows.length) {
        showFinanceStatus('当前没有可下载的数据', 'error');
        return;
    }

    const lines = [FINANCE_FIELDS.map(csvEscape).join(',')];
    visibleFinanceRows.forEach(function(row) {
        lines.push(FINANCE_FIELDS.map(function(field) {
            // 下载口径与用户当前看到的表格保持一致：比例导出为百分号，金额保留美元符号，
            // 避免同一份报表在页面与 CSV 中出现两套难以对照的表现形式。
            return csvEscape(formatFinanceCell(field, row[field]));
        }).join(','));
    });

    const csv = '\ufeff' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const month = currentFinanceReport ? currentFinanceReport.report_month : 'latest';
    link.href = url;
    link.download = 'finance_profit_' + month + '.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function csvEscape(value) {
    const text = String(value === undefined || value === null ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
}

// ==================== 格式化与状态 ====================

function valueToFinanceText(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function toFinanceNumber(value) {
    if (value === undefined || value === null || value === '') return 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function formatCurrency(value) {
    return '$' + toFinanceNumber(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatQuantity(value) {
    return Math.round(toFinanceNumber(value)).toLocaleString('en-US', {
        maximumFractionDigits: 0
    });
}

function formatRatio(value) {
    return (toFinanceNumber(value) * 100).toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }) + '%';
}

function formatFinanceCell(field, value) {
    if (value === undefined || value === null || value === '') return '-';
    if (FINANCE_RATIO_FIELDS.has(field)) return formatRatio(value);
    if (FINANCE_CURRENCY_FIELDS.has(field)) return formatCurrency(value);
    if (field === '销量') return formatQuantity(value);
    return valueToFinanceText(value) || '-';
}

function showFinanceStatus(message, type) {
    const element = document.getElementById('financeImportStatus');
    element.textContent = message || '';
    element.className = 'finance-import-status' + (type ? ' ' + type : '');
}
