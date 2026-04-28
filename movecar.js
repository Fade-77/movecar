/**
 * MoveCar 多用户智能挪车系统 - v2.1 (优化版)
 * 优化：30分钟断点续传 + 域名优先级二维码 + 多用户隔离 + 区分大小写字母与数字混合ID
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = {
  KV_TTL: 3600,         // 坐标等数据有效期：1 小时
  SESSION_TTL: 1800,    // 挪车会话有效期：30 分钟 (1800秒)
  RATE_LIMIT_TTL: 60    // 频率限制：60 秒
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname
  const userParam = url.searchParams.get('u') || 'default';
  
  // 移除 .toLowerCase()，完全保留传入的字母大小写和数字
  const userKey = userParam; 

  // 1. 二维码生成工具
  if (path === '/qr') return renderQRPage(url.origin, userKey);

  // 2. API 路由
  if (path === '/api/notify' && request.method === 'POST') return handleNotify(request, url, userKey);
  if (path === '/api/get-location') return handleGetLocation(userKey);
  if (path === '/api/owner-confirm' && request.method === 'POST') return handleOwnerConfirmAction(request, userKey);
  
  // 查询状态 API (带 Session 校验)
  if (path === '/api/check-status') {
    const s = url.searchParams.get('s');
    return handleCheckStatus(userKey, s);
  }

  // 3. 页面路由
  if (path === '/owner-confirm') return renderOwnerPage(userKey);

  // 默认进入挪车首页
  return renderMainPage(url.origin, userKey);
}

/** 配置读取 **/
function getUserConfig(userKey, envPrefix) {
  // 移除 .toUpperCase()，实现精准匹配大小写
  const specificKey = envPrefix + "_" + userKey;
  if (typeof globalThis[specificKey] !== 'undefined') return globalThis[specificKey];
  if (typeof globalThis[envPrefix] !== 'undefined') return globalThis[envPrefix];
  return null;
}

// 坐标转换 (WGS-84 -> GCJ-02)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0; const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}
function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: "https://uri.amap.com/marker?position=" + gcj.lng + "," + gcj.lat + "&name=扫码者位置",
    appleUrl: "https://maps.apple.com/?ll=" + gcj.lat + "," + gcj.lng + "&q=扫码者位置"
  };
}

