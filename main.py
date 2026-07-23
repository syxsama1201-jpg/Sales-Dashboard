import requests
import hmac
import hashlib
import base64
import time
import json
import math
import os
import sqlite3
import sys
import threading
from collections import OrderedDict
from urllib.parse import urlparse
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import uvicorn

# ================= 核心配置区 =================
def get_config():
    config_filename = "config.json"
    if getattr(sys, 'frozen', False):
        run_dir = os.path.dirname(sys.executable)
    else:
        run_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(run_dir, config_filename)

config_path = get_config()

with open(config_path, "r", encoding="utf-8") as f:
    config = json.load(f)


# 飞书凭证
APP_ID = config["APP_ID"]
APP_SECRET = config["APP_SECRET"]

# 销售多维表格
APP_TOKEN = config["APP_TOKEN"]
TABLE_ID = config["TABLE_ID"]

# 库存多维表格
INVENTORY_APP_TOKEN = config["INVENTORY_APP_TOKEN"]
INVENTORY_TABLE_ID = config["INVENTORY_TABLE_ID"]

# 库存金额多维表格
# 使用 get 读取是为了避免旧服务器配置尚未补齐时启动失败；
# 真正访问 /api/inventory_value 时再返回明确的配置缺失错误。
INVENTORY_VALUE_APP_TOKEN = config.get("INVENTORY_VALUE_APP_TOKEN")
INVENTORY_VALUE_TABLE_ID = config.get("INVENTORY_VALUE_TABLE_ID")

# 历史销量多维表格
HISTORY_APP_TOKEN = config["HISTORY_APP_TOKEN"]
HISTORY_TABLE_ID = config["HISTORY_TABLE_ID"]

# 发货审核当前状态数据库
# 默认写在当前工作目录，可用环境变量 SHIPMENT_DB_PATH 指定绝对路径
SHIPMENT_DB_PATH = os.environ.get("SHIPMENT_DB_PATH", "./shipment_current.db")

# 单款财务利润数据库
# 财务报表需要按月份长期保留，不能像发货审核那样只覆盖一条 JSON。
# 独立数据库既避免与现有业务表耦合，也便于服务器单独设置备份路径。
# 默认路径锚定到本文件目录，避免服务从 /root 等其他工作目录启动时意外创建空库。
# 仍允许部署环境通过 FINANCE_DB_PATH 指向独立的数据盘或备份目录。
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FINANCE_DB_PATH = os.environ.get("FINANCE_DB_PATH", os.path.join(BASE_DIR, "finance_profit.db"))

# Excel 第二行的表头是导入契约。前端会先校验一次，后端仍需再次校验，
# 因为不能把浏览器提交的数据默认视为可信。
# “海外仓仓租”是可选字段：旧版 25 列模板不含它，新版模板将其放在“仓储费$”后。
OVERSEAS_STORAGE_RENT_FIELD = "海外仓仓租"
FINANCE_FIELD_DEFINITIONS = (
    ("父ASIN", "parent_asin", "text"),
    ("品名", "product_name", "text"),
    ("销售额$", "sales_amount", "number"),
    ("销量", "sales_quantity", "number"),
    ("客单价$", "unit_price", "number"),
    ("FBA fee", "fba_fee_per_unit", "number"),
    ("利润额$", "profit_amount", "number"),
    ("利润率", "profit_margin", "ratio"),
    ("退货率", "return_rate", "ratio"),
    ("广告占比", "ad_ratio", "ratio"),
    ("折扣活动占比", "promotion_ratio", "ratio"),
    ("采购成本占比", "purchase_cost_ratio", "ratio"),
    ("物流成本占比", "logistics_cost_ratio", "ratio"),
    ("FBA fee 占比", "fba_fee_ratio", "ratio"),
    ("退货金额$", "return_amount", "number"),
    ("亚马逊扣费后金额$", "amazon_net_amount", "number"),
    ("仓储费占比", "storage_fee_ratio", "ratio"),
    ("广告费$", "ad_spend", "number"),
    ("折扣活动金额$", "promotion_amount", "number"),
    ("采购成本 $", "purchase_cost", "number"),
    ("物流成本$", "logistics_cost", "number"),
    ("FBA fee$", "fba_fee_amount", "number"),
    ("仓储费$", "storage_fee", "number"),
    (OVERSEAS_STORAGE_RENT_FIELD, "overseas_storage_rent", "number"),
    ("品类", "category", "text"),
    ("资产收益率", "asset_return_rate", "ratio"),
)
FINANCE_FIELDS = tuple(item[0] for item in FINANCE_FIELD_DEFINITIONS)
FINANCE_LEGACY_FIELDS = tuple(field for field in FINANCE_FIELDS if field != OVERSEAS_STORAGE_RENT_FIELD)

# ================= 登录认证配置 =================
# token 签名密钥（请自行修改为随机字符串）
SECRET_KEY = config["SECRET_KEY"]
# token 有效期（秒），默认 24 小时
TOKEN_EXPIRE_SECONDS = 2592000
# 用户列表：用户名 -> {password, tags}
# tags 可选值: sales, inventory, value, finance, finance_upload, replenishment, history
USERS = config["USERS"]

# =============图片请求url限制==================

ALLOWED_IMAGE_HOST_SUFFIXES = (
    ".feishu.cn",
    ".larksuite.com",
)

# 飞书附件图在表格中按行渲染时，浏览器会在很短时间内并发请求多张图片。
# 附件下载接口对突发 QPS 很敏感；因此在服务端统一限速，避免每个页面再各自实现一套不一致的节流逻辑。
IMAGE_FETCH_MIN_INTERVAL_SECONDS = 0.4
IMAGE_FETCH_MAX_CONCURRENCY = 2
IMAGE_FETCH_MAX_ATTEMPTS = 3
IMAGE_FETCH_RETRY_BASE_SECONDS = 1.0
IMAGE_FETCH_TIMEOUT = (5, 15)

