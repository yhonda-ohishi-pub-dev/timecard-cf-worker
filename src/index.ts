// Timecard Cloudflare Worker
// Main entry point for the timecard frontend application

import { WebSocketHibernationDO } from './durable-objects/websocket-hibernation';
import { handleApiRequest } from './api/routes';
import { ICON_192_BASE64, ICON_512_BASE64 } from './icons';
import {
  authMiddleware,
  isPublicPath,
  createLoginRedirect,
  handleGoogleLogin,
  handleGoogleCallback,
  handleLineworksLogin,
  handleLineworksCallback,
  clearSessionCookie,
  createTempToken,
  verifyTempToken,
  createSessionCookie,
  type Env as AuthEnv,
} from './auth';

export { WebSocketHibernationDO };

export interface Env extends AuthEnv {
  __STATIC_CONTENT: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Log client IP for access tracking
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const userAgent = request.headers.get('User-Agent') || '';
    console.log(`[ACCESS] ${new Date().toISOString()} | IP: ${clientIP} | Path: ${path} | UA: ${userAgent.substring(0, 100)}`);

    // CORS headers for API requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // === 認証関連ルート ===
    // ログインページ（バックグラウンドで認証チェック、成功したらリダイレクト）
    if (path === '/login') {
      const url = new URL(request.url);
      const redirect = url.searchParams.get('redirect') || '/';
      return new Response(getLoginPage(redirect), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Google OAuth開始
    if (path === '/login/google') {
      return handleGoogleLogin(request, env);
    }

    // Google OAuthコールバック
    if (path === '/auth/google/callback') {
      return handleGoogleCallback(request, env);
    }

    // LINE WORKS OAuth開始
    if (path === '/login/lineworks') {
      return handleLineworksLogin(request, env);
    }

    // LINE WORKS OAuthコールバック
    if (path === '/auth/lineworks/callback') {
      return handleLineworksCallback(request, env);
    }

    // WOFF SDKログインページ（外部ブラウザ用）
    if (path === '/login/woff') {
      return getWoffLoginPage(request, env);
    }

    // WOFFコールバック（WOFFトークン検証）
    if (path === '/auth/woff/callback') {
      return handleWoffCallback(request, env);
    }

    // WOFFミニアプリランディングページ（外部ブラウザで開くボタン）
    if (path === '/woff') {
      return getWoffLandingPage(request, env);
    }

    // 一時トークンでセッション作成（外部ブラウザ用）
    if (path === '/auth/token') {
      return handleTokenAuth(request, env);
    }

    // ログアウト
    if (path === '/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/login',
          'Set-Cookie': clearSessionCookie(),
        },
      });
    }

    // === 認証チェック（公開パス以外） ===
    if (!isPublicPath(path)) {
      const auth = await authMiddleware(request, env);
      if (!auth.authenticated) {
        return createLoginRedirect(request);
      }
    }

    // WebSocket upgrade for /ws endpoint
    if (path === '/ws') {
      const id = env.WEBSOCKET_HIBERNATION.idFromName('main');
      const stub = env.WEBSOCKET_HIBERNATION.get(id);
      return stub.fetch(new Request(new URL('/websocket', request.url), request));
    }

    // Broadcast endpoint (internal use)
    if (path === '/api/broadcast') {
      const id = env.WEBSOCKET_HIBERNATION.idFromName('main');
      const stub = env.WEBSOCKET_HIBERNATION.get(id);
      return stub.fetch(new Request(new URL('/broadcast', request.url), request));
    }

    // 認証チェックAPI（JSから呼び出し用）
    if (path === '/api/auth/check') {
      const auth = await authMiddleware(request, env);
      return new Response(JSON.stringify({ authenticated: auth.authenticated }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // API routes
    if (path.startsWith('/api/')) {
      const response = await handleApiRequest(request, env);
      // Add CORS headers to API responses
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // Serve static files for frontend pages
    return serveStaticContent(request, env, path);
  },
};

async function serveStaticContent(request: Request, env: Env, path: string): Promise<Response> {
  // Map routes to HTML files
  let filePath = path;

  if (path === '/' || path === '/index.html') {
    filePath = '/ic-log-list.html';
  } else if (path === '/drivers' || path === '/drivers.html') {
    filePath = '/drivers.html';
  } else if (path === '/ic_non_reg' || path === '/ic-non-reg.html') {
    filePath = '/ic-non-reg.html';
  } else if (path === '/delete_ic' || path === '/delete-ic.html') {
    filePath = '/delete-ic.html';
  } else if (path === '/ic_log_list' || path === '/ic-log-list.html') {
    filePath = '/ic-log-list.html';
  } else if (path === '/clients' || path === '/clients.html') {
    filePath = '/clients.html';
  }

  // For development, return inline HTML
  // In production, use __STATIC_CONTENT KV
  const html = getPageContent(filePath);
  if (html) {
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Try serving as static asset
  if (filePath.endsWith('.css')) {
    const css = getStaticAsset(filePath);
    if (css) {
      return new Response(css, {
        headers: { 'Content-Type': 'text/css' },
      });
    }
  }

  if (filePath.endsWith('.js')) {
    const js = getStaticAsset(filePath);
    if (js) {
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript' },
      });
    }
  }

  if (filePath.endsWith('.webmanifest')) {
    const manifest = getStaticAsset(filePath);
    if (manifest) {
      return new Response(manifest, {
        headers: { 'Content-Type': 'application/manifest+json' },
      });
    }
  }

  // PWA icons (PNG from base64)
  if (filePath === '/icon-192.png') {
    const binaryString = atob(ICON_192_BASE64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' },
    });
  }
  if (filePath === '/icon-512.png') {
    const binaryString = atob(ICON_512_BASE64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' },
    });
  }

  return new Response('Not Found', { status: 404 });
}

function getPageContent(path: string): string | null {
  const pages: Record<string, string> = {
    '/drivers.html': getDriversPage(),
    '/ic-non-reg.html': getIcNonRegPage(),
    '/delete-ic.html': getDeleteIcPage(),
    '/ic-log-list.html': getIcLogListPage(),
    '/clients.html': getClientsPage(),
  };
  return pages[path] || null;
}

function getStaticAsset(path: string): string | null {
  const assets: Record<string, string> = {
    '/styles.css': getStyles(),
    '/manifest.webmanifest': getManifest(),
    '/sw.js': getServiceWorker(),
  };
  return assets[path] || null;
}