/** 发送通知逻辑 **/
async function handleNotify(request, url, userKey) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') throw new Error('KV 未绑定');
    const lockKey = "lock_" + userKey;
    const isLocked = await MOVE_CAR_STATUS.get(lockKey);
    if (isLocked) throw new Error('发送频率过快，请一分钟后再试');

    const body = await request.json();
    const sessionId = body.sessionId; 

    const ppToken = getUserConfig(userKey, 'PUSHPLUS_TOKEN');
    const barkUrl = getUserConfig(userKey, 'BARK_URL');
    const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
    const baseDomain = (typeof globalThis.EXTERNAL_URL !== 'undefined' && globalThis.EXTERNAL_URL) ? globalThis.EXTERNAL_URL.replace(/\/$/, "") : url.origin;
    const confirmUrl = baseDomain + "/owner-confirm?u=" + userKey;

    // 获取当前时间并转为北京时间 (UTC+8) 用于防屏蔽时间戳，只取 时:分
    const date = new Date();
    const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const hh = String(utc8Date.getUTCHours()).padStart(2, '0');
    const mm = String(utc8Date.getUTCMinutes()).padStart(2, '0');
    const timeStr = `${hh}:${mm}`;

    // 车牌号后加入时间戳
    let notifyText = "🚗 挪车请求【" + carTitle + "】" + timeStr + "\n💬 留言: " + (body.message || '车旁有人等待');
    
    // 存储当前会话信息，有效期设为 30 分钟
    const statusData = { status: 'waiting', sessionId: sessionId };
    
    if (body.location && body.location.lat) {
      const maps = generateMapUrls(body.location.lat, body.location.lng);
      await MOVE_CAR_STATUS.put("loc_" + userKey, JSON.stringify({ ...body.location, ...maps }), { expirationTtl: CONFIG.KV_TTL });
    }

    await MOVE_CAR_STATUS.put("status_" + userKey, JSON.stringify(statusData), { expirationTtl: CONFIG.SESSION_TTL });
    await MOVE_CAR_STATUS.put(lockKey, '1', { expirationTtl: CONFIG.RATE_LIMIT_TTL });

    const tasks = [];
    // 标题简化为仅"挪车请求"
    if (ppToken) tasks.push(fetch('http://www.pushplus.plus/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ppToken, title: "挪车请求", content: notifyText.replace(/\n/g, '<br>') + '<br><br><a href="' + confirmUrl + '" style="font-size:18px;color:#0093E9">【点击处理】</a>', template: 'html' }) }));
    if (barkUrl) tasks.push(fetch(barkUrl + "/" + encodeURIComponent('挪车请求') + "/" + encodeURIComponent(notifyText) + "?url=" + encodeURIComponent(confirmUrl)));

    await Promise.all(tasks);
    return new Response(JSON.stringify({ success: true }));
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleCheckStatus(userKey, clientSessionId) {
  const data = await MOVE_CAR_STATUS.get("status_" + userKey);
  if (!data) return new Response(JSON.stringify({ status: 'none' }));

  const statusObj = JSON.parse(data);
  if (statusObj.sessionId !== clientSessionId) {
    return new Response(JSON.stringify({ status: 'none' }));
  }

  const ownerLoc = await MOVE_CAR_STATUS.get("owner_loc_" + userKey);
  return new Response(JSON.stringify({ 
    status: statusObj.status, 
    ownerLocation: ownerLoc ? JSON.parse(ownerLoc) : null 
  }));
}

async function handleGetLocation(userKey) {
  const data = await MOVE_CAR_STATUS.get("loc_" + userKey);
  return new Response(data || '{}');
}

async function handleOwnerConfirmAction(request, userKey) {
  const body = await request.json();
  const data = await MOVE_CAR_STATUS.get("status_" + userKey);
  if (data) {
    const statusObj = JSON.parse(data);
    statusObj.status = 'confirmed';
    if (body.location) {
      const urls = generateMapUrls(body.location.lat, body.location.lng);
      await MOVE_CAR_STATUS.put("owner_loc_" + userKey, JSON.stringify({ ...body.location, ...urls }), { expirationTtl: 600 });
    }
    // 确认后状态继续保持，直到 SESSION_TTL 到期
    await MOVE_CAR_STATUS.put("status_" + userKey, JSON.stringify(statusObj), { expirationTtl: 600 });
  }
  return new Response(JSON.stringify({ success: true }));
}

/** 功能：二维码生成工具页 **/
function renderQRPage(origin, userKey) {
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  let baseDomain = (typeof globalThis.EXTERNAL_URL !== 'undefined' && globalThis.EXTERNAL_URL) ? globalThis.EXTERNAL_URL.replace(/\/$/, "") : origin;
  const targetUrl = baseDomain + "/?u=" + userKey;
  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>制作挪车码</title>
  <style>
    body { font-family: sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .qr-card { background: white; padding: 40px 20px; border-radius: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.05); text-align: center; width: 90%; max-width: 380px; }
    .qr-img { width: 250px; height: 250px; margin: 25px auto; border: 1px solid #f1f5f9; padding: 8px; border-radius: 12px; }
    .btn { display: block; background: #0093E9; color: white; text-decoration: none; padding: 16px; border-radius: 16px; font-weight: bold; margin-top: 20px; }
    .url-info { font-size: 11px; color: #cbd5e1; margin-top: 15px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="qr-card">
    <h2 style="color:#1e293b">${carTitle} 的专属挪车码</h2>
    <p style="color:#64748b; font-size:14px; margin-top:8px">扫码通知，保护隐私</p>
    <img class="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=450x450&data=${encodeURIComponent(targetUrl)}">
    <a href="javascript:window.print()" class="btn">🖨️ 立即打印挪车牌</a>
    <div class="url-info">${targetUrl}</div>
  </div>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/** 界面渲染：扫码者页 **/
function renderMainPage(origin, userKey) {
  const phone = getUserConfig(userKey, 'PHONE_NUMBER') || '';
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  const phoneHtml = phone ? '<a href="tel:' + phone + '" class="btn-phone">📞 紧急拨打车主电话</a>' : '';

  return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
  <title>挪车通知</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    /* 底层背景保留原版浅蓝渐变 */
    body { font-family: -apple-system, sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; display: flex; justify-content: center; align-items: center; }
    .container { width: 100%; max-width: 420px; }
    
    /* 核心卡片设计 - 融合 new_monitor 风格 */
    .dark-card { background: #101825; border-radius: 16px; padding: 25px 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); border: 1px solid #2b3a4f; color: #fff; }
    
    /* 头部区域 */
    .header { text-align: center; border-bottom: 1px solid #2b3a4f; padding-bottom: 20px; margin-bottom: 20px; }
    .icon-wrap { width: 64px; height: 64px; background: rgba(0, 147, 233, 0.2); border: 1px solid #0093E9; border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px; font-size: 32px; }
    .title { color: #ffd700; font-size: 22px; font-weight: bold; letter-spacing: 1px; }
    .subtitle { color: #9aa5b6; font-size: 13px; margin-top: 6px; }

    /* 输入框 */
    textarea { width: 100%; min-height: 85px; background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 14px; font-size: 15px; color: #fff; outline: none; margin-bottom: 15px; resize: none; transition: border 0.3s; }
    textarea:focus { border-color: #00bfff; }
    textarea::placeholder { color: #475569; }
    
    /* 标签区域：利用 flex 强制同行并平分宽度 */
    .tags-wrap { display: flex; gap: 8px; margin-bottom: 20px; }
    .tag { flex: 1; text-align: center; background: #1e293b; border: 1px solid #334155; padding: 10px 0; border-radius: 8px; font-size: 13px; color: #cbd5e1; cursor: pointer; white-space: nowrap; transition: 0.2s; }
    .tag:active { background: #334155; color: #fff; border-color: #475569; }

    /* 定位状态 */
    .loc-status { text-align: center; font-size: 13px; color: #9aa5b6; margin-bottom: 15px; border-top: 1px solid #2b3a4f; padding-top: 15px; }

    /* 按钮样式 */
    .btn-main { background: #0093E9; color: white; border: none; padding: 16px; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; transition: 0.2s; }
    .btn-main:active { opacity: 0.8; }
    .btn-main:disabled { background: #334155; color: #9aa5b6; cursor: not-allowed; }
    
    .btn-phone { background: rgba(239, 68, 68, 0.1); color: #ff4d4d; border: 1px solid rgba(239, 68, 68, 0.3); padding: 16px; border-radius: 12px; text-decoration: none; text-align: center; font-weight: bold; display: block; margin-top: 12px; }
    
    .hidden { display: none !important; }
    
    /* 成功界面 */
    .success-icon { font-size: 64px; margin-bottom: 15px; }
    .feedback-box { border: 1px solid #00e676; background: rgba(0, 230, 118, 0.1); border-radius: 12px; padding: 20px; margin-top: 20px; }
    .map-links { display: flex; gap: 10px; margin-top: 15px; }
    .map-btn { flex: 1; padding: 12px; border-radius: 10px; text-align: center; text-decoration: none; color: white; font-size: 14px; font-weight: bold; }
    .amap { background: #1890ff; } .apple { background: #222; border: 1px solid #444; }
  </style>
</head>
<body>
  <div class="container" id="mainView">
    <div class="dark-card">
      <div class="header">
        <div class="icon-wrap">🚗</div>
        <div class="title">呼叫 ${carTitle}</div>
        <div class="subtitle">提示：车主将收到即时提醒</div>
      </div>
      
      <textarea id="msgInput" placeholder="请输入留言..."></textarea>
      
      <div class="tags-wrap">
        <div class="tag" onclick="setTag('麻烦挪下车，谢谢')">🚧 挡路了</div>
        <div class="tag" onclick="setTag('临时停靠，请包涵')">⏱️ 临停</div>
        <div class="tag" onclick="setTag('有急事外出，速来')">🏃 急事</div>
      </div>
      
      <div class="loc-status" id="locStatus">定位请求中...</div>
      
      <button id="notifyBtn" class="btn-main" onclick="sendNotify()">🔔 发送通知</button>
    </div>
  </div>

  <div class="container hidden" id="successView">
    <div class="dark-card" style="text-align:center">
      <div class="success-icon">📧</div>
      <div class="title" style="color:#00bfff;">通知已送达</div>
      <div class="subtitle" style="margin-bottom:5px;">车主已收到挪车请求，请在车旁稍候</div>
      
      <div id="ownerFeedback" class="feedback-box hidden">
        <div style="font-size:40px; margin-bottom:10px">👨‍✈️</div>
        <div style="color:#00e676; font-size:18px; font-weight:bold;">车主回复：马上到</div>
        <div class="map-links">
          <a id="ownerAmap" href="#" class="map-btn amap">高德地图</a>
          <a id="ownerApple" href="#" class="map-btn apple">苹果地图</a>
        </div>
      </div>
      
      <button class="btn-main" style="background:#334155; margin-top:20px;" onclick="location.reload()">🔄 刷新状态</button>
      ${phoneHtml}
    </div>
  </div>

  <script>
    let userLoc = null;
    const userKey = "${userKey}";
    
    // 会话持久化
    let sessionId = localStorage.getItem('movecar_session_' + userKey);
    if (!sessionId) {
      sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('movecar_session_' + userKey, sessionId);
    }

    window.onload = async () => {
      checkActiveSession();
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => {
          userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
          document.getElementById('locStatus').innerText = '📍 位置已锁定';
          document.getElementById('locStatus').style.color = '#00e676'; // 改为新主题的翠绿色
        }, () => {
          document.getElementById('locStatus').innerText = '📍 无法获取精确位置';
        });
      }
    };

    async function checkActiveSession() {
      try {
        const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId);
        const data = await res.json();
        if (data.status && data.status !== 'none') {
          showSuccess(data);
          pollStatus();
        }
      } catch(e){}
    }

    function setTag(t) { document.getElementById('msgInput').value = t; }

    async function sendNotify() {
      const btn = document.getElementById('notifyBtn');
      btn.disabled = true; btn.innerText = '正在联络车主...';
      try {
        const res = await fetch('/api/notify?u=' + userKey, {
          method: 'POST',
          body: JSON.stringify({ 
            message: document.getElementById('msgInput').value, 
            location: userLoc,
            sessionId: sessionId 
          })
        });
        const data = await res.json();
        if (data.success) {
          showSuccess({status: 'waiting'});
          pollStatus();
        } else { alert(data.error); btn.disabled = false; btn.innerText = '🔔 发送通知'; }
      } catch(e) { alert('服务暂时不可用'); btn.disabled = false; }
    }

    function showSuccess(data) {
      document.getElementById('mainView').classList.add('hidden');
      document.getElementById('successView').classList.remove('hidden');
      updateUI(data);
    }

    function updateUI(data) {
      if (data.status === 'confirmed') {
        document.getElementById('ownerFeedback').classList.remove('hidden');
        if (data.ownerLocation) {
          document.getElementById('ownerAmap').href = data.ownerLocation.amapUrl;
          document.getElementById('ownerApple').href = data.ownerLocation.appleUrl;
        }
      }
    }

    function pollStatus() {
      setInterval(async () => {
        try {
          const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId);
          const data = await res.json();
          updateUI(data);
        } catch(e){}
      }, 5000);
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/** 界面渲染：车主页 **/
function renderOwnerPage(userKey) {
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>挪车处理</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    /* 保留原版的紫色背景 */
    body { font-family: -apple-system, sans-serif; background: #4f46e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    
    /* 采用深色卡片主题 */
    .dark-card { background: #101825; padding: 35px 25px; border-radius: 16px; text-align: center; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.3); border: 1px solid #2b3a4f; color: #fff; }
    
    .icon { font-size: 54px; margin-bottom: 10px; }
    .title { color: #ffd700; font-size: 24px; font-weight: bold; margin-bottom: 10px; }
    .subtitle { color: #9aa5b6; font-size: 15px; margin-bottom: 20px; }
    
    /* 地图框的暗色处理 */
    .map-box { display: none; background: #0f172a; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #334155; }
    .map-title { font-size: 14px; color: #00bfff; margin-bottom: 15px; font-weight: bold; }
    .map-links { display: flex; gap: 10px; }
    .map-btn { flex: 1; padding: 12px; background: #1890ff; color: white; text-decoration: none; border-radius: 10px; font-size: 14px; font-weight: bold; }
    
    .btn-confirm { background: #00e676; color: #000; border: none; width: 100%; padding: 18px; border-radius: 12px; font-size: 18px; font-weight: bold; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 15px rgba(0, 230, 118, 0.15); }
    .btn-confirm:disabled { background: #334155; color: #9aa5b6; box-shadow: none; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="dark-card">
    <div class="icon">📣</div>
    <div class="title">${carTitle}</div>
    <div class="subtitle">有人正在车旁等您，请确认：</div>
    
    <div id="mapArea" class="map-box">
      <div class="map-title">对方实时位置 📍</div>
      <div class="map-links">
        <a id="amapLink" href="#" class="map-btn">高德地图</a>
        <a id="appleLink" href="#" class="map-btn" style="background:#222; border: 1px solid #444;">苹果地图</a>
      </div>
    </div>
    
    <button id="confirmBtn" class="btn-confirm" onclick="confirmMove()">🚀 我已知晓，马上过去</button>
  </div>
  <script>
    const userKey = "${userKey}";
    window.onload = async () => {
      const res = await fetch('/api/get-location?u=' + userKey);
      const data = await res.json();
      if(data.amapUrl) {
        document.getElementById('mapArea').style.display = 'block';
        document.getElementById('amapLink').href = data.amapUrl;
        document.getElementById('appleLink').href = data.appleUrl;
      }
    };
    async function confirmMove() {
      const btn = document.getElementById('confirmBtn');
      btn.innerText = '已告知对方 ✓'; 
      btn.disabled = true; 
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async p => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: {lat: p.coords.latitude, lng: p.coords.longitude} }) });
        }, async () => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: null }) });
        });
      }
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