# 缓存的是已经鉴权下载成功的图片二进制，而不是飞书 URL。这样既能降低飞书请求量，
# 也不会把带签名参数的 URL 暴露给浏览器缓存或日志。容量与条目数均受限，防止长期运行的容器无限占用内存。
IMAGE_CACHE_TTL_SECONDS = 60 * 60
IMAGE_CACHE_MAX_ENTRIES = 200
IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024

# 上游限流或短暂失败后，先把失败结果短暂复用给同一张图的等待请求。
# 否则一个页面的几十个相同/相近请求会在首次失败后立即再次冲击飞书。
IMAGE_FAILURE_TTL_SECONDS = 5
IMAGE_INFLIGHT_WAIT_SECONDS = 45

_image_cache = OrderedDict()
_image_cache_total_bytes = 0
_image_failures = OrderedDict()
_image_inflight = {}
_image_state_lock = threading.RLock()
_image_fetch_slot_lock = threading.Lock()
_image_fetch_semaphore = threading.BoundedSemaphore(IMAGE_FETCH_MAX_CONCURRENCY)
_image_next_fetch_at = 0.0


def get_cached_image(url: str):
    """Return a non-expired image and move it to the hot end of the LRU cache."""
    now = time.monotonic()
    with _image_state_lock:
        cached = _image_cache.get(url)
        if not cached:
            return None

        expires_at, content, content_type = cached
        if expires_at <= now:
            # Release the recorded bytes with the expired entry so the cache budget remains accurate.
            global _image_cache_total_bytes
            _image_cache.pop(url, None)
            _image_cache_total_bytes -= len(content)
            return None

        _image_cache.move_to_end(url)
        return content, content_type


def cache_image(url: str, content: bytes, content_type: str):
    """Store a successful image in a byte-bounded LRU cache for a limited time."""
    global _image_cache_total_bytes
    content_size = len(content)

    # Very large source images can still be returned once, but must not monopolize process memory.
    if content_size > IMAGE_CACHE_MAX_BYTES:
        return

    with _image_state_lock:
        previous = _image_cache.pop(url, None)
        if previous:
            _image_cache_total_bytes -= len(previous[1])

        while _image_cache and (
            len(_image_cache) >= IMAGE_CACHE_MAX_ENTRIES
            or _image_cache_total_bytes + content_size > IMAGE_CACHE_MAX_BYTES
        ):
            _, evicted = _image_cache.popitem(last=False)
            _image_cache_total_bytes -= len(evicted[1])

        _image_cache[url] = (
            time.monotonic() + IMAGE_CACHE_TTL_SECONDS,
            content,
            content_type,
        )
        _image_cache_total_bytes += content_size


def get_cached_image_failure(url: str):
    """Return a brief failure cache entry to prevent failed request bursts from repeating."""
    now = time.monotonic()
    with _image_state_lock:
        failure = _image_failures.get(url)
        if not failure:
            return None

        expires_at, status_code, detail = failure
        if expires_at <= now:
            _image_failures.pop(url, None)
            return None

        _image_failures.move_to_end(url)
        return status_code, detail


def cache_image_failure(url: str, status_code: int, detail: str):
    """Cache only short-lived failures, so a recovered upstream can be used promptly."""
    with _image_state_lock:
        _image_failures[url] = (
            time.monotonic() + IMAGE_FAILURE_TTL_SECONDS,
            status_code,
            detail,
        )
        _image_failures.move_to_end(url)
        while len(_image_failures) > IMAGE_CACHE_MAX_ENTRIES:
            _image_failures.popitem(last=False)


def claim_image_fetch(url: str):
    """Elect one downloader per URL; matching requests wait for that downloader's result."""
    with _image_state_lock:
        event = _image_inflight.get(url)
        if event:
            return False, event

        event = threading.Event()
        _image_inflight[url] = event
        return True, event


def finish_image_fetch(url: str, event: threading.Event):
    """Wake all waiters only after the elected downloader has stored its final result."""
    with _image_state_lock:
        if _image_inflight.get(url) is event:
            _image_inflight.pop(url, None)
            event.set()


def wait_for_image_fetch_slot():
    """Reserve a global start time so worker threads cannot create a Feishu QPS spike."""
    global _image_next_fetch_at
    with _image_fetch_slot_lock:
        now = time.monotonic()
        scheduled_at = max(now, _image_next_fetch_at)
        _image_next_fetch_at = scheduled_at + IMAGE_FETCH_MIN_INTERVAL_SECONDS

    delay = scheduled_at - now
    if delay > 0:
        time.sleep(delay)


def get_feishu_error_code(response):
    """Read a Feishu JSON error code when available; non-JSON errors have no code."""
    try:
        payload = response.json()
    except (ValueError, requests.RequestException):
        return None

    return payload.get("code") if isinstance(payload, dict) else None


def is_feishu_rate_limited(response) -> bool:
    """Recognize both modern HTTP 429 and legacy HTTP 400 code 99991400 responses."""
    return response.status_code == 429 or (
        response.status_code == 400 and get_feishu_error_code(response) == 99991400
    )


def make_image_response(content: bytes, content_type: str):
    """Keep browser caching private because the source endpoint is authenticated."""
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": f"private, max-age={IMAGE_CACHE_TTL_SECONDS}"},
    )


