/**
 * inventory_value.js — 库存金额页面专属逻辑
 * 依赖：common.js 必须先加载。
 *
 * 本页字段来自 inventory_value.xlsx 第二行表头。第一行只是页面分组表头，
 * 不参与飞书字段读取；这样可以保证页面结构和 Excel 展示一致，同时让数据拉取
 * 仍然按飞书多维表格的字段名稳定匹配。
 */

// ==================== 字段映射配置（与飞书字段名保持一致） ====================
const FIELD_MAP = {
    '品名': '品名',
    '产品图': '产品图',
    '父ASIN': '父ASIN',
    '子ASIN': '子ASIN',
    'MSKU': 'MSKU',
    'FBA在途': 'FBA在途',
    'FBA库存': 'FBA库存',
    'FBA总量': 'FBA总量',
    'FBA总金额': 'FBA总金额',
    '西邮库存': '西邮库存',
    '西邮库存金额': '西邮库存金额',
    'LNK总量': 'LNK总量',
    'LNK总金额': 'LNK总金额',
    '海外总量': '海外总量',
    '海外总金额': '海外总金额',
    '惠安在途金额': '惠安在途金额',
    '惠安库存金额': '惠安库存金额',
    '泉州在途金额': '泉州在途金额',
    '泉州库存金额': '泉州库存金额',
    '杰戈在途金额': '杰戈在途金额',
    '杰戈库存金额': '杰戈库存金额',
    '国内库存金额': '国内库存金额',
    '惠安在途数量': '惠安在途数量',
    '惠安库存数量': '惠安库存数量',
    '泉州在途数量': '泉州在途数量',
    '泉州库存数量': '泉州库存数量',
    '杰戈在途数量': '杰戈在途数量',
    '杰戈库存数量': '杰戈库存数量',
    '国内库存总数': '国内库存总数'
};

const TABLE_FIELDS = [
    '品名', '产品图', '父ASIN', '子ASIN', 'MSKU',
    'FBA在途', 'FBA库存', 'FBA总量', 'FBA总金额', '西邮库存', '西邮库存金额',
    'LNK总量', 'LNK总金额', '海外总量', '海外总金额',
    '惠安在途金额', '惠安库存金额', '泉州在途金额', '泉州库存金额',
    '杰戈在途金额', '杰戈库存金额', '国内库存金额',
    '惠安在途数量', '惠安库存数量', '泉州在途数量', '泉州库存数量',
    '杰戈在途数量', '杰戈库存数量', '国内库存总数'
];

const AMOUNT_FIELDS = new Set([
    'FBA总金额', '西邮库存金额', 'LNK总金额', '海外总金额',
    '惠安在途金额', '惠安库存金额', '泉州在途金额', '泉州库存金额',
    '杰戈在途金额', '杰戈库存金额', '国内库存金额'
]);

const QUANTITY_FIELDS = new Set([
    'FBA在途', 'FBA库存', 'FBA总量', '西邮库存', 'LNK总量', '海外总量',
    '惠安在途数量', '惠安库存数量', '泉州在途数量', '泉州库存数量',
    '杰戈在途数量', '杰戈库存数量', '国内库存总数'
]);

const STICKY_COLUMN_COUNT = 5;

// ==================== 库存金额页全局状态 ====================
let globalRecords = [];
let currentSort = { key: null, direction: 'none' };
let currentSearchTerm = '';
let columnResizeInitialized = false;

// ==================== 页面初始化 ====================

function onLoginSuccess() {
    if (!requirePageTag('value')) { showLoginOverlay(); return; }
    fetchInventoryValueData();
}

document.addEventListener('DOMContentLoaded', function() {
    if (isLoggedIn()) {
        if (!requirePageTag('value')) return;
        hideLoginOverlay();
        fetchInventoryValueData();
    } else {
        showLoginOverlay();
    }
});

// ==================== 数据获取 ====================

async function fetchInventoryValueData() {
    const token = getToken();
    if (!token) {
        showLoginOverlay();
        return;
    }

    try {
        const response = await fetch(API_BASE + '/api/inventory_value', {
            headers: { 'Authorization': 'Bearer ' + token }
        });

        if (response.status === 401) {
            clearAuth();
            showLoginOverlay();
            return;
        }
        if (response.status === 403) {
            alert('您没有权限访问库存金额页面');
            return;
        }

        const result = await response.json();
        if (result.status === 'success') {
            globalRecords = result.data;
            calculateAndRenderCards(globalRecords);
            handleSort('海外总金额');
        } else {
            console.error('获取库存金额数据失败:', result);
        }
    } catch (error) {
        console.error('无法连接服务器:', error);
    }
}

// ==================== 字段读取与格式化 ====================

function getField(fields, displayName) {
    return fields[FIELD_MAP[displayName]];
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

function toNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    const text = valueToText(value).replace(/,/g, '').replace(/[^\d.-]/g, '');
    const num = parseFloat(text);
    return isFinite(num) ? num : 0;
}

function formatWholeNumber(value) {
    const rounded = Math.round(toNumber(value));
    return rounded.toLocaleString(undefined, {
        maximumFractionDigits: 0
    });
}