// Page templates
function getBaseTemplate(title: string, content: string, scripts: string = ''): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0d6efd">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="タイムカード">
  <title>${title} - 大石社タイムカード</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
  <style>
    body { padding: 20px; }
    .nav-links { margin-bottom: 20px; }
    .nav-links a { margin-right: 15px; }
    .loading { display: none; }
    .loading.show { display: block; text-align: center; padding: 20px; }
    .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .ws-status { position: fixed; top: 10px; right: 10px; padding: 5px 10px; border-radius: 5px; font-size: 12px; }
    .ws-connected { background: #28a745; color: white; }
    .ws-disconnected { background: #dc3545; color: white; }
    img.thumbnail { max-width: 200px; max-height: 150px; }
  </style>
</head>
<body>
  <div class="container">
    <nav class="nav-links d-flex justify-content-between align-items-center">
      <div>
        <a href="/" class="btn btn-outline-primary">打刻一覧</a>
        <a href="/drivers" class="btn btn-outline-primary">ドライバー</a>
        <a href="/ic_non_reg" class="btn btn-outline-primary">未登録IC</a>
        <a href="/delete_ic" class="btn btn-outline-primary">IC削除</a>
        <a href="/clients" class="btn btn-outline-info">接続端末</a>
      </div>
      <div class="d-flex align-items-center gap-2">
        <div id="api-version" class="text-muted small" style="font-size: 0.75em;"></div>
        <a href="/logout" class="btn btn-outline-secondary btn-sm">ログアウト</a>
      </div>
    </nav>
    <div id="ws-status" class="ws-status ws-disconnected">切断中</div>
    ${content}
  </div>
  <script>
    // WebSocket connection with reconnection logic
    class TimecardWebSocket {
      constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.listeners = new Map();
        this.connect();
      }

      connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(protocol + '//' + location.host + '/ws');

        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.reconnectAttempts = 0;
          document.getElementById('ws-status').className = 'ws-status ws-connected';
          document.getElementById('ws-status').textContent = '接続中';
          this.emit('open');
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('WebSocket message:', data);
            this.emit('message', data);
            if (data.type === 'hello') {
              this.emit('hello', data.data);
            }
          } catch (e) {
            console.error('Failed to parse message:', e);
          }
        };

        this.ws.onclose = () => {
          console.log('WebSocket disconnected');
          document.getElementById('ws-status').className = 'ws-status ws-disconnected';
          document.getElementById('ws-status').textContent = '切断中';
          this.emit('close');
          this.scheduleReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.emit('error', error);
        };

        // Start ping interval
        this.startPing();
      }

      startPing() {
        setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      }

      scheduleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
          console.log('Reconnecting in ' + delay + 'ms...');
          setTimeout(() => this.connect(), delay);
        }
      }

      on(event, callback) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
      }

      emit(event, data) {
        const callbacks = this.listeners.get(event) || [];
        callbacks.forEach(cb => cb(data));
      }

      send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(data));
        }
      }
    }

    window.tcWs = new TimecardWebSocket();

    // Register Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then((registration) => {
            console.log('Service Worker registered:', registration.scope);
          })
          .catch((error) => {
            console.log('Service Worker registration failed:', error);
          });
      });
    }

    // Load API version info
    async function loadApiVersion() {
      try {
        const response = await fetch('/api/version');
        if (response.ok) {
          const version = await response.json();
          const versionElem = document.getElementById('api-version');
          if (versionElem && version.git_commit) {
            const buildDateTime = version.build_date ? new Date(version.build_date).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
            versionElem.textContent = 'API: ' + version.git_commit.substring(0, 7) + (buildDateTime ? ' (' + buildDateTime + ')' : '');
            versionElem.title = 'Build: ' + version.build_date + '\\nRust: ' + version.rust_version + '\\nCommit: ' + version.git_commit_full;
          }
        }
      } catch (e) {
        console.log('Failed to load API version:', e);
      }
    }
    loadApiVersion();
  </script>
  ${scripts}
