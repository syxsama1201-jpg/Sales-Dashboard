import requests
import hmac
import hashlib
import base64
import time
import json
import os
import sqlite3
import sys
from urllib.parse import urlparse
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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

# ================= 登录认证配置 =================
# token 签名密钥（请自行修改为随机字符串）
SECRET_KEY = config["SECRET_KEY"]
# token 有效期（秒），默认 24 小时
TOKEN_EXPIRE_SECONDS = 2592000
# 用户列表：用户名 -> {password, tags}
# tags 可选值: sales, inventory, value, replenishment, history
USERS = config["USERS"]

# =============图片请求url限制==================

ALLOWED_IMAGE_HOST_SUFFIXES = (
    ".feishu.cn",
    ".larksuite.com",
)

# ==========================================

app = FastAPI()

# ===== 跨域中间件 =====
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://sales-dashboard.acme-zone.com",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
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


def get_now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@app.on_event("startup")
def on_startup():
    init_shipment_db()


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
    万能图片流式代理接口（需登录）。
    支持两种认证方式：URL 参数 _token 或 Authorization Header。
    """
    # 手动校验（因为 img 标签无法设置 Header，所以额外支持 URL 传 token）
    token = _token
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(status_code=401, detail="未登录，请先登录")
    user = verify_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

    # 新增：限制只能代理飞书 / Lark 图片地址
    url = validate_image_url(url)

    feishu_token = get_feishu_token()
    if not feishu_token:
        raise HTTPException(status_code=500, detail="无法获取飞书 Token")

    headers = {
        "Authorization": f"Bearer {feishu_token}"
    }

    try:
        res = requests.get(url, headers=headers, stream=True,timeout=15)
        if res.status_code == 200:
            return StreamingResponse(
                res.raw,
                media_type=res.headers.get("Content-Type", "image/png")
            )
        else:
            print(f"飞书拒绝返回图片，状态码: {res.status_code}，详情: {res.text}")
            raise HTTPException(status_code=res.status_code, detail="飞书拒绝返回该图片素材")

    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"图片代理中转发生底层错误: {e}")
        raise HTTPException(status_code=500, detail=f"图片代理中转失败: {e}")


if __name__ == "__main__":
    print("中转服务器正在启动...")
    uvicorn.run(app, host="127.0.0.1", port=5000)