def fetch_feishu_image(url: str, headers: dict):
    """Fetch one image with bounded concurrency, global QPS pacing, and limited rate-limit retries."""
    host = urlparse(url).hostname or "unknown"

    for attempt in range(IMAGE_FETCH_MAX_ATTEMPTS):
        response = None
        try:
            # Concurrency alone is insufficient: fast requests can still exceed an API's per-second limit.
            # The semaphore bounds slow sockets while the slot reservation bounds total request start rate.
            with _image_fetch_semaphore:
                wait_for_image_fetch_slot()
                response = requests.get(url, headers=headers, timeout=IMAGE_FETCH_TIMEOUT)

            if response.status_code == 200:
                content = response.content
                if not content:
                    raise HTTPException(status_code=502, detail="飞书返回了空图片内容")
                return content, response.headers.get("Content-Type", "image/png")

            if is_feishu_rate_limited(response):
                if attempt < IMAGE_FETCH_MAX_ATTEMPTS - 1:
                    retry_delay = IMAGE_FETCH_RETRY_BASE_SECONDS * (2 ** attempt)
                    print(
                        "飞书图片请求触发限流，准备退避重试: "
                        f"host={host}, attempt={attempt + 1}, retry_in={retry_delay}s"
                    )
                    time.sleep(retry_delay)
                    continue

                print(f"飞书图片请求持续限流: host={host}, attempts={IMAGE_FETCH_MAX_ATTEMPTS}")
                raise HTTPException(
                    status_code=429,
                    detail="图片服务当前繁忙，请稍后刷新页面",
                    headers={"Retry-After": str(IMAGE_FAILURE_TTL_SECONDS)},
                )

            error_code = get_feishu_error_code(response)
            print(
                "飞书拒绝返回图片: "
                f"status={response.status_code}, code={error_code}, host={host}"
            )
            raise HTTPException(status_code=response.status_code, detail="飞书拒绝返回该图片素材")
        except HTTPException:
            raise
        except requests.RequestException as exc:
            # A Feishu attachment URL can carry temporary signature parameters, so never log the full URL.
            print(f"飞书图片请求异常: host={host}, error_type={type(exc).__name__}")
            raise HTTPException(status_code=502, detail="图片服务连接失败，请稍后重试")
        finally:
            if response is not None:
                response.close()

# ==========================================

app = FastAPI()

# ===== 跨域中间件 =====
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://sales-dashboard.acme-zone.com",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://192.168.50.105:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ================= 发货审核 SQLite 存储 =================

