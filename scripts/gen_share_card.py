# -*- coding: utf-8 -*-
"""生成「需恋」分享卡片：内嵌二维码 SVG，黑白极简风格。"""
import io
import pathlib

import qrcode
import qrcode.image.svg

URL = "https://shusan0817.github.io/xulian/"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "docs"
OUT_DIR.mkdir(exist_ok=True)

# ---- 1. 生成二维码 SVG（只要内部 path，不要自带 XML 头） ----
factory = qrcode.image.svg.SvgPathImage
BORDER = 2
qr = qrcode.QRCode(border=BORDER)
qr.add_data(URL)
qr.make(fit=True)
img = qr.make_image(image_factory=factory)
# SvgPathImage 每个 module 输出 1 个单位（box_size 不生效），
# 实际范围 0..(modules + 2*border)，viewBox 必须用这个值，否则二维码会缩在角落。
side = qr.modules_count + 2 * BORDER
buf = io.BytesIO()
img.save(buf)
svg_raw = buf.getvalue().decode("utf-8")

# 抽出 <path .../>，去掉外层 svg 与背景 rect
start = svg_raw.find("<path")
end = svg_raw.rfind("</svg>")
path_only = svg_raw[start:end].strip()
# 移除 qrcode 自带的白底 rect（若存在）
if "<rect" in path_only:
    path_only = path_only[path_only.rfind(">") + 1:].strip()

qr_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}"
     width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="需恋 网址二维码">
  {path_only}
</svg>'''

(OUT_DIR / "share-qr.svg").write_text(qr_svg, encoding="utf-8")

# ---- 2. 生成分享卡片 HTML ----
html = f'''<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>需恋 · 分享卡片</title>
<style>
  :root {{ --ink:#0a0a0a; --paper:#ffffff; --sub:#6b6b6b; --line:#e6e6e6; }}
  * {{ box-sizing:border-box; margin:0; padding:0; }}
  body {{
    background:#f4f4f4; color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Microsoft JhengHei",sans-serif;
    display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px;
  }}
  .card {{
    background:var(--paper); width:100%; max-width:420px;
    border:1px solid var(--line); border-radius:2px; padding:48px 40px 40px;
    box-shadow:0 1px 3px rgba(0,0,0,.04), 0 12px 40px rgba(0,0,0,.06);
  }}
  .brand {{ font-size:11px; letter-spacing:.42em; color:var(--sub); text-transform:uppercase; }}
  h1 {{ font-size:34px; font-weight:300; letter-spacing:.16em; margin:14px 0 6px; }}
  .tagline {{ font-size:13px; color:var(--sub); line-height:1.7; }}
  .qr {{ margin:36px auto 26px; width:216px; height:216px; padding:14px; border:1px solid var(--line); }}
  .url {{
    font-size:13px; letter-spacing:.02em; word-break:break-all; text-align:center;
    padding:12px 10px; background:#fafafa; border:1px solid var(--line);
    user-select:all; cursor:pointer;
  }}
  .url:hover {{ background:#f0f0f0; }}
  .hint {{ margin-top:14px; font-size:11px; color:var(--sub); text-align:center; letter-spacing:.04em; }}
  .notes {{ margin-top:34px; padding-top:22px; border-top:1px solid var(--line); }}
  .notes h2 {{ font-size:11px; letter-spacing:.3em; color:var(--sub); font-weight:400; margin-bottom:14px; }}
  .notes li {{ list-style:none; font-size:12.5px; color:#333; line-height:1.9; padding-left:16px; position:relative; }}
  .notes li::before {{ content:"—"; position:absolute; left:0; color:#bbb; }}
  .footer {{ margin-top:26px; font-size:10.5px; color:#a0a0a0; text-align:center; letter-spacing:.06em; }}
  @media (max-width:480px) {{ .card {{ padding:36px 24px 30px; }} .qr {{ width:190px; height:190px; }} }}
</style>
</head>
<body>
  <div class="card">
    <div class="brand">XuLian · AI Companion</div>
    <h1>需戀</h1>
    <p class="tagline">一個會記得你、懂你的<br/>AI 陪伴空間。</p>

    <div class="qr">{qr_svg}</div>

    <div class="url" id="url" title="點擊複製">{URL}</div>
    <div class="hint">手機掃描 QR Code，或點擊上方網址複製</div>

    <div class="notes">
      <h2>給朋友的提醒</h2>
      <ul>
        <li>首次開啟可能要等 30～40 秒（伺服器休眠喚醒）</li>
        <li>需要註冊帳號才能使用（電子郵件 + 密碼）</li>
        <li>目前為測試版，資料尚未保證永久保存</li>
      </ul>
    </div>

    <div class="footer">需戀 · Beta</div>
  </div>

<script>
  document.getElementById('url').addEventListener('click', function () {{
    var t = '{URL}';
    if (navigator.clipboard) navigator.clipboard.writeText(t);
    var el = this, old = el.textContent;
    el.textContent = '已複製 ✓';
    setTimeout(function () {{ el.textContent = old; }}, 1200);
  }});
</script>
</body>
</html>
'''

(OUT_DIR / "share-card.html").write_text(html, encoding="utf-8")
print("OK: docs/share-qr.svg")
print("OK: docs/share-card.html")
print("URL:", URL)