function formatAmount(value) {
    return formatWholeNumber(value);
}

function formatQuantity(value) {
    return formatWholeNumber(value);
}

function formatWan(value) {
    const rounded = Math.round((toNumber(value) / 10000) * 10) / 10;
    const normalized = Object.is(rounded, -0) ? 0 : rounded;
    return normalized.toLocaleString(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    }) + '万';
}

function formatCell(fieldName, value) {
    if (AMOUNT_FIELDS.has(fieldName)) return formatAmount(value);
    if (QUANTITY_FIELDS.has(fieldName)) return formatQuantity(value);
    const text = escapeHtml(value);
    return text || '-';
}

function renderAsinCell(value) {
    const asin = valueToText(value).trim();
    if (!asin || asin === '-') return '-';

    // ASIN 来自外部表格，展示文本必须转义；链接参数单独编码，避免特殊字符污染 href。
    const safeAsin = escapeHtml(asin);
    const encoded = encodeURIComponent(asin);
    return '<span class="asin-cell">' + safeAsin +
        '<a class="asin-link-btn" href="https://www.amazon.com/dp/' + encoded +
        '" target="_blank" title="在亚马逊查看 ' + safeAsin + '">↗</a></span>';
}

function renderProductImage(value) {
    const placeholder = '<div style="width:25px; height:25px; background-color:#f2f3f5; border-radius:2px;"></div>';
    if (!Array.isArray(value) || value.length === 0 || !value[0].url) return placeholder;

    const rawFeishuImgUrl = value[0].url;
    const imgToken = getToken();
    return `<img src="${API_BASE}/api/image?url=${encodeURIComponent(rawFeishuImgUrl)}&_token=${encodeURIComponent(imgToken || '')}" loading="lazy" onerror="handleImageError(this)" style="width:25px; height:25px; object-fit:cover; border-radius:2px; display:block;">`;
}

// ==================== 卡片计算与渲染 ====================

function calculateAndRenderCards(records) {
    let overseasAmount = 0;
    let domesticAmount = 0;
    let overseasQuantity = 0;
    let domesticQuantity = 0;
    let jiegeAmount = 0;
    let jiegeQuantity = 0;

    records.forEach(function(record) {
        const f = record.fields;
        if (!f || Object.keys(f).length === 0) return;

        overseasAmount += toNumber(getField(f, '海外总金额'));
        domesticAmount += toNumber(getField(f, '国内库存金额'));
        overseasQuantity += toNumber(getField(f, '海外总量'));
        domesticQuantity += toNumber(getField(f, '国内库存总数'));
        jiegeAmount += toNumber(getField(f, '杰戈库存金额'));
        jiegeQuantity += toNumber(getField(f, '杰戈库存数量'));
    });

    // 业务口径：金额与库存成对展示，减少同一口径被拆成两张卡片造成的阅读成本。
    document.getElementById('card-total-amount').innerText = formatWan(overseasAmount + domesticAmount);
    document.getElementById('card-total-quantity').innerText = formatWan(overseasQuantity + domesticQuantity);
    document.getElementById('card-overseas-amount').innerText = formatWan(overseasAmount);
    document.getElementById('card-overseas-quantity').innerText = formatWan(overseasQuantity);
    document.getElementById('card-supplier-amount').innerText = formatWan(domesticAmount);
    document.getElementById('card-supplier-quantity').innerText = formatWan(domesticQuantity);
    document.getElementById('card-jiege-amount').innerText = formatWan(jiegeAmount);
    document.getElementById('card-jiege-quantity').innerText = formatWan(jiegeQuantity);
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

    document.querySelectorAll('.sort-icon').forEach(function(icon) {
        icon.className = 'sort-icon sort-none';
    });
    const activeIcon = document.getElementById(`sort-icon-${key}`);
    if (activeIcon) {
        if (currentSort.direction === 'desc') activeIcon.className = 'sort-icon sort-desc';
        if (currentSort.direction === 'asc') activeIcon.className = 'sort-icon sort-asc';
    }

    applyFilterAndSort();
}

// ==================== 核心：过滤 + 排序 + 渲染 ====================

function applyFilterAndSort() {
    let processedRecords = globalRecords.slice();

    if (currentSearchTerm) {
        processedRecords = processedRecords.filter(function(record) {
            const f = record.fields;
            const searchFields = [
                getField(f, '品名'),
                getField(f, 'MSKU'),
                getField(f, '父ASIN'),
                getField(f, '子ASIN')
            ];
            return searchFields.some(function(value) {
                return valueToText(value).toLowerCase().indexOf(currentSearchTerm) !== -1;
            });
        });
    }

    if (currentSort.direction !== 'none' && currentSort.key) {
        processedRecords.sort(function(a, b) {
            const key = currentSort.key;
            const rawA = getField(a.fields, key);
            const rawB = getField(b.fields, key);

            if (AMOUNT_FIELDS.has(key) || QUANTITY_FIELDS.has(key)) {
                const valA = toNumber(rawA);
                const valB = toNumber(rawB);
                if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
                if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
                return 0;
            }

            const textA = valueToText(rawA);
            const textB = valueToText(rawB);
            return currentSort.direction === 'asc'
                ? textA.localeCompare(textB, 'zh-CN')
                : textB.localeCompare(textA, 'zh-CN');
        });
    }

    renderTable(processedRecords);
    document.getElementById('toolbar-total-count').innerText = `共 ${processedRecords.length} 条`;
}