def init_shipment_db():
    """初始化发货审核当前状态表。只保存一条最新记录，不做版本管理。"""
    conn = sqlite3.connect(SHIPMENT_DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS shipment_current (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                updated_by TEXT
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def get_finance_db_connection():
    """创建启用外键约束的财务数据库连接。"""
    conn = sqlite3.connect(FINANCE_DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # SQLite 每个连接都要单独启用外键，否则替换月份时可能留下孤立明细。
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_finance_db():
    """初始化按月份归档的财务报表及明细表。"""
    conn = get_finance_db_connection()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS finance_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_month TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                source_filename TEXT,
                row_count INTEGER NOT NULL DEFAULT 0,
                has_overseas_storage_rent INTEGER NOT NULL DEFAULT 0,
                uploaded_at TEXT NOT NULL,
                uploaded_by TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS finance_report_rows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id INTEGER NOT NULL,
                row_no INTEGER NOT NULL,
                parent_asin TEXT NOT NULL,
                product_name TEXT,
                sales_amount REAL,
                sales_quantity REAL,
                unit_price REAL,
                fba_fee_per_unit REAL,
                profit_amount REAL,
                profit_margin REAL,
                return_rate REAL,
                ad_ratio REAL,
                promotion_ratio REAL,
                purchase_cost_ratio REAL,
                logistics_cost_ratio REAL,
                fba_fee_ratio REAL,
                return_amount REAL,
                amazon_net_amount REAL,
                storage_fee_ratio REAL,
                ad_spend REAL,
                promotion_amount REAL,
                purchase_cost REAL,
                logistics_cost REAL,
                fba_fee_amount REAL,
                storage_fee REAL,
                overseas_storage_rent REAL,
                category TEXT,
                asset_return_rate REAL,
                FOREIGN KEY (report_id) REFERENCES finance_reports(id) ON DELETE CASCADE,
                UNIQUE (report_id, parent_asin),
                UNIQUE (report_id, row_no)
            );

            CREATE INDEX IF NOT EXISTS idx_finance_rows_parent_asin
            ON finance_report_rows(parent_asin);
            """
        )
        # CREATE TABLE IF NOT EXISTS 不会为已经存在的库补齐新字段。这里先查字段名
        # 再执行幂等的 ALTER TABLE，使旧报表保留且默认标记为“不含海外仓仓租”。
        report_columns = {row["name"] for row in conn.execute("PRAGMA table_info(finance_reports)")}
        if "has_overseas_storage_rent" not in report_columns:
            conn.execute(
                "ALTER TABLE finance_reports "
                "ADD COLUMN has_overseas_storage_rent INTEGER NOT NULL DEFAULT 0"
            )

        row_columns = {row["name"] for row in conn.execute("PRAGMA table_info(finance_report_rows)")}
        if "overseas_storage_rent" not in row_columns:
            conn.execute(
                "ALTER TABLE finance_report_rows ADD COLUMN overseas_storage_rent REAL"
            )
        conn.commit()
    finally:
        conn.close()


def require_permission(user: str, tag: str, permission_name: str):
    """按 tag 校验当前用户权限，避免只依赖前端隐藏菜单造成接口绕过。"""
    user_info = USERS.get(user) or {}
    tags = user_info.get("tags", [])
    if tag not in tags:
        raise HTTPException(status_code=403, detail=f"无{permission_name}权限")


def require_any_permission(user: str, allowed_tags, permission_name: str):
    """允许多个业务页面复用同一个数据接口，但仍要限定在明确授权的 tag 范围内。"""
    user_info = USERS.get(user) or {}
    tags = user_info.get("tags", [])
    if not any(tag in tags for tag in allowed_tags):
        raise HTTPException(status_code=403, detail=f"无{permission_name}权限")


def require_replenishment_permission(user: str):
    """限制发货审核接口，只允许带 replenishment 权限的用户访问。"""
    require_permission(user, "replenishment", "发货审核")


def require_value_permission(user: str):
    """限制库存金额接口，只允许带 value 权限的用户访问。"""
    require_permission(user, "value", "库存金额")


def require_finance_permission(user: str):
    """财务利润数据较敏感，使用独立 finance 标签进行前后端双重鉴权。"""
    require_permission(user, "finance", "财务利润")


def require_finance_upload_permission(user: str):
    """
    财务上传使用独立权限。

    必须同时具备查看和上传标签，避免只配置 finance_upload 的账号绕过页面，
    直接调用保存接口写入自己无法查看的数据。
    """
    require_permission(user, "finance", "财务利润")
    require_permission(user, "finance_upload", "财务利润上传")


def get_now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def validate_finance_month(value) -> str:
    """校验并标准化 YYYY-MM，防止同一个月份出现多种字符串形式。"""
    month = str(value or "").strip()
    try:
        parsed = datetime.strptime(month, "%Y-%m")
    except ValueError:
        raise HTTPException(status_code=400, detail="报表月份必须是 YYYY-MM 格式")
    if parsed.strftime("%Y-%m") != month:
        raise HTTPException(status_code=400, detail="报表月份必须是 YYYY-MM 格式")
    return month


def normalize_finance_text(value) -> str:
    """把 Excel 文本单元格规范化为稳定字符串。"""
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple)):
        raise HTTPException(status_code=400, detail="财务表文本字段格式不合法")
    return str(value).strip()


def normalize_finance_number(value, is_ratio=False):
    """
    规范化 Excel 数值。

    历史文件可能把金额保存为带逗号或美元符号的文本，也可能把比例保存为
    ``10.5%``。统一在服务器处理，避免浏览器解析差异污染长期历史数据。
    """
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise HTTPException(status_code=400, detail="财务表数值字段不能是布尔值")

    has_percent = False
    if isinstance(value, str):
        text = value.strip()
        if text in ("", "-", "--"):
            return None
        has_percent = text.endswith("%")
        negative_by_parentheses = text.startswith("(") and text.endswith(")")
        text = text.replace(",", "").replace("$", "").replace("%", "").strip()
        if negative_by_parentheses:
            text = "-" + text[1:-1].strip()
        try:
            number = float(text)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"无法识别财务数值：{value}")
    elif isinstance(value, (int, float)):
        number = float(value)
    else:
        raise HTTPException(status_code=400, detail="财务表数值字段格式不合法")

    if not math.isfinite(number):
        raise HTTPException(status_code=400, detail="财务表包含无效数值")
    if is_ratio and has_percent:
        number /= 100
    return number


def normalize_finance_rows(rows, has_overseas_storage_rent: bool):
    """按新旧模板校验导入行，并返回完整数据库字段顺序的元组。"""
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=400, detail="Excel 中没有可保存的数据行")
    if len(rows) > 20000:
        raise HTTPException(status_code=400, detail="单次上传最多允许 20000 行")

    normalized_rows = []
    seen_parent_asins = set()
    for index, row in enumerate(rows, start=3):
        if not isinstance(row, dict):
            raise HTTPException(status_code=400, detail=f"Excel 第 {index} 行格式不合法")

        required_fields = FINANCE_FIELDS if has_overseas_storage_rent else FINANCE_LEGACY_FIELDS
        missing_fields = [field for field in required_fields if field not in row]
        if missing_fields:
            raise HTTPException(
                status_code=400,
                detail=f"Excel 第 {index} 行缺少字段：{missing_fields[0]}"
            )

        normalized = []
        for display_name, _column_name, field_type in FINANCE_FIELD_DEFINITIONS:
            # 旧版 25 列文件没有该表头。入库时明确补 NULL，而不是把后续“品类”
            # 错位读取为仓租；读取页面据报表标记决定是否展示此列。
            if display_name == OVERSEAS_STORAGE_RENT_FIELD and not has_overseas_storage_rent:
                normalized.append(None)
                continue
            value = row.get(display_name)
            if field_type == "text":
                value = normalize_finance_text(value)
                if display_name == "父ASIN":
                    # ASIN 不区分大小写，入库时统一大写，便于后续跨月份精确查询。
                    value = value.upper()
                normalized.append(value)
            else:
                normalized.append(normalize_finance_number(value, is_ratio=field_type == "ratio"))

        parent_asin = normalized[0]
        if not parent_asin:
            raise HTTPException(status_code=400, detail=f"Excel 第 {index} 行父ASIN为空")
        if parent_asin in seen_parent_asins:
            raise HTTPException(status_code=400, detail=f"父ASIN重复：{parent_asin}")
        seen_parent_asins.add(parent_asin)
        normalized_rows.append(tuple(normalized))

    return normalized_rows


@app.on_event("startup")
def on_startup():
    init_shipment_db()
    init_finance_db()


# ================= Token 工具函数 =================

def create_token(username: str) -> str:
    """使用 HMAC-SHA256 生成带签名的登录 token"""
    payload = {
        "user": username,
        "exp": int(time.time()) + TOKEN_EXPIRE_SECONDS
    }
    # 紧凑 JSON，去掉空格
    payload_json = json.dumps(payload, separators=(",", ":"))
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode()).decode().rstrip("=")
    sig = hmac.new(
        SECRET_KEY.encode(),
        payload_b64.encode(),
        hashlib.sha256
    ).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_token(token: str) -> Optional[str]:
    """验证 token，成功返回用户名，失败返回 None"""
    try:
        if "." not in token:
            return None
        payload_b64, sig = token.split(".", 1)
        expected_sig = hmac.new(
            SECRET_KEY.encode(),
            payload_b64.encode(),
            hashlib.sha256
        ).hexdigest()
        # 时间恒定比较，防止时序攻击
        if not hmac.compare_digest(sig, expected_sig):
            return None
        # 补齐 base64 padding
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        if payload["exp"] < time.time():
            return None  # token 已过期
        return payload["user"]
    except Exception:
        return None


# ================= 认证依赖 =================

def get_current_user(authorization: Optional[str] = Header(default=None)) -> str:
    """从 Authorization Header 中提取并校验用户（用于普通 API）"""
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(status_code=401, detail="未登录，请先登录")
    user = verify_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return user


def verify_token_from_multiple_sources(
    authorization: Optional[str] = Header(default=None),
    _token: Optional[str] = None
) -> str:
    """从 Header 或 URL 查询参数中提取并校验用户（用于图片等无法自定义 Header 的场景）"""
    token = None
    if _token:
        token = _token
    elif authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(status_code=401, detail="未登录，请先登录")
    user = verify_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return user


# ================= 飞书接口封装 =================

def get_feishu_token():
    """向飞书服务器申请 tenant_access_token"""
    url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    headers = {"Content-Type": "application/json; charset=utf-8"}
    payload = {"app_id": APP_ID, "app_secret": APP_SECRET}

    try:
        response = requests.post(url, headers=headers, json=payload)
        data = response.json()
        if response.status_code == 200 and data.get("code") == 0:
            return data.get("tenant_access_token")
        return None
    except Exception as e:
        print(f"获取Token发生异常: {e}")
        return None


def get_bitable_data(access_token, table_id=None, app_token=None):
    """使用通行证去拉取多维表格的数据（支持指定 table_id 和 app_token）"""
    if table_id is None:
        table_id = TABLE_ID
    if app_token is None:
        app_token = APP_TOKEN
    url = f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json; charset=utf-8"
    }

    try:
        response = requests.get(url, headers=headers)
        data = response.json()
        if response.status_code == 200 and data.get("code") == 0:
            return data["data"]["items"]
        return None
    except Exception as e:
        print(f"获取表格数据发生异常: {e}")
        return None


def get_bitable_data_all(access_token, table_id, app_token, page_size=500):
    """拉取多维表格的全部数据（自动翻页，突破单次500条限制）"""
    all_items = []
    page_token = None

    while True:
        url = (
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}"
            f"/tables/{table_id}/records?page_size={page_size}"
        )
        if page_token:
            url += f"&page_token={page_token}"

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=utf-8"
        }

        try:
            response = requests.get(url, headers=headers)
            data = response.json()
            if response.status_code == 200 and data.get("code") == 0:
                items = data["data"].get("items", [])
                all_items.extend(items)
                if data["data"].get("has_more"):
                    page_token = data["data"].get("page_token")
                else:
                    break
            else:
                print(f"分页获取表格数据失败: {data}")
                return None
        except Exception as e:
            print(f"分页获取表格数据发生异常: {e}")
            return None

    return all_items


# ================= API 接口 =================

@app.post("/api/login")
def login(body: dict):
    """用户登录，校验用户名密码并返回 token 及 tags"""
    username = body.get("username", "").strip()
    password = body.get("password", "")

    if not username or not password:
        raise HTTPException(status_code=400, detail="用户名和密码不能为空")

    user_info = USERS.get(username)
    if not user_info or user_info["password"] != password:
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = create_token(username)
    return {
        "status": "success",
        "token": token,
        "user": username,
        "tags": user_info.get("tags", []),
        "expires_in": TOKEN_EXPIRE_SECONDS
    }


@app.get("/api/user/info")
def get_user_info(user: str = Depends(get_current_user)):
    """获取当前登录用户的信息（含 tags）"""
    user_info = USERS.get(user)
    if not user_info:
        raise HTTPException(status_code=401, detail="用户不存在")
    return {
        "status": "success",
        "user": user,
        "tags": user_info.get("tags", [])
    }


@app.get("/api/sales")
def get_sales_data(user: str = Depends(get_current_user)):
    """获取飞书销售表格数据（需登录）"""
    require_permission(user, "sales", "销售")

    token = get_feishu_token()
    if not token:
        raise HTTPException(status_code=500, detail="无法获取飞书 Token")

    records = get_bitable_data(token, table_id=TABLE_ID)
    if records is None:
        raise HTTPException(status_code=500, detail="无法读取表格数据")

    return {"status": "success", "total": len(records), "data": records}


@app.get("/api/inventory")
def get_inventory_data(user: str = Depends(get_current_user)):
    """获取飞书库存表格数据（需登录）"""
    require_permission(user, "inventory", "库存")

    token = get_feishu_token()
    if not token:
        raise HTTPException(status_code=500, detail="无法获取飞书 Token")

    records = get_bitable_data(token, table_id=INVENTORY_TABLE_ID, app_token=INVENTORY_APP_TOKEN)
    if records is None:
        raise HTTPException(status_code=500, detail="无法读取库存表格数据")

    return {"status": "success", "total": len(records), "data": records}


@app.get("/api/inventory_value")
def get_inventory_value_data(user: str = Depends(get_current_user)):
    """获取飞书库存金额表格数据（需登录，且用户必须具备 value 权限）"""
    require_value_permission(user)

    if not INVENTORY_VALUE_APP_TOKEN or not INVENTORY_VALUE_TABLE_ID:
        raise HTTPException(status_code=500, detail="库存金额表格配置缺失")

    token = get_feishu_token()
    if not token:
        raise HTTPException(status_code=500, detail="无法获取飞书 Token")

    # 库存金额表可能随 SKU 扩容超过 500 行，使用分页读取避免飞书单次返回上限截断数据。
    records = get_bitable_data_all(
        token,
        table_id=INVENTORY_VALUE_TABLE_ID,
        app_token=INVENTORY_VALUE_APP_TOKEN
    )
    if records is None:
        raise HTTPException(status_code=500, detail="无法读取库存金额表格数据")

    return {"status": "success", "total": len(records), "data": records}


@app.get("/api/history")
def get_history_data(user: str = Depends(get_current_user)):
    """获取飞书历史销量表格数据（需登录，自动翻页突破500条限制）"""
    require_any_permission(user, ["history", "replenishment"], "历史销量")

    token = get_feishu_token()
    if not token:
        raise HTTPException(status_code=500, detail="无法获取飞书 Token")

    records = get_bitable_data_all(token, table_id=HISTORY_TABLE_ID, app_token=HISTORY_APP_TOKEN)
    if records is None:
        raise HTTPException(status_code=500, detail="无法读取历史销量表格数据")

    return {"status": "success", "total": len(records), "data": records}


@app.post("/api/finance_profit/import")
def import_finance_profit(body: dict, user: str = Depends(get_current_user)):
    """校验并按月份原子保存单款财务利润表。"""
    # 按钮隐藏只是交互提示，真正的防篡改边界必须放在服务器保存接口。
    require_finance_upload_permission(user)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")

    headers = body.get("headers")
    has_overseas_storage_rent = headers == list(FINANCE_FIELDS)
    if not has_overseas_storage_rent and headers != list(FINANCE_LEGACY_FIELDS):
        raise HTTPException(status_code=400, detail="Excel 表头与单款财务利润模板不一致")

    report_month = validate_finance_month(body.get("reportMonth"))
    title = normalize_finance_text(body.get("title"))
    source_filename = normalize_finance_text(body.get("sourceFilename"))
    if not title:
        raise HTTPException(status_code=400, detail="Excel 第一行缺少报表标题")
    if len(title) > 200 or len(source_filename) > 255:
        raise HTTPException(status_code=400, detail="报表标题或文件名过长")

    year_text, month_text = report_month.split("-", 1)
    month_number = int(month_text)
    month_markers = (f"{month_number}月", f"{month_number:02d}月")
    if year_text not in title or not any(marker in title for marker in month_markers):
        raise HTTPException(status_code=400, detail="报表标题中的年月与上传月份不一致")

    normalized_rows = normalize_finance_rows(
        body.get("rows"),
        has_overseas_storage_rent=has_overseas_storage_rent
    )
    replace_existing = body.get("replaceExisting") is True
    uploaded_at = get_now_text()

    db_columns = [item[1] for item in FINANCE_FIELD_DEFINITIONS]
    insert_columns = ["report_id", "row_no"] + db_columns
    placeholders = ",".join("?" for _ in insert_columns)
    insert_sql = (
        f"INSERT INTO finance_report_rows ({','.join(insert_columns)}) "
        f"VALUES ({placeholders})"
    )

    conn = get_finance_db_connection()
    try:
        # 同一月份的报表替换必须是单个事务：旧数据删除、新数据写入任一步失败，
        # 都回滚到原版本，避免用户看到半个月的数据。
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT id FROM finance_reports WHERE report_month = ?",
            (report_month,)
        ).fetchone()

        if existing and not replace_existing:
            raise HTTPException(status_code=409, detail=f"{report_month} 已存在，请确认后覆盖")

        if existing:
            report_id = existing["id"]
            conn.execute(
                """
                UPDATE finance_reports
                SET title = ?, source_filename = ?, row_count = ?, has_overseas_storage_rent = ?,
                    uploaded_at = ?, uploaded_by = ?
                WHERE id = ?
                """,
                (
                    title, source_filename, len(normalized_rows), int(has_overseas_storage_rent),
                    uploaded_at, user, report_id
                )
            )
            conn.execute("DELETE FROM finance_report_rows WHERE report_id = ?", (report_id,))
        else:
            cursor = conn.execute(
                """
                INSERT INTO finance_reports
                    (report_month, title, source_filename, row_count, has_overseas_storage_rent, uploaded_at, uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    report_month, title, source_filename, len(normalized_rows),
                    int(has_overseas_storage_rent), uploaded_at, user
                )
            )
            report_id = cursor.lastrowid

        values = [
            (report_id, row_no, *row_values)
            for row_no, row_values in enumerate(normalized_rows, start=3)
        ]
        conn.executemany(insert_sql, values)
        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except sqlite3.Error as e:
        conn.rollback()
        print(f"保存财务利润表失败: {e}")
        raise HTTPException(status_code=500, detail="保存财务利润表失败")
    finally:
        conn.close()

    return {
        "status": "success",
        "report_month": report_month,
        "row_count": len(normalized_rows),
        "uploaded_at": uploaded_at,
        "uploaded_by": user,
        "has_overseas_storage_rent": has_overseas_storage_rent
    }


@app.get("/api/finance_profit/months")
def get_finance_profit_months(user: str = Depends(get_current_user)):
    """返回已有月份，供当前页面及后续历史筛选共用。"""
    require_finance_permission(user)
    conn = get_finance_db_connection()
    try:
        rows = conn.execute(
            """
            SELECT report_month, title, source_filename, row_count, has_overseas_storage_rent,
                   uploaded_at, uploaded_by
            FROM finance_reports
            ORDER BY report_month DESC
            """
        ).fetchall()
    except sqlite3.Error as e:
        print(f"读取财务报表月份失败: {e}")
        raise HTTPException(status_code=500, detail="读取财务报表月份失败")
    finally:
        conn.close()

    return {"status": "success", "data": [dict(row) for row in rows]}


@app.get("/api/finance_profit/history")
def get_finance_profit_history(parent_asin: str, user: str = Depends(get_current_user)):
    """
    按父 ASIN 返回连续月份的历史财务记录。

    历史查询的时间轴不能只由“命中该 ASIN 的月份”决定：否则某个月未上传报表、
    或报表中没有该 ASIN 时，前端会把该月误认为不存在。这里先从全部已归档报表
    取得最早和最晚月份，再补齐其中每一个自然月；未命中时由 has_data=False 明确
    告知前端显示“无数据”。
    """
    require_finance_permission(user)
    normalized_parent_asin = normalize_finance_text(parent_asin).upper()
    if not normalized_parent_asin:
        raise HTTPException(status_code=400, detail="父ASIN不能为空")

    conn = get_finance_db_connection()
    try:
        range_row = conn.execute(
            "SELECT MIN(report_month) AS start_month, MAX(report_month) AS end_month FROM finance_reports"
        ).fetchone()
        report_feature_rows = conn.execute(
            "SELECT report_month, has_overseas_storage_rent FROM finance_reports"
        ).fetchall()
        start_month = range_row["start_month"] if range_row else None
        end_month = range_row["end_month"] if range_row else None
        if not start_month or not end_month:
            return {
                "status": "empty",
                "parent_asin": normalized_parent_asin,
                "start_month": None,
                "end_month": None,
                "total": 0,
                "matched_total": 0,
                "data": []
            }

        # 字段清单来自固定导入契约，而不是请求参数；既避免列名注入，也确保结果
        # 与当前月查询返回的 25 个展示字段完全一致。
        detail_columns = ", ".join(
            "rows.{0} AS {0}".format(column_name)
            for _display_name, column_name, _field_type in FINANCE_FIELD_DEFINITIONS
        )
        matched_rows = conn.execute(
            """
            SELECT reports.report_month, rows.row_no AS matched_row_no, {detail_columns}
            FROM finance_reports AS reports
            LEFT JOIN finance_report_rows AS rows
                ON rows.report_id = reports.id
                AND rows.parent_asin = ?
            ORDER BY reports.report_month DESC
            """.format(detail_columns=detail_columns),
            (normalized_parent_asin,)
        ).fetchall()
    except sqlite3.Error as e:
        print(f"读取财务利润历史记录失败: {e}")
        raise HTTPException(status_code=500, detail="读取财务利润历史记录失败")
    finally:
        conn.close()

    row_by_month = {
        row["report_month"]: row
        for row in matched_rows
        if row["matched_row_no"] is not None
    }
    report_has_overseas_storage_rent = {
        row["report_month"]: bool(row["has_overseas_storage_rent"])
        for row in report_feature_rows
    }

    start_year, start_month_number = (int(part) for part in start_month.split("-"))
    end_year, end_month_number = (int(part) for part in end_month.split("-"))
    history_data = []
    year, month_number = start_year, start_month_number
    while (year, month_number) <= (end_year, end_month_number):
        report_month = f"{year:04d}-{month_number:02d}"
        matched_row = row_by_month.get(report_month)
        item = {
            "report_month": report_month,
            "has_data": matched_row is not None,
            "has_overseas_storage_rent": report_has_overseas_storage_rent.get(report_month, False)
        }
        if matched_row is not None:
            item.update({
                display_name: matched_row[column_name]
                for display_name, column_name, _field_type in FINANCE_FIELD_DEFINITIONS
            })
        history_data.append(item)

        if month_number == 12:
            year += 1
            month_number = 1
        else:
            month_number += 1

    # 用户需要最近月份优先阅读；月份范围仍按自然月补齐，而不是只返回有记录的月份。
    history_data.reverse()
    return {
        "status": "success",
        "parent_asin": normalized_parent_asin,
        "start_month": start_month,
        "end_month": end_month,
        "total": len(history_data),
        "matched_total": sum(1 for item in history_data if item["has_data"]),
        "data": history_data
    }


@app.get("/api/finance_profit")
def get_finance_profit(month: Optional[str] = None, user: str = Depends(get_current_user)):
    """读取指定月份；未指定月份时读取数据库中的最新报表。"""
    require_finance_permission(user)
    report_month = validate_finance_month(month) if month else None

    conn = get_finance_db_connection()
    try:
        if report_month:
            report = conn.execute(
                "SELECT * FROM finance_reports WHERE report_month = ?",
                (report_month,)
            ).fetchone()
        else:
            report = conn.execute(
                "SELECT * FROM finance_reports ORDER BY report_month DESC LIMIT 1"
            ).fetchone()

        if not report:
            return {"status": "empty", "report": None, "data": []}

        db_rows = conn.execute(
            "SELECT * FROM finance_report_rows WHERE report_id = ? ORDER BY row_no ASC",
            (report["id"],)
        ).fetchall()
    except sqlite3.Error as e:
        print(f"读取财务利润表失败: {e}")
        raise HTTPException(status_code=500, detail="读取财务利润表失败")
    finally:
        conn.close()

    data = []
    for db_row in db_rows:
        item = {
            display_name: db_row[column_name]
            for display_name, column_name, _field_type in FINANCE_FIELD_DEFINITIONS
        }
        item["_row_no"] = db_row["row_no"]
        data.append(item)

    report_data = {
        "report_month": report["report_month"],
        "title": report["title"],
        "source_filename": report["source_filename"],
        "row_count": report["row_count"],
        "has_overseas_storage_rent": bool(report["has_overseas_storage_rent"]),
        "uploaded_at": report["uploaded_at"],
        "uploaded_by": report["uploaded_by"]
    }
    return {
        "status": "success",
        "report": report_data,
        "total": len(data),
        "data": data
    }


@app.post("/api/shipment/current")
def save_shipment_current(body: dict, user: str = Depends(get_current_user)):
    """保存发货审核当前状态。覆盖式保存，不做历史版本。"""
    require_replenishment_permission(user)

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")

    # 前端可以传 supplierRows / overseasRows / summary，也可以传完整页面状态。
    # 后端不参与业务计算，只负责保存当前状态。
    saved_at = get_now_text()
    body["updatedAt"] = saved_at
    body["updatedBy"] = user

    data_json = json.dumps(body, ensure_ascii=False, separators=(",", ":"))

    conn = sqlite3.connect(SHIPMENT_DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO shipment_current (id, data_json, updated_at, updated_by)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                data_json = excluded.data_json,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
            """,
            (data_json, saved_at, user)
        )
        conn.commit()
    except Exception as e:
        print(f"保存发货审核状态失败: {e}")
        raise HTTPException(status_code=500, detail="保存发货审核状态失败")
    finally:
        conn.close()

    return {
        "status": "success",
        "updated_at": saved_at,
        "updated_by": user
    }


@app.get("/api/shipment/current")
def get_shipment_current(user: str = Depends(get_current_user)):
    """读取发货审核当前状态。没有保存记录时返回空状态。"""
    require_replenishment_permission(user)

    conn = sqlite3.connect(SHIPMENT_DB_PATH)
    try:
        row = conn.execute(
            "SELECT data_json, updated_at, updated_by FROM shipment_current WHERE id = 1"
        ).fetchone()
    except Exception as e:
        print(f"读取发货审核状态失败: {e}")
        raise HTTPException(status_code=500, detail="读取发货审核状态失败")
    finally:
        conn.close()

    if not row:
        return {
            "status": "empty",
            "data": None
        }

    try:
        data = json.loads(row[0])
    except Exception:
        data = None

    return {
        "status": "success",
        "data": data,
        "updated_at": row[1],
        "updated_by": row[2]
    }

def validate_image_url(url: str) -> str:
    """限制图片代理只能访问飞书 / Lark 相关 HTTPS 地址，避免任意 URL 代理风险。"""
    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=400, detail="图片地址格式不合法")

    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail="只允许 HTTPS 图片地址")

    hostname = (parsed.hostname or "").lower()

    if not hostname:
        raise HTTPException(status_code=400, detail="图片地址缺少域名")

    allowed = any(
        hostname == suffix.lstrip(".") or hostname.endswith(suffix)
        for suffix in ALLOWED_IMAGE_HOST_SUFFIXES
    )

    if not allowed:
        raise HTTPException(status_code=403, detail="不允许代理该图片域名")

    return url


@app.get("/api/image")
def get_feishu_image(
    url: str,
    _token: Optional[str] = None,
    authorization: Optional[str] = Header(default=None)
):
    """
    飞书产品图代理接口（需登录）。

    同一张图的并发请求会合并为一次飞书下载；成功图片短暂缓存，
    以避免表格渲染时的突发请求触发飞书附件下载限流。
    """
    # img 标签不能设置 Authorization Header，因此保留 URL token 兼容现有前端。
    # 认证仍发生在缓存命中前，避免未登录请求读取任何已缓存的业务图片。
    token = _token
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(status_code=401, detail="未登录，请先登录")
    user = verify_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

    url = validate_image_url(url)

    cached = get_cached_image(url)
    if cached:
        return make_image_response(*cached)

    cached_failure = get_cached_image_failure(url)
    if cached_failure:
        status_code, detail = cached_failure
        headers = {"Retry-After": str(IMAGE_FAILURE_TTL_SECONDS)} if status_code == 429 else None
        raise HTTPException(status_code=status_code, detail=detail, headers=headers)

    is_downloader, event = claim_image_fetch(url)
    if not is_downloader:
        # A matching request is already downloading this URL. Waiting is preferable to issuing
        # another upstream request because dozens of table cells can refer to the same image.
        if not event.wait(IMAGE_INFLIGHT_WAIT_SECONDS):
            raise HTTPException(status_code=503, detail="图片加载排队超时，请稍后重试")

        cached = get_cached_image(url)
        if cached:
            return make_image_response(*cached)

        cached_failure = get_cached_image_failure(url)
        if cached_failure:
            status_code, detail = cached_failure
            headers = {"Retry-After": str(IMAGE_FAILURE_TTL_SECONDS)} if status_code == 429 else None
            raise HTTPException(status_code=status_code, detail=detail, headers=headers)

        # The downloader always writes either a success or short-lived failure result. This
        # fallback protects callers if an unexpected internal error bypasses that contract.
        raise HTTPException(status_code=502, detail="图片下载未返回有效结果，请稍后重试")

    try:
        feishu_token = get_feishu_token()
        if not feishu_token:
            raise HTTPException(status_code=502, detail="无法获取飞书访问令牌")

        content, content_type = fetch_feishu_image(
            url,
            {"Authorization": f"Bearer {feishu_token}"},
        )
        cache_image(url, content, content_type)
        return make_image_response(content, content_type)
    except HTTPException as exc:
        cache_image_failure(url, exc.status_code, exc.detail)
        raise
    except Exception as exc:
        # Do not return internal exception text to users: it can contain request details or
        # deployment paths. The type is enough to diagnose unexpected proxy failures in logs.
        print(f"图片代理发生未预期异常: error_type={type(exc).__name__}")
        detail = "图片服务暂时不可用，请稍后重试"
        cache_image_failure(url, 502, detail)
        raise HTTPException(status_code=502, detail=detail)
    finally:
        finish_image_fetch(url, event)


if __name__ == "__main__":
    print("中转服务器正在启动...")
    uvicorn.run(app, host="127.0.0.1", port=5000)