</body>
</html>`;
}

function getIndexPage(): string {
  const content = `
    <h1>タイムカード</h1>
    <div class="mb-3">
      <label for="datepick" class="form-label">日付選択:</label>
      <input type="date" id="datepick" class="form-control" style="max-width: 200px;">
    </div>
    <table id="sample" class="table table-bordered">
      <thead>
        <tr>
          <th class="text-center">日時</th>
          <th class="text-center">写真(体温)</th>
          <th class="text-center">写真(ID)</th>
          <th class="text-center">ID/社員名</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <button id="next_btn" class="btn btn-primary">次へ</button>
    <div id="loading" class="loading">
      <div class="spinner"></div>
    </div>
  `;

  const scripts = `
    <script>
      const tableElem = document.getElementById('sample');
      const loadingElem = document.getElementById('loading');
      let lastDate = null;

      async function loadData(startDate) {
        loadingElem.classList.add('show');
        try {
          let url = '/api/pic_tmp?limit=30';
          if (startDate) {
            url += '&start=' + encodeURIComponent(startDate);
          }
          const response = await fetch(url);
          const data = await response.json();
          renderData(data);
        } catch (e) {
          console.error('Failed to load data:', e);
        } finally {
          loadingElem.classList.remove('show');
        }
      }

      function renderData(photoList) {
        photoList.forEach((ele) => {
          const trElem = tableElem.tBodies[0].insertRow(-1);
          const baseId = new Date(ele.date).toISOString().slice(0, -5) + (ele.machine_ip || '');
          trElem.id = baseId;
          trElem.className = 'tr_data';
          trElem.setAttribute('data-date', new Date(ele.date).toISOString().slice(0, -5));
          lastDate = new Date(ele.date).toISOString().slice(0, -5);

          // Date cell
          const dateCell = trElem.insertCell(0);
          dateCell.id = baseId + '_date';
          const dateStr = new Date(ele.date).toISOString().replace(/-/g, '/').replace(/T/g, ' ').slice(2, -5);
          dateCell.textContent = dateStr;
          if (ele.detail === 'tmp inserted by fing') {
            dateCell.innerHTML += '<br>指紋';
          } else if (ele.detail === 'tmp inserted by ic') {
            dateCell.innerHTML += '<br>IC';
          }

          // Temp photo cell
          const tempCell = trElem.insertCell();
          tempCell.id = baseId + '_pic_tmp';
          if (ele.pic_data_1) {
            const img = document.createElement('img');
            img.src = 'data:image/png;base64,' + ele.pic_data_1;
            img.className = 'thumbnail';
            tempCell.appendChild(img);
          }

          // ID photo cell
          const idCell = trElem.insertCell();
          idCell.id = baseId + '_pic_ic';
          if (ele.pic_data_2) {
            const img = document.createElement('img');
            img.src = 'data:image/png;base64,' + ele.pic_data_2;
            img.className = 'thumbnail';
            idCell.appendChild(img);
          }

          // Name cell
          const nameCell = trElem.insertCell();
          nameCell.id = baseId + '_id';
          nameCell.innerHTML = (ele.id || '') + '<br>' + (ele.name || '');
        });
      }

      // Handle real-time updates via WebSocket
      window.tcWs.on('hello', (data) => {
        if (document.getElementById('datepick').value) return;

        if (data.status === 'tmp inserted') {
          const trElem = tableElem.tBodies[0].insertRow(0);
          const baseId = data.data.time.slice(0, -7) + (data.ip || '');
          trElem.id = baseId;
          trElem.className = 'tr_data';

          const dateCell = trElem.insertCell(0);
          dateCell.id = baseId + '_date';
          dateCell.textContent = data.data.time.replace(/-/g, '/').replace(/T/g, ' ').slice(2, -7);

          const tempCell = trElem.insertCell();
          tempCell.id = baseId + '_pic_tmp';
          if (data.data.pic_data_aft) {
            const img = document.createElement('img');
            img.src = 'data:image/png;base64,' + data.data.pic_data_aft;
            img.className = 'thumbnail';
            tempCell.appendChild(img);
          }

          const idCell = trElem.insertCell();
          idCell.id = baseId + '_pic_ic';

          const nameCell = trElem.insertCell();
          nameCell.id = baseId + '_id';
        }

        if (data.status === 'tmp inserted by fing' || data.status === 'tmp inserted by ic') {
          const baseId = data.data.time.slice(0, -7) + (data.ip || '');
          const idCell = document.getElementById(baseId + '_pic_ic');
          if (idCell && data.data.pic_data_aft) {
            const img = document.createElement('img');
            img.src = 'data:image/png;base64,' + data.data.pic_data_aft;
            img.className = 'thumbnail';
            idCell.appendChild(img);
          }

          const dateCell = document.getElementById(baseId + '_date');
          if (dateCell) {
            dateCell.innerHTML += '<br>' + (data.status === 'tmp inserted by fing' ? '指紋' : 'IC');
          }
        }

        if (data.status === 'tmp inserted wo pic' && data.data.id) {
          const baseId = data.data.time.slice(0, -7) + (data.ip || '');
          const nameCell = document.getElementById(baseId + '_id');
          if (nameCell) {
            nameCell.innerHTML = data.data.id + '<br>' + (data.data.name || '');
          }
        }
      });

      // Next button
      document.getElementById('next_btn').addEventListener('click', () => {
        if (lastDate) {
          loadData(lastDate);
        }
      });

      // Date picker
      document.getElementById('datepick').addEventListener('change', (e) => {
        const date = new Date(e.target.value);
        date.setDate(date.getDate() + 1);
        document.querySelectorAll('tr.tr_data').forEach(tr => tr.remove());
        loadData(date.toISOString().slice(0, -5));
      });

      // Initial load
      loadData();
    </script>
  `;

  return getBaseTemplate('タイムカード', content, scripts);
}

function getDriversPage(): string {
  const content = `
    <h1>ドライバー一覧</h1>
    <div class="mb-3">
      <button id="reloadBtn" class="btn btn-warning">外部DBから更新</button>
    </div>
    <table id="sample" class="table table-bordered">
      <thead>
        <tr>
          <th class="text-center">ID</th>
          <th class="text-center">氏名</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <div id="loading" class="loading">
      <div class="spinner"></div>
    </div>
  `;

  const scripts = `
    <script>
      const tableElem = document.getElementById('sample');
      const loadingElem = document.getElementById('loading');
      const reloadBtn = document.getElementById('reloadBtn');

      async function loadDrivers() {
        loadingElem.classList.add('show');
        tableElem.tBodies[0].innerHTML = '';
        try {
          const response = await fetch('/api/drivers');
          const drivers = await response.json();
          drivers.forEach((driver) => {
            const tr = tableElem.tBodies[0].insertRow(-1);
            tr.insertCell(0).textContent = driver.id;
            tr.insertCell().textContent = driver.name;
          });
        } catch (e) {
          console.error('Failed to load drivers:', e);
        } finally {
          loadingElem.classList.remove('show');
        }
      }

      async function reloadDrivers() {
        if (!confirm('外部DBからドライバー情報を更新しますか？')) return;
        loadingElem.classList.add('show');
        reloadBtn.disabled = true;
        try {
          const response = await fetch('/api/drivers/reload', { method: 'POST' });
          if (!response.ok) throw new Error('更新に失敗しました');
          const drivers = await response.json();
          tableElem.tBodies[0].innerHTML = '';
          drivers.forEach((driver) => {
            const tr = tableElem.tBodies[0].insertRow(-1);
            tr.insertCell(0).textContent = driver.id;
            tr.insertCell().textContent = driver.name;
          });
          alert('更新完了: ' + drivers.length + '件');
        } catch (e) {
          console.error('Failed to reload drivers:', e);
          alert('更新に失敗しました: ' + e.message);
        } finally {
          loadingElem.classList.remove('show');
          reloadBtn.disabled = false;
        }
      }

      reloadBtn.addEventListener('click', reloadDrivers);
      loadDrivers();
    </script>
  `;

  return getBaseTemplate('ドライバー', content, scripts);
}

function getIcNonRegPage(): string {
  const content = `
    <h1>未登録ICカード</h1>

    <!-- Web NFC登録セクション -->
    <div class="card mb-4 border-success">
      <div class="card-header bg-success text-white">
        <strong>Web NFC登録</strong> (Android Chrome)
      </div>
      <div class="card-body">
        <div class="row align-items-end">
          <div class="col-auto">
            <label for="nfcDriverId" class="form-label">ドライバーID</label>
            <input type="number" id="nfcDriverId" class="form-control" placeholder="ID入力" style="width: 120px;">
          </div>
          <div class="col-auto">
            <button id="nfcScanBtn" class="btn btn-success" disabled>
              ICカードをスキャン
            </button>
          </div>
          <div class="col" id="nfcStatus"></div>
        </div>
        <div id="nfcResult" class="mt-2"></div>
      </div>
    </div>

    <h5>未登録IC一覧</h5>
    <table id="sample" class="table table-bordered">
      <thead>
        <tr>
          <th class="text-center">日時</th>
          <th class="text-center">IC</th>
          <th class="text-center">ドライバー登録</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <div id="loading" class="loading">
      <div class="spinner"></div>
    </div>
  `;

  const scripts = `
    <script>
      const tableElem = document.getElementById('sample');
      const loadingElem = document.getElementById('loading');

      // Web NFC elements
      const nfcDriverId = document.getElementById('nfcDriverId');
      const nfcScanBtn = document.getElementById('nfcScanBtn');
      const nfcStatus = document.getElementById('nfcStatus');
      const nfcResult = document.getElementById('nfcResult');
      let firstRead = null;

      // Enable NFC button when driver ID entered
      nfcDriverId.addEventListener('input', () => {
        nfcScanBtn.disabled = !nfcDriverId.value.trim();
      });

      // NFC Scan button click
      nfcScanBtn.addEventListener('click', async () => {
        const driverId = nfcDriverId.value.trim();
        if (!driverId) return;

        if (!('NDEFReader' in window)) {
          alert('このブラウザはNFC読み取りに対応していません。Android版Chromeをお使いください。');
          return;
        }

        try {
          const ndef = new NDEFReader();
          await ndef.scan();

          firstRead = null;
          nfcStatus.innerHTML = '<span class="badge bg-info">1回目: ICカードをタッチ</span>';
          nfcResult.innerHTML = '';
          nfcScanBtn.disabled = true;
          nfcDriverId.disabled = true;

          ndef.addEventListener('reading', async ({ serialNumber }) => {
            const serial = serialNumber.replace(/:/g, '').toUpperCase();

            if (firstRead === null) {
              firstRead = serial;
              nfcStatus.innerHTML = '<span class="badge bg-warning text-dark">2回目: 同じICをもう一度タッチ (' + serial + ')</span>';
            } else {
              if (firstRead === serial) {
                nfcStatus.innerHTML = '<span class="badge bg-info">登録中...</span>';
                try {
                  const res = await fetch('/api/ic/register_direct', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ic_id: serial, driver_id: parseInt(driverId) })
                  });
                  const result = await res.json();
                  if (result.success) {
                    nfcResult.innerHTML = '<div class="alert alert-success py-2">' +
                      result.driver_name + ' (ID:' + result.driver_id + ') に登録予約完了<br>' +
                      '<small>次回ICタッチ時に登録されます</small></div>';
                    nfcStatus.innerHTML = '<span class="badge bg-success">完了</span>';
                    loadNonRegIc(); // Reload table
                  } else {
                    nfcResult.innerHTML = '<div class="alert alert-danger py-2">' + result.message + '</div>';
                    nfcStatus.innerHTML = '';
                  }
                } catch (e) {
                  nfcResult.innerHTML = '<div class="alert alert-danger py-2">エラー: ' + e.message + '</div>';
                }
                firstRead = null;
                nfcScanBtn.disabled = false;
                nfcDriverId.disabled = false;
              } else {
                nfcStatus.innerHTML = '<span class="badge bg-danger">ICが異なります。やり直してください</span>';
                firstRead = null;
                nfcScanBtn.disabled = false;
                nfcDriverId.disabled = false;
              }
            }
          });
        } catch (e) {
          alert('NFCエラー: ' + e);
          nfcScanBtn.disabled = false;
          nfcDriverId.disabled = false;
        }
      });

      async function loadNonRegIc() {
        loadingElem.classList.add('show');
        tableElem.tBodies[0].innerHTML = '';
        try {
          const response = await fetch('/api/ic_non_reg');
          const items = await response.json();
          items.filter(item => item.id && item.id.trim() !== '').forEach((item) => {
            const tr = tableElem.tBodies[0].insertRow(-1);

            // Date cell
            const dateCell = tr.insertCell(0);
            const date = new Date(item.datetime);
            const dateStr = date.getFullYear() + '/' +
              String(date.getMonth() + 1).padStart(2, '0') + '/' +
              String(date.getDate()).padStart(2, '0') + ' ' +
              String(date.getHours()).padStart(2, '0') + ':' +
              String(date.getMinutes()).padStart(2, '0') + ':' +
              String(date.getSeconds()).padStart(2, '0');
            dateCell.textContent = dateStr.slice(2);

            // IC cell
            tr.insertCell().textContent = item.id;

            // Driver registration cell
            const regCell = tr.insertCell();
            if (item.registered_id) {
              regCell.innerHTML = '<span class="badge bg-success">予約済: ID ' + item.registered_id + '</span>' +
                '<button class="btn btn-sm btn-outline-danger ms-2" onclick="cancelReservation(\\''+item.id+'\\')">取消</button>';
            } else {
              const form = document.createElement('form');
              form.className = 'd-flex';
              form.onsubmit = (e) => {
                e.preventDefault();
                registerIc(item.id, form.querySelector('input').value);
              };

              const input = document.createElement('input');
              input.type = 'text';
              input.className = 'form-control form-control-sm';
              input.name = 'driver_id';
              input.placeholder = 'ドライバーID';
              form.appendChild(input);

              const btn = document.createElement('button');
              btn.type = 'submit';
              btn.className = 'btn btn-sm btn-primary ms-2';
              btn.textContent = '登録';
              form.appendChild(btn);

              regCell.appendChild(form);
            }
          });
        } catch (e) {
          console.error('Failed to load non-registered IC:', e);
        } finally {
          loadingElem.classList.remove('show');
        }
      }

      async function registerIc(icId, driverId) {
        try {
          const response = await fetch('/api/ic_non_reg/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ic_id: icId, driver_id: driverId })
          });
          if (response.ok) {
            alert('登録しました');
            location.reload();
          } else {
            alert('登録に失敗しました');
          }
        } catch (e) {
          console.error('Failed to register IC:', e);
          alert('エラーが発生しました');
        }
      }

      async function cancelReservation(icId) {
        if (!confirm('予約を取消しますか？')) return;
        try {
          const response = await fetch('/api/ic_non_reg/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ic_id: icId })
          });
          if (response.ok) {
            alert('取消しました');
            location.reload();
          } else {
            alert('取消に失敗しました');
          }
        } catch (e) {
          console.error('Failed to cancel reservation:', e);
          alert('エラーが発生しました');
        }
      }

      // Real-time updates
      window.tcWs.on('hello', (data) => {
        if (data.status === 'insert ic_log' && !data.data.iid) {
          // ICが空の場合は非表示
          if (!data.data.ic || data.data.ic.trim() === '') return;
          const tr = tableElem.tBodies[0].insertRow(0);
          const date = new Date(data.data.date);
          const dateStr = date.getFullYear() + '/' +
            String(date.getMonth() + 1).padStart(2, '0') + '/' +
            String(date.getDate()).padStart(2, '0') + ' ' +
            String(date.getHours()).padStart(2, '0') + ':' +
            String(date.getMinutes()).padStart(2, '0') + ':' +
            String(date.getSeconds()).padStart(2, '0');
          tr.insertCell(0).textContent = dateStr.slice(2);
          tr.insertCell().textContent = data.data.ic || '';
          tr.insertCell().textContent = '';
        }
      });

      loadNonRegIc();
    </script>
  `;

  return getBaseTemplate('未登録IC', content, scripts);
}

function getDeleteIcPage(): string {
  const content = `
    <h1>IC削除</h1>
    <button id="scanButton" class="btn btn-danger btn-lg">Scan</button>
    <p class="mt-3 text-muted">androidで接続し、上記ボタンを押して、scanを行ってください。scanされたICが削除されます。</p>
    <div id="result" class="mt-3"></div>
  `;

  const scripts = `
    <script>
      const scanButton = document.getElementById('scanButton');
      const resultDiv = document.getElementById('result');

      // Real-time updates - 削除完了通知を受信
      window.tcWs.on('hello', (data) => {
        if (data.status === 'delete_ic') {
          resultDiv.innerHTML = '<div class="alert alert-success">IC ' + (data.ic || '') + ' の削除リクエストを送信しました</div>';
        }
      });

      scanButton.addEventListener('click', async () => {
        if (!('NDEFReader' in window)) {
          alert('このブラウザはNFC読み取りに対応していません。Androidの Chrome をお使いください。');
          return;
        }

        try {
          const ndef = new NDEFReader();
          await ndef.scan();
          resultDiv.innerHTML = '<div class="alert alert-info">スキャン中...</div>';

          ndef.addEventListener('readingerror', () => {
            alert('NFCタグを読み取れませんでした。別のタグをお試しください。');
          });

          ndef.addEventListener('reading', async ({ serialNumber }) => {
            const serial = serialNumber.replace(/:/g, '');
            resultDiv.innerHTML = '<div class="alert alert-warning">IC ' + serial + ' を削除中...</div>';

            try {
              const response = await fetch('/api/ic/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ic_id: serial })
              });
              const result = await response.json();
              if (result.success) {
                resultDiv.innerHTML = '<div class="alert alert-success">' + result.message + '</div>';
              } else {
                resultDiv.innerHTML = '<div class="alert alert-danger">エラー: ' + result.message + '</div>';
              }
            } catch (error) {
              resultDiv.innerHTML = '<div class="alert alert-danger">APIエラー: ' + error + '</div>';
            }
          });
        } catch (error) {
          alert('エラー: ' + error);
        }
      });
    </script>
  `;

  return getBaseTemplate('IC削除', content, scripts);
}

function getIcLogListPage(): string {
  const content = `
    <h1>打刻一覧</h1>
    <div class="mb-3">
      <label for="limitSelect" class="form-label">表示件数:</label>
      <select id="limitSelect" class="form-select" style="max-width: 150px;">
        <option value="50">50件</option>
        <option value="100" selected>100件</option>
        <option value="200">200件</option>
        <option value="500">500件</option>
      </select>
    </div>
    <table id="sample" class="table table-bordered table-striped">
      <thead class="table-dark">
        <tr>
          <th class="text-center">日時</th>
          <th class="text-center">ID</th>
          <th class="text-center">氏名</th>
          <th class="text-center">カードID</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <div id="loading" class="loading">
      <div class="spinner"></div>
    </div>
  `;

  const scripts = `
    <script>
      const tableElem = document.getElementById('sample');
      const loadingElem = document.getElementById('loading');
      const limitSelect = document.getElementById('limitSelect');

      async function loadIcLogList() {
        loadingElem.classList.add('show');
        // Clear existing rows
        tableElem.tBodies[0].innerHTML = '';

        try {
          const limit = limitSelect.value;
          const response = await fetch('/api/ic_log_list?limit=' + limit);
          const logs = await response.json();

          logs.forEach((log) => {
            const tr = tableElem.tBodies[0].insertRow(-1);

            // Date cell
            const dateCell = tr.insertCell(0);
            const date = new Date(log.date);
            const dateStr = date.getFullYear() + '/' +
                          String(date.getMonth() + 1).padStart(2, '0') + '/' +
                          String(date.getDate()).padStart(2, '0') + ' ' +
                          String(date.getHours()).padStart(2, '0') + ':' +
                          String(date.getMinutes()).padStart(2, '0') + ':' +
                          String(date.getSeconds()).padStart(2, '0');
            dateCell.textContent = dateStr;
            dateCell.className = 'text-center';

            // Driver ID cell
            const idCell = tr.insertCell();
            idCell.textContent = log.driver_id != null ? String(log.driver_id) : '';
            idCell.className = 'text-center';
            if (log.driver_id == null) {
              idCell.style.color = '#999';
            }

            // Name cell
            const nameCell = tr.insertCell();
            nameCell.textContent = log.driver_name || '(未登録)';
            nameCell.className = 'text-center';
            if (!log.driver_name) {
              nameCell.style.color = '#999';
            }

            // Card ID cell
            const cardCell = tr.insertCell();
            cardCell.textContent = log.card_id || '';
            cardCell.className = 'text-center text-muted';
            cardCell.style.fontSize = '0.85em';
          });
        } catch (e) {
          console.error('Failed to load IC log list:', e);
          alert('データの取得に失敗しました');
        } finally {
          loadingElem.classList.remove('show');
        }
      }

      // Handle limit change
      limitSelect.addEventListener('change', loadIcLogList);

      // Real-time updates
      window.tcWs.on('hello', (data) => {
        if (data.status && data.status.includes('ic')) {
          // Reload when new IC event received
          loadIcLogList();
        }
      });

      // Initial load
      loadIcLogList();
    </script>
  `;

  return getBaseTemplate('打刻一覧', content, scripts);
}

function getClientsPage(): string {
  const content = `
    <h1>接続端末一覧</h1>
    <div class="mb-3">
      <span class="badge bg-primary" id="clientCount">0 台接続中</span>
      <button id="refreshBtn" class="btn btn-sm btn-outline-secondary ms-2">更新</button>
    </div>
    <table id="clientsTable" class="table table-bordered table-striped">
      <thead class="table-dark">
        <tr>
          <th class="text-center">IPアドレス</th>
          <th class="text-center">接続時刻</th>
          <th class="text-center">最終通信</th>
          <th class="text-center">状態</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <div id="loading" class="loading">
      <div class="spinner"></div>
    </div>
    <div id="noClients" class="text-muted text-center py-4" style="display: none;">
      接続中の端末はありません
    </div>
  `;

  const scripts = `
    <script>
      const tableBody = document.querySelector('#clientsTable tbody');
      const clientCount = document.getElementById('clientCount');
      const loadingElem = document.getElementById('loading');
      const noClientsElem = document.getElementById('noClients');
      const clientsTable = document.getElementById('clientsTable');

      async function loadClients() {
        loadingElem.classList.add('show');
        tableBody.innerHTML = '';
        try {
          const response = await fetch('/api/clients');
          const data = await response.json();
          renderClients(data.clients);
          updateCount(data.total);
        } catch (e) {
          console.error('Failed to load clients:', e);
          tableBody.innerHTML = '<tr><td colspan="4" class="text-center text-danger">データの取得に失敗しました</td></tr>';
        } finally {
          loadingElem.classList.remove('show');
        }
      }

      function renderClients(clients) {
        tableBody.innerHTML = '';

        if (clients.length === 0) {
          clientsTable.style.display = 'none';
          noClientsElem.style.display = 'block';
          return;
        }

        clientsTable.style.display = 'table';
        noClientsElem.style.display = 'none';

        clients.forEach((client) => {
          const tr = document.createElement('tr');
          tr.id = 'client-' + client.socket_id;

          // IP Address
          const ipCell = tr.insertCell();
          ipCell.textContent = client.ip_address || 'unknown';
          ipCell.className = 'text-center';

          // Connected time
          const connectedCell = tr.insertCell();
          const connectedDate = new Date(client.connected_at);
          connectedCell.textContent = formatDateTime(connectedDate);
          connectedCell.className = 'text-center';

          // Last activity
          const activityCell = tr.insertCell();
          const activityDate = new Date(client.last_activity);
          activityCell.textContent = formatDateTime(activityDate);
          activityCell.className = 'text-center';
          activityCell.id = 'activity-' + client.socket_id;

          // Status
          const statusCell = tr.insertCell();
          const timeDiff = Date.now() - activityDate.getTime();
          if (timeDiff < 60000) {
            statusCell.innerHTML = '<span class="badge bg-success">アクティブ</span>';
          } else if (timeDiff < 300000) {
            statusCell.innerHTML = '<span class="badge bg-warning text-dark">待機中</span>';
          } else {
            statusCell.innerHTML = '<span class="badge bg-secondary">非アクティブ</span>';
          }
          statusCell.className = 'text-center';

          tableBody.appendChild(tr);
        });
      }

      function updateCount(count) {
        clientCount.textContent = count + ' 台接続中';
        if (count > 0) {
          clientCount.className = 'badge bg-success';
        } else {
          clientCount.className = 'badge bg-secondary';
        }
      }

      function formatDateTime(date) {
        return date.getFullYear() + '/' +
          String(date.getMonth() + 1).padStart(2, '0') + '/' +
          String(date.getDate()).padStart(2, '0') + ' ' +
          String(date.getHours()).padStart(2, '0') + ':' +
          String(date.getMinutes()).padStart(2, '0') + ':' +
          String(date.getSeconds()).padStart(2, '0');
      }

      // Refresh button
      document.getElementById('refreshBtn').addEventListener('click', loadClients);

      // Auto-refresh every 30 seconds
      setInterval(loadClients, 30000);

      // Initial load
      loadClients();
    </script>
  `;

  return getBaseTemplate('接続端末', content, scripts);
}

function getStyles(): string {
  return `
    body { padding: 20px; }
    .nav-links { margin-bottom: 20px; }
    .nav-links a { margin-right: 15px; }
    .loading { display: none; }
    .loading.show { display: block; text-align: center; padding: 20px; }
    .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .ws-status { position: fixed; top: 10px; right: 10px; padding: 5px 10px; border-radius: 5px; font-size: 12px; }
    .ws-connected { background: #28a745; color: white; }
    .ws-disconnected { background: #dc3545; color: white; }
    img.thumbnail { max-width: 200px; max-height: 150px; }
  `;
}

// PWA Manifest
function getManifest(): string {
  return JSON.stringify({
    name: '大石社タイムカード',
    short_name: 'タイムカード',
    description: 'ICカード打刻確認システム',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0d6efd',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }, null, 2);
}

// Service Worker
function getServiceWorker(): string {
  return `// Service Worker for 大石社タイムカード PWA
const CACHE_NAME = 'timecard-v1';
const STATIC_ASSETS = [
  '/',
  '/drivers',
  '/ic_non_reg',
  '/delete_ic',
  '/styles.css',
  '/manifest.webmanifest',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Service Worker: Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch event - network first, fallback to cache
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip WebSocket requests
  if (url.pathname === '/ws') {
    return;
  }

  // Skip API requests - always fetch from network
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // For navigation requests (HTML pages), use network first
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clone and cache successful responses
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache on network failure
          return caches.match(request).then((cachedResponse) => {
            return cachedResponse || caches.match('/');
          });
        })
    );
    return;
  }

  // For static assets, use cache first
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached version and update cache in background
        fetch(request).then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, response);
            });
          }
        }).catch(() => {});
        return cachedResponse;
      }

      // Not in cache, fetch from network
      return fetch(request).then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return response;
      });
    })
  );
});
`;
}

// LINE WORKSアプリ認証ページ（AndroidでIntent URLを使用）
function getLineworksAppLoginPage(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const redirect = url.searchParams.get('redirect') || '/';
  const config = JSON.parse(env.LINEWORKS_CONFIG) as { client_id: string; client_secret: string };

  const state = {
    redirect,
    nonce: crypto.randomUUID(),
  };
  const stateStr = btoa(JSON.stringify(state));

  const authUrl = new URL('https://auth.worksmobile.com/oauth2/v2.0/authorize');
  authUrl.searchParams.set('client_id', config.client_id);
  authUrl.searchParams.set('redirect_uri', `${url.origin}/auth/lineworks/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'user.read');
  authUrl.searchParams.set('state', stateStr);

  // LINE WORKSアプリがインストールされていれば、App Linksで自動的にアプリ内ブラウザが開く
  // 通常のhttps URLでリダイレクトする
  const oauthUrl = authUrl.toString();

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LINE WORKS認証中...</title>
  <style>
    body {
      font-family: sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #00C73C 0%, #00A032 100%);
      color: white;
    }
    .container { text-align: center; padding: 20px; }
    .spinner {
      border: 4px solid rgba(255,255,255,0.3);
      border-top: 4px solid white;
      border-radius: 50%;
      width: 50px;
      height: 50px;
      animation: spin 1s linear infinite;
      margin: 20px auto;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .fallback { margin-top: 30px; }
    .fallback a {
      color: white;
      background: rgba(0,0,0,0.2);
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      display: inline-block;
    }
    .fallback a:hover { background: rgba(0,0,0,0.3); }
    .debug { margin-top: 20px; font-size: 12px; opacity: 0.7; word-break: break-all; max-width: 90%; }
  </style>
</head>
<body>
  <div class="container">
    <h2>LINE WORKS認証へリダイレクト中...</h2>
    <div class="spinner"></div>
    <p id="status">LINE WORKSアプリがインストールされていれば自動でアプリが開きます</p>
    <div class="fallback">
      <a href="${oauthUrl}" id="fallbackLink">手動で認証画面を開く</a>
    </div>
    <div class="debug" id="debug"></div>
  </div>
  <script>
    const oauthUrl = "${oauthUrl.replace(/"/g, '\\"')}";
    const debug = document.getElementById('debug');

    debug.textContent = 'URL: ' + oauthUrl.substring(0, 100) + '...';

    // 少し待ってからリダイレクト（ページ表示のため）
    setTimeout(function() {
      window.location.href = oauthUrl;
    }, 500);
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `oauth_state=${stateStr}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

// ログインページ（バックグラウンドで認証チェック）
function getLoginPage(redirect: string = '/'): string {
  const safeRedirect = redirect.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0d6efd">
  <title>ログイン - 大石社タイムカード</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
  <style>
    body {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      background: white;
      border-radius: 16px;
      padding: 40px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      max-width: 400px;
      width: 90%;
    }
    .login-title {
      text-align: center;
      margin-bottom: 30px;
    }
    .login-title h1 {
      font-size: 1.5rem;
      color: #333;
      margin-bottom: 5px;
    }
    .login-title p {
      color: #666;
      font-size: 0.9rem;
    }
    .btn-login {
      width: 100%;
      padding: 12px;
      font-size: 1rem;
      border-radius: 8px;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .btn-google {
      background: #fff;
      border: 1px solid #ddd;
      color: #333;
    }
    .btn-google:hover {
      background: #f8f9fa;
      border-color: #ccc;
    }
    .btn-lineworks {
      background: #00C73C;
      border: none;
      color: white;
    }
    .btn-lineworks:hover {
      background: #00B036;
    }
    .btn-lineworks-app {
      background: #00A032;
      border: 2px solid #008028;
      color: white;
    }
    .btn-lineworks-app:hover {
      background: #008028;
      color: white;
    }
    .divider {
      text-align: center;
      color: #999;
      margin: 20px 0;
      position: relative;
    }
    .divider::before,
    .divider::after {
      content: '';
      position: absolute;
      top: 50%;
      width: 40%;
      height: 1px;
      background: #ddd;
    }
    .divider::before { left: 0; }
    .divider::after { right: 0; }
    .icon-google {
      width: 20px;
      height: 20px;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-title">
      <h1>大石社タイムカード</h1>
      <p>ログインしてください</p>
    </div>

    <a href="/login/google" class="btn btn-login btn-google">
      <svg class="icon-google" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
      Googleでログイン
    </a>

    <a href="/login/lineworks" class="btn btn-login btn-lineworks" id="lineworksBtn">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
      </svg>
      LINE WORKSでログイン
    </a>

    <a href="https://woff.worksmobile.com/woff/bY8PaaudJVkZqS9zhXzHtQ" class="btn btn-login btn-lineworks-app" id="woffBtn">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
      </svg>
      WOFFでログイン
    </a>

    <div class="divider">または</div>

    <p class="text-center text-muted small">
      Cloudflare Access経由でアクセスすると自動ログインされます
    </p>
  </div>
  <script>
    // バックグラウンドで認証チェック（10秒間、500ms間隔）
    (async function() {
      for (let i = 0; i < 20; i++) {
        try {
          const res = await fetch('/api/auth/check', { credentials: 'include' });
          if (res.ok) {
            const data = await res.json();
            if (data.authenticated) {
              window.location.replace("${safeRedirect}");
              return;
            }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 500));
      }
    })();
  </script>
</body>
</html>`;
}

