/**
 * sales.js — 销售仪表盘专属逻辑
 * 依赖：common.js 必须先加载
 */

// ==================== 销售页全局状态 ====================
let globalRecords = [];
let currentSort = { key: null, direction: 'none' };
let currentSearchTerm = '';
let currentView = 'child'; // 'child' 或 'parent'

// ==================== 页面初始化 ====================

// 登录成功后由 common.js 调用
function onLoginSuccess() {
    fetchSalesData();
}

document.addEventListener('DOMContentLoaded', function() {
    if (isLoggedIn()) {
        hideLoginOverlay();
        fetchSalesData();
    } else {
        showLoginOverlay();
    }
});

// ==================== 数据获取 ====================

async function fetchSalesData() {
    const token = getToken();
    if (!token) {
        showLoginOverlay();
        return;
    }
    try {
        const response = await fetch(API_BASE + '/api/sales', {
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
            handleSort('今日销量');
        } else {
            console.error("从中转站抓取数据失败:", result);
        }
    } catch (error) {
        console.error("无法连接服务器:", error);
    }
}

// ==================== 卡片计算与渲染 ====================

function calculateAndRenderCards(records) {
    let totalQtyToday = 0, totalQtyYesterday = 0;
    let totalSalesToday = 0, totalSalesYesterday = 0;

    records.forEach(record => {
        const fields = record.fields;
        if (!fields || Object.keys(fields).length === 0) return;
        totalQtyToday += parseInt(fields['今日销量']) || 0;
        totalQtyYesterday += parseInt(fields['昨日销量']) || 0;
        totalSalesToday += parseFloat(fields['今日销售额']) || 0;
        totalSalesYesterday += parseFloat(fields['昨日销售额']) || 0;
    });

    function formatTrendHtml(todayVal, yesterdayVal) {
        if (!yesterdayVal || yesterdayVal === 0) {
            return todayVal > 0 ? `<span class="trend-up">↑ 100.00%</span>` : `<span class="trend-none">0.00%</span>`;
        }
        const changeRate = ((todayVal - yesterdayVal) / yesterdayVal) * 100;
        if (changeRate > 0) return `<span class="trend-up">↑ ${changeRate.toFixed(2)}%</span>`;
        if (changeRate < 0) return `<span class="trend-down">↓ ${Math.abs(changeRate).toFixed(2)}%</span>`;
        return `<span class="trend-none">0.00%</span>`;
    }

    document.getElementById('card-qty-today').innerText = totalQtyToday.toLocaleString();
    document.getElementById('card-qty-footer').innerHTML = `<span>昨日累计 ${totalQtyYesterday.toLocaleString()}</span>${formatTrendHtml(totalQtyToday, totalQtyYesterday)}`;
    document.getElementById('card-sales-today').innerText = `$${totalSalesToday.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('card-sales-footer').innerHTML = `<span>昨日累计 $${totalSalesYesterday.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>${formatTrendHtml(totalSalesToday, totalSalesYesterday)}`;
    document.getElementById('card-amount-today').innerText = `$${totalSalesToday.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('card-amount-footer').innerHTML = `<span>昨日累计 $${totalSalesYesterday.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>${formatTrendHtml(totalSalesToday, totalSalesYesterday)}`;

    const avgPriceToday = totalQtyToday > 0 ? (totalSalesToday / totalQtyToday) : 0;
    const avgPriceYesterday = totalQtyYesterday > 0 ? (totalSalesYesterday / totalQtyYesterday) : 0;
    document.getElementById('card-avgprice-today').innerText = `$${avgPriceToday.toFixed(2)}`;
    document.getElementById('card-avgprice-footer').innerHTML = `<span>昨日累计 $${avgPriceYesterday.toFixed(2)}</span>${formatTrendHtml(avgPriceToday, avgPriceYesterday)}`;
}

// ==================== 视图切换 / 搜索 / 排序 ====================

function switchView(viewName) {
    currentView = viewName;
    document.querySelectorAll('.seg-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-${viewName}`).classList.add('active');
    applyFilterAndSort();
}

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
    if (currentSort.direction === 'desc') activeIcon.className = 'sort-icon sort-desc';
    if (currentSort.direction === 'asc') activeIcon.className = 'sort-icon sort-asc';

    applyFilterAndSort();
}

// ==================== 核心：过滤 + 聚合 + 排序 + 渲染 ====================

function applyFilterAndSort() {
    let processedRecords = [...globalRecords];

    // 1. 关键词过滤：子ASIN、父ASIN、MSKU、产品名称 四个字段同时搜索
    if (currentSearchTerm) {
        processedRecords = processedRecords.filter(record => {
            const f = record.fields;
            const searchFields = [
                f['子ASIN'],
                f['父ASIN'],
                f['MSKU'],
                f['产品名称']
            ];
            return searchFields.some(val => (val || '').toLowerCase().includes(currentSearchTerm));
        });
    }

    // 2. 聚合视图逻辑（父ASIN）
    if (currentView === 'parent') {
        const parentMap = {};
        processedRecords.forEach(record => {
            const f = record.fields;
            const pAsin = f['父ASIN'] || '无父ASIN';

            if (!parentMap[pAsin]) {
                parentMap[pAsin] = {
                    '产品名称': f['产品名称'],
                    '产品图': f['产品图'],
                    '父ASIN': pAsin,
                    '子ASIN_list': [],
                    'MSKU_list': [],
                    '目标销量': 0,
                    '今日销量': 0,
                    '今日销售额': 0,
                    '昨日销量': 0,
                    '昨日销售额': 0,
                    '上周同日销量': 0,
                    '可售库存': 0,
                    '今日单价_list': [],
                    '昨日单价_list': [],
                    '估算昨日基准': 0,
                    '大类排名': f['大类排名'] || '-',
                    '小类排名': f['小类排名'] || '-'
                };
            }

            const p = parentMap[pAsin];
            if (f['子ASIN'] && !p['子ASIN_list'].includes(f['子ASIN'])) p['子ASIN_list'].push(f['子ASIN']);
            if (f['MSKU'] && !p['MSKU_list'].includes(f['MSKU'])) p['MSKU_list'].push(f['MSKU']);

            p['目标销量'] += parseInt(f['目标销量']) || 0;
            p['今日销量'] += parseInt(f['今日销量']) || 0;
            p['今日销售额'] += parseFloat(f['今日销售额']) || 0;
            p['昨日销量'] += parseInt(f['昨日销量']) || 0;
            p['昨日销售额'] += parseFloat(f['昨日销售额']) || 0;
            p['上周同日销量'] += parseInt(f['上周同日销量']) || 0;
            p['可售库存'] += parseInt(f['可售库存']) || 0;

            if (f['今日单价']) p['今日单价_list'].push(parseFloat(f['今日单价']));
            if (f['昨日单价']) p['昨日单价_list'].push(parseFloat(f['昨日单价']));

            const todayVol = parseInt(f['今日销量']) || 0;
            const rateVal = parseFloat(f['环比昨日']) || 0;
            let baseline = todayVol / (1 + rateVal);
            if (isNaN(baseline) || !isFinite(baseline)) baseline = 0;
            p['估算昨日基准'] += baseline;
        });

        processedRecords = Object.keys(parentMap).map(key => {
            const p = parentMap[key];
            const avgTodayPrice = p['今日单价_list'].length > 0 ? (p['今日单价_list'].reduce((a,b)=>a+b,0) / p['今日单价_list'].length) : 0;
            const avgYestPrice = p['昨日单价_list'].length > 0 ? (p['昨日单价_list'].reduce((a,b)=>a+b,0) / p['昨日单价_list'].length) : 0;

            let finalBaseline = p['估算昨日基准'];
            if (finalBaseline <= 0 && p['今日销量'] > 0) finalBaseline = 1;
            const finalRate = finalBaseline > 0 ? (p['今日销量'] - finalBaseline) / finalBaseline : 0;

            const sellDays = p['昨日销量'] > 0 ? (p['可售库存'] / p['昨日销量']).toFixed(0) : 0;

            return {
                fields: {
                    '产品名称': p['产品名称'],
                    '产品图': p['产品图'],
                    '父ASIN': p['父ASIN'],
                    '子ASIN_list': p['子ASIN_list'],
                    'MSKU_list': p['MSKU_list'],
                    '目标销量': p['目标销量'],
                    '今日销量': p['今日销量'],
                    '环比昨日': finalRate,
                    '今日销售额': p['今日销售额'],
                    '今日单价': avgTodayPrice,
                    '昨日销量': p['昨日销量'],
                    '昨日销售额': p['昨日销售额'],
                    '昨日单价': avgYestPrice,
                    '上周同日销量': p['上周同日销量'],
                    '可售库存': p['可售库存'],
                    '可售天数': sellDays,
                    '大类排名': p['大类排名'],
                    '小类排名': p['小类排名']
                }
            };
        });
    }

    // 3. 排序
    if (currentSort.direction !== 'none' && currentSort.key) {
        processedRecords.sort((a, b) => {
            let valA = parseFloat(a.fields[currentSort.key]) || 0;
            let valB = parseFloat(b.fields[currentSort.key]) || 0;
            if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
            return 0;
        });
    }

    // 4. 渲染
    renderTable(processedRecords);
    document.getElementById('toolbar-total-count').innerText = `共 ${processedRecords.length} 条`;
}

// ==================== 表格渲染 ====================

function renderTable(records) {
    const tbody = document.querySelector('tbody');
    tbody.innerHTML = '';

    records.forEach(record => {
        const fields = record.fields;
        if (Object.keys(fields).length === 0) return;

        let imgHtml = '<div style="width:25px; height:25px; background-color:#f2f3f5; border-radius:2px;"></div>';
        if (fields['产品图'] && fields['产品图'].length > 0) {
            const rawFeishuImgUrl = fields['产品图'][0].url;
            const imgToken = getToken();
            imgHtml = `<img src="${API_BASE}/api/image?url=${encodeURIComponent(rawFeishuImgUrl)}&_token=${encodeURIComponent(imgToken || '')}" loading="lazy" onerror="handleImageError(this)" style="width:25px; height:25px; object-fit:cover; border-radius:2px; display:block;">`;
        }

        let trendClass = '', trendText = '-';
        if (fields['环比昨日'] !== undefined && fields['环比昨日'] !== '') {
            const num = parseFloat(fields['环比昨日']);
            const percentage = (Math.abs(num) * 100).toFixed(0) + '%';
            if (num > 0) { trendClass = 'trend-up'; trendText = '+' + percentage; }
            else if (num < 0) { trendClass = 'trend-down'; trendText = '-' + percentage; }
            else { trendText = percentage; }
        }

        const cAsinDisplay = currentView === 'parent' ? renderCollapsibleList(fields['子ASIN_list'], true) : renderAsinWithLink(fields['子ASIN']);
        const mskuDisplay = currentView === 'parent' ? renderCollapsibleList(fields['MSKU_list']) : (fields['MSKU'] || '-');

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${fields['产品名称'] || '-'}</td>
            <td>${imgHtml}</td>
            <td>${renderAsinWithLink(fields['父ASIN'])}</td>
            <td>${cAsinDisplay}</td>
            <td>${mskuDisplay}</td>
            <td>${fields['目标销量'] || '-'}</td>
            <td>${fields['今日销量'] || '0'}</td>
            <td class="${trendClass}">${trendText}</td>
            <td>$${fields['今日销售额'] !== undefined && fields['今日销售额'] !== '' ? parseFloat(fields['今日销售额']).toFixed(2) : '0.00'}</td>
            <td>$${fields['今日单价'] !== undefined && fields['今日单价'] !== '' ? parseFloat(fields['今日单价']).toFixed(2) : '0.00'}</td>
            <td>${fields['昨日销量'] || '0'}</td>
            <td>$${fields['昨日销售额'] !== undefined && fields['昨日销售额'] !== '' ? parseFloat(fields['昨日销售额']).toFixed(2) : '0.00'}</td>
            <td>$${fields['昨日单价'] !== undefined && fields['昨日单价'] !== '' ? parseFloat(fields['昨日单价']).toFixed(2) : '0.00'}</td>
            <td>${fields['上周同日销量'] || '-'}</td>
            <td>${fields['可售库存'] || '0'}</td>
            <td>${fields['可售天数'] || '0'}</td>
            <td>${fields['大类排名'] || '-'}</td>
            <td>${fields['小类排名'] || '-'}</td>
            <td class="action-link">详情</td>
        `;
        tbody.appendChild(tr);
    });

    // 表格渲染完成后初始化列宽拖拽
    if (window._initColumnResize) {
        window._initColumnResize();
    }
}