// ==================== 表格渲染 ====================

function renderTable(records) {
    const tbody = document.querySelector('tbody');
    tbody.innerHTML = '';

    renderSummaryRow(tbody, records);

    records.forEach(function(record) {
        const f = record.fields;
        if (!f || Object.keys(f).length === 0) return;

        const tr = document.createElement('tr');
        const cells = [];

        cells.push('<td class="sticky-col-1" title="' + escapeHtml(getField(f, '品名')) + '">' + formatCell('品名', getField(f, '品名')) + '</td>');
        cells.push('<td class="sticky-col-2">' + renderProductImage(getField(f, '产品图')) + '</td>');
        cells.push('<td class="sticky-col-3">' + renderAsinCell(getField(f, '父ASIN')) + '</td>');
        cells.push('<td class="sticky-col-4">' + renderAsinCell(getField(f, '子ASIN')) + '</td>');
        cells.push('<td class="sticky-col-5">' + formatCell('MSKU', getField(f, 'MSKU')) + '</td>');

        TABLE_FIELDS.slice(5).forEach(function(fieldName) {
            cells.push('<td>' + formatCell(fieldName, getField(f, fieldName)) + '</td>');
        });

        tr.innerHTML = cells.join('');
        tbody.appendChild(tr);
    });

    // common.js 的列宽拖拽会给表头追加拖拽手柄；表头是静态的，所以只初始化一次，避免重复追加。
    if (window._initColumnResize && !columnResizeInitialized) {
        window._initColumnResize();
        columnResizeInitialized = true;
    }
    updateStickyColumns();
}

function renderSummaryRow(tbody, records) {
    const totals = {};

    // 合计行只汇总当前筛选后的可见记录，与表格条数保持同一口径。
    records.forEach(function(record) {
        const f = record.fields;
        if (!f || Object.keys(f).length === 0) return;

        TABLE_FIELDS.slice(STICKY_COLUMN_COUNT).forEach(function(fieldName) {
            totals[fieldName] = (totals[fieldName] || 0) + toNumber(getField(f, fieldName));
        });
    });

    const tr = document.createElement('tr');
    tr.className = 'inventory-value-summary-row';

    const cells = [
        '<td class="sticky-col-1 summary-label">合计</td>',
        '<td class="sticky-col-2 summary-empty"></td>',
        '<td class="sticky-col-3 summary-empty"></td>',
        '<td class="sticky-col-4 summary-empty"></td>',
        '<td class="sticky-col-5 summary-empty"></td>'
    ];

    TABLE_FIELDS.slice(STICKY_COLUMN_COUNT).forEach(function(fieldName) {
        cells.push('<td>' + formatCell(fieldName, totals[fieldName] || 0) + '</td>');
    });

    tr.innerHTML = cells.join('');
    tbody.appendChild(tr);
}

// ==================== 冻结列位置更新 ====================

function updateStickyColumns() {
    let left = 0;

    for (let i = 1; i <= STICKY_COLUMN_COUNT; i++) {
        const headerCell = document.querySelector('thead tr:nth-child(2) th.sticky-col-' + i);
        if (!headerCell) return;

        const leftOffset = left + 'px';
        document.querySelectorAll('.inventory-value-table .sticky-col-' + i).forEach(function(cell) {
            cell.style.left = leftOffset;
        });

        left += headerCell.offsetWidth;
    }

    const productGroup = document.querySelector('.inventory-value-table .sticky-col-group-products');
    if (productGroup) {
        productGroup.style.left = '0px';
        productGroup.style.width = left + 'px';
        productGroup.style.minWidth = left + 'px';
    }
}

window._onColumnWidthsChanged = updateStickyColumns;
window.addEventListener('resize', updateStickyColumns);

// ==================== CSV 下载 ====================

function downloadCSV() {
    const headerRows = document.querySelectorAll('table thead tr');
    if (headerRows.length < 2) return;

    const headers = [];
    headerRows[1].querySelectorAll('th').forEach(function(th) {
        headers.push(th.textContent.trim());
    });

    const rows = [];
    document.querySelectorAll('tbody tr').forEach(function(tr) {
        const row = [];
        tr.querySelectorAll('td').forEach(function(td) {
            const clone = td.cloneNode(true);
            clone.querySelectorAll('.asin-link-btn').forEach(function(btn) { btn.remove(); });
            row.push(clone.textContent.trim());
        });
        rows.push(row);
    });

    if (rows.length === 0) return;

    function csvEscape(str) {
        if (!str && str !== '0') return '';
        str = String(str);
        if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    const bom = '\uFEFF';
    let csv = bom + headers.map(csvEscape).join(',') + '\n';
    rows.forEach(function(row) {
        csv += row.map(csvEscape).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const today = new Date().toISOString().slice(0, 10);
    a.download = 'inventory_value_' + today + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