// WOFF SDKログインページ
function getWoffLoginPage(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const redirect = url.searchParams.get('redirect') || '/';
  const woffId = (env as { WOFF_ID?: string }).WOFF_ID || '';

  if (!woffId) {
    return new Response('WOFF_ID not configured', { status: 500 });
  }

  // 認証フロー:
  // 1. 初回アクセス: woff.login()でLINE WORKS認証画面へリダイレクト
  // 2. 認証後: code&stateパラメータ付きでこのページにリダイレクト
  // 3. woff.init()が自動でトークン取得、isLoggedIn()がtrueになる

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LINE WORKS認証中...</title>
  <style>
    body {
      font-family: sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #00C73C 0%, #00A032 100%);
      color: white;
    }
    .container { text-align: center; padding: 20px; max-width: 500px; }
    .spinner {
      border: 4px solid rgba(255,255,255,0.3);
      border-top: 4px solid white;
      border-radius: 50%;
      width: 50px;
      height: 50px;
      animation: spin 1s linear infinite;
      margin: 20px auto;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .status { margin: 20px 0; font-size: 14px; }
    .error { background: rgba(255,0,0,0.2); padding: 15px; border-radius: 8px; margin-top: 20px; }
    .fallback { margin-top: 30px; }
    .fallback a {
      color: white;
      background: rgba(0,0,0,0.2);
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      display: inline-block;
    }
    .debug { margin-top: 20px; font-size: 11px; opacity: 0.7; text-align: left; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <!-- Eruda デバッガー -->
  <script src="https://cdn.jsdelivr.net/npm/eruda"></script>
  <script>eruda.init();</script>

  <div class="container">
    <h2>LINE WORKS認証</h2>
    <div class="spinner" id="spinner"></div>
    <p class="status" id="status">WOFF SDK初期化中...</p>
    <div id="error" class="error" style="display: none;"></div>
    <div class="fallback" id="fallback" style="display: none;">
      <a href="/login/lineworks">通常のログインに戻る</a>
    </div>
    <div class="debug" id="debug"></div>
  </div>

  <!-- WOFF SDK v3.7.1 (最新版) -->
  <script charset="utf-8" src="https://static.worksmobile.net/static/wm/woff/edge/3.7.1/sdk.js"></script>
  <script>
    const woffId = '${woffId}';
    // URLパラメータまたはsessionStorageからリダイレクト先を取得
    const urlRedirect = '${redirect}';
    const storedRedirect = sessionStorage.getItem('woff_redirect');
    const finalRedirect = storedRedirect || urlRedirect || '/';
    // open_external パラメータを取得（外部ブラウザで開くかどうか）
    const openExternal = new URLSearchParams(window.location.search).get('open_external') || '${url.searchParams.get('open_external') || ''}';
    const debug = document.getElementById('debug');
    const status = document.getElementById('status');
    const spinner = document.getElementById('spinner');
    const errorDiv = document.getElementById('error');
    const fallback = document.getElementById('fallback');

    function log(msg) {
      console.log(msg);
      debug.textContent += new Date().toISOString().slice(11, 19) + ' ' + msg + '\\n';
    }

    function showError(msg) {
      spinner.style.display = 'none';
      status.textContent = 'エラーが発生しました';
      errorDiv.textContent = msg;
      errorDiv.style.display = 'block';
      fallback.style.display = 'block';
    }

    async function initWoff() {
      // デバッグモード: URLに?debug=1があればリダイレクトしない
      const debugMode = new URLSearchParams(window.location.search).has('debug');

      try {
        log('WOFF SDK init開始: ' + woffId);
        log('Debug mode: ' + debugMode);
        await woff.init({ woffId: woffId });
        log('WOFF SDK init完了');

        const isInClient = woff.isInClient();
        const isLoggedIn = woff.isLoggedIn();
        log('isInClient: ' + isInClient);
        log('isLoggedIn: ' + isLoggedIn);

        // WOFF contextを表示
        try {
          const context = woff.getContext();
          log('context: ' + JSON.stringify(context));
        } catch (ce) {
          log('context error: ' + ce.message);
        }

        if (debugMode) {
          log('=== DEBUG MODE - リダイレクトしません ===');
          spinner.style.display = 'none';
          status.textContent = 'デバッグモード - init成功';
          return;
        }

        // URLパラメータでOAuth認証後かどうかを判定
        const urlParams = new URLSearchParams(window.location.search);
        const hasOAuthParams = urlParams.has('code') && urlParams.has('state');
        log('hasOAuthParams: ' + hasOAuthParams);

        if (isLoggedIn) {
          // OAuth後のパラメータを履歴から削除（リロード対策）
          if (window.location.search.includes('code=')) {
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, '', cleanUrl);
          }

          // ログイン済み - トークン取得してサーバーに送信
          log('ログイン済み - トークン取得');
          status.textContent = 'ログイン済み - 認証処理中...';

          const accessToken = woff.getAccessToken();
          const idToken = woff.getIDToken();
          log('accessToken: ' + (accessToken ? accessToken.substring(0, 20) + '...' : 'null'));
          log('idToken: ' + (idToken ? idToken.substring(0, 20) + '...' : 'null'));

          // コールバックにトークンを送信してセッション作成
          const callbackUrl = new URL('${url.origin}/auth/woff/callback');
          callbackUrl.searchParams.set('redirect', finalRedirect);
          callbackUrl.searchParams.set('access_token', accessToken || '');
          callbackUrl.searchParams.set('id_token', idToken || '');
          if (openExternal) {
            callbackUrl.searchParams.set('open_external', openExternal);
          }
          window.location.href = callbackUrl.toString();
        } else if (!hasOAuthParams) {
          // 未ログイン かつ OAuth認証前 - ログイン処理開始
          log('未ログイン - login開始');
          status.textContent = 'LINE WORKSログイン画面へリダイレクト...';

          // リダイレクト先をsessionStorageに保存（OAuth後に復元）
          sessionStorage.setItem('woff_redirect', finalRedirect);

          // woff.login()はページをリダイレクトする
          // 公式サンプルと同様、パラメータなしで呼び出す
          // （redirectUriを指定しないとEndpoint URLに戻る）
          woff.login();
          // ↑ この後のコードは実行されない（リダイレクトのため）
        } else {
          // OAuth認証後だがログイン状態ではない（エラー）
          log('OAuth認証後だがログインできていない');
          showError('認証に失敗しました。再度お試しください。');
        }
      } catch (e) {
        log('エラー: ' + e.message);
        log('エラー詳細: ' + JSON.stringify(e));
        showError(e.message || String(e));
      }
    }

    // SDK読み込み完了をポーリングで待機（Qiita記事推奨パターン）
    // https://qiita.com/iwaohig/items/186863fcf7e443b90713
    function waitForWoff() {
      if (typeof woff !== 'undefined') {
        initWoff();
      } else {
        setTimeout(waitForWoff, 50);
      }
    }
    waitForWoff();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// 一時トークンでセッション作成（外部ブラウザ用）
async function handleTokenAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const redirect = url.searchParams.get('redirect') || '/';

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  // トークン検証
  const payload = await verifyTempToken(token, env);
  if (!payload) {
    return new Response('Invalid or expired token', { status: 401 });
  }

  // セッションCookie作成
  const sessionCookie = await createSessionCookie(payload, env);

  // リダイレクト
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect,
      'Set-Cookie': sessionCookie,
    },
  });
}

// WOFFコールバック処理
async function handleWoffCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirect = url.searchParams.get('redirect') || '/';
  const accessToken = url.searchParams.get('access_token');
  const idToken = url.searchParams.get('id_token');
  // WOFF login()後はcodeパラメータ付きでリダイレクトされる
  const woffId = (env as { WOFF_ID?: string }).WOFF_ID || '';

  // デバッグ用HTML（トークンがない場合はWOFF SDKでログイン後の処理をする必要がある）
  // WOFF login()後はcodeパラメータ付きでリダイレクトされるので、再度WOFF SDKで処理
  if (!accessToken && !idToken) {
    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>認証処理中...</title>
  <style>
    body {
      font-family: sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #00C73C 0%, #00A032 100%);
      color: white;
    }
    .container { text-align: center; padding: 20px; max-width: 500px; }
    .spinner {
      border: 4px solid rgba(255,255,255,0.3);
      border-top: 4px solid white;
      border-radius: 50%;
      width: 50px;
      height: 50px;
      animation: spin 1s linear infinite;
      margin: 20px auto;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .status { margin: 20px 0; }
    .debug { margin-top: 20px; font-size: 11px; opacity: 0.7; text-align: left; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="container">
    <h2>認証処理中...</h2>
    <div class="spinner"></div>
    <p class="status" id="status">トークン取得中...</p>
    <div class="debug" id="debug"></div>
  </div>

  <script charset="utf-8" src="https://static.worksmobile.net/static/wm/woff/edge/3.7.1/sdk.js"></script>
  <script>
    const woffId = '${woffId}';
    const redirect = '${redirect}';
    const debug = document.getElementById('debug');
    const status = document.getElementById('status');

    function log(msg) {
      console.log(msg);
      debug.textContent += msg + '\\n';
    }

    async function processCallback() {
      try {
        log('WOFF init: ' + woffId);
        await woff.init({ woffId: woffId });

        const isLoggedIn = woff.isLoggedIn();
        log('isLoggedIn: ' + isLoggedIn);

        if (isLoggedIn) {
          const accessToken = woff.getAccessToken();
          const idToken = woff.getIDToken();
          log('トークン取得成功');

          // サーバーにトークンを送信してセッション作成
          const response = await fetch('/auth/woff/callback?redirect=' + encodeURIComponent(redirect) +
            '&access_token=' + encodeURIComponent(accessToken || '') +
            '&id_token=' + encodeURIComponent(idToken || ''));

          if (response.redirected) {
            window.location.href = response.url;
          } else {
            // リダイレクトレスポンスの場合
            window.location.href = redirect;
          }
        } else {
          log('ログイン状態ではありません');
          status.textContent = 'ログインが必要です';
          setTimeout(() => window.location.href = '/login', 2000);
        }
      } catch (e) {
        log('エラー: ' + e);
        status.textContent = 'エラー: ' + e.message;
      }
    }

    // SDK読み込み完了をポーリングで待機
    function waitForWoff() {
      if (typeof woff !== 'undefined') {
        processCallback();
      } else {
        setTimeout(waitForWoff, 50);
      }
    }
    waitForWoff();
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // トークンがある場合はユーザー情報を取得してセッション作成
  if (accessToken) {
    try {
      // WOFF APIでユーザー情報取得
      const userResponse = await fetch('https://www.worksapis.com/v1.0/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!userResponse.ok) {
        console.error('WOFF userinfo failed:', await userResponse.text());
        return new Response('Failed to get user info', { status: 500 });
      }

      const userInfo = (await userResponse.json()) as {
        userId: string;
        email?: string;
        userName?: { lastName?: string; firstName?: string };
      };

      const email = userInfo.email || `${userInfo.userId}@lineworks`;
      const name = userInfo.userName
        ? `${userInfo.userName.lastName || ''} ${userInfo.userName.firstName || ''}`.trim()
        : userInfo.userId;

      console.log('WOFF userInfo:', JSON.stringify(userInfo));

      // セッションCookie作成（lineworks-oauth.tsからインポートする代わりに直接使用）
      const { createSessionCookie } = await import('./auth/session');

      const sessionCookie = await createSessionCookie(
        {
          sub: userInfo.userId,
          email,
          name,
          provider: 'lineworks',
        },
        env
      );

      // WOFF認証成功後は一時トークンを生成してWOFFランディングページにリダイレクト
      // 外部ブラウザで開いたときにトークンを検証してセッションを作成する
      const tempToken = await createTempToken(
        {
          sub: userInfo.userId,
          email,
          name,
          provider: 'lineworks',
        },
        env
      );

      return new Response(null, {
        status: 302,
        headers: {
          Location: '/woff?dest=' + encodeURIComponent(redirect) + '&token=' + encodeURIComponent(tempToken),
        },
      });
    } catch (e) {
      console.error('WOFF callback error:', e);
      return new Response('Authentication failed: ' + String(e), { status: 500 });
    }
  }

  return new Response('Missing token', { status: 400 });
}

// WOFFミニアプリランディングページ
// LINE WORKSアプリ内から開き、外部ブラウザでタイムカードを開く
function getWoffLandingPage(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const woffId = (env as { WOFF_ID?: string }).WOFF_ID || '';
  const baseUrl = url.origin;
  // destパラメータがあればそのURLを、なければトップページを開く
  const dest = url.searchParams.get('dest') || '/';
  // 一時トークン（外部ブラウザでセッション作成用）
  const token = url.searchParams.get('token') || '';

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>大石社タイムカード</title>
  <script charset="utf-8" src="https://static.worksmobile.net/static/wm/woff/edge/3.7.1/sdk.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, #00C73C 0%, #00A032 100%);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 30px 20px;
      max-width: 400px;
      width: 100%;
    }
    h1 {
      color: white;
      font-size: 1.5rem;
      margin-bottom: 10px;
    }
    .subtitle {
      color: rgba(255,255,255,0.8);
      font-size: 0.9rem;
      margin-bottom: 30px;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 18px 24px;
      font-size: 1.1rem;
      font-weight: bold;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      margin-bottom: 15px;
      transition: transform 0.1s, box-shadow 0.1s;
    }
    .btn:active {
      transform: scale(0.98);
    }
    .btn-primary {
      background: white;
      color: #00A032;
      box-shadow: 0 4px 15px rgba(0,0,0,0.2);
    }
    .btn-primary:hover {
      box-shadow: 0 6px 20px rgba(0,0,0,0.3);
    }
    .btn:disabled {
      background: #ccc;
      color: #666;
    }
    .status {
      color: rgba(255,255,255,0.7);
      font-size: 0.85rem;
      margin-top: 20px;
      min-height: 24px;
    }
    .error {
      background: rgba(255,0,0,0.2);
      color: white;
      padding: 12px;
      border-radius: 8px;
      margin-top: 15px;
      font-size: 0.9rem;
    }
    .spinner {
      border: 3px solid rgba(255,255,255,0.3);
      border-top: 3px solid white;
      border-radius: 50%;
      width: 24px;
      height: 24px;
      animation: spin 1s linear infinite;
      display: inline-block;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>大石社タイムカード</h1>
    <p class="subtitle">認証完了しました</p>

    <button class="btn btn-primary" id="btn-open" disabled>
      タイムカードを開く
    </button>

    <div class="status" id="status">
      <span class="spinner"></span>準備中...
    </div>
    <div id="error"></div>
  </div>

  <script>
    const WOFF_ID = '${woffId}';
    const BASE_URL = '${baseUrl}';
    const DEST = '${dest}';
    const TOKEN = '${token}';
    const btnOpen = document.getElementById('btn-open');
    const statusEl = document.getElementById('status');
    const errorEl = document.getElementById('error');

    function showStatus(msg, showSpinner = false) {
      statusEl.innerHTML = (showSpinner ? '<span class="spinner"></span>' : '') + msg;
    }

    function showError(msg) {
      errorEl.innerHTML = '<div class="error">' + msg + '</div>';
    }

    async function initWoff() {
      try {
        await woff.init({ woffId: WOFF_ID });

        // ボタン有効化
        showStatus('ボタンを押してブラウザで開いてください');
        btnOpen.disabled = false;

        btnOpen.onclick = () => {
          showStatus('外部ブラウザで開いています...', true);
          // トークンがあれば認証エンドポイント経由、なければ直接開く
          const targetUrl = TOKEN
            ? BASE_URL + '/auth/token?token=' + encodeURIComponent(TOKEN) + '&redirect=' + encodeURIComponent(DEST)
            : BASE_URL + DEST;
          woff.openWindow({
            url: targetUrl,
            external: true
          });
        };

      } catch (e) {
        showStatus('エラーが発生しました');
        showError(e.message || String(e));
      }
    }

    // SDK読み込み待機
    function waitForWoff() {
      if (typeof woff !== 'undefined') {
        initWoff();
      } else {
        setTimeout(waitForWoff, 50);
      }
    }
    waitForWoff();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
