// Timecard Cloudflare Worker
// Main entry point for the timecard frontend application

import { WebSocketHibernationDO } from './durable-objects/websocket-hibernation';
import { handleApiRequest } from './api/routes';

export { WebSocketHibernationDO };

export interface Env {
  WEBSOCKET_HIBERNATION: DurableObjectNamespace;
  GRPC_API_URL: string;
  __STATIC_CONTENT: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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

  return new Response('Not Found', { status: 404 });
}

function getPageContent(path: string): string | null {
  const pages: Record<string, string> = {
    '/drivers.html': getDriversPage(),
    '/ic-non-reg.html': getIcNonRegPage(),
    '/delete-ic.html': getDeleteIcPage(),
    '/ic-log-list.html': getIcLogListPage(),
  };
  return pages[path] || null;
}

function getStaticAsset(path: string): string | null {
  const assets: Record<string, string> = {
    '/styles.css': getStyles(),
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
  <title>${title} - 大石社タイムカード</title>
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
    <nav class="nav-links">
      <a href="/" class="btn btn-outline-primary">打刻一覧</a>
      <a href="/drivers" class="btn btn-outline-primary">ドライバー</a>
      <a href="/ic_non_reg" class="btn btn-outline-primary">未登録IC</a>
      <a href="/delete_ic" class="btn btn-outline-primary">IC削除</a>
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
          items.forEach((item) => {
            const tr = tableElem.tBodies[0].insertRow(-1);

            // Date cell
            const dateCell = tr.insertCell(0);
            const dateStr = new Date(item.datetime).toISOString().replace(/-/g, '/').replace(/T/g, ' ').slice(2, -5);
            dateCell.textContent = dateStr;

            // IC cell
            tr.insertCell().textContent = item.id;

            // Driver registration cell
            const regCell = tr.insertCell();
            if (item.registered_id) {
              regCell.innerHTML = '<span class="badge bg-success">予約済: ID ' + item.registered_id + '</span>';
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

      // Real-time updates
      window.tcWs.on('hello', (data) => {
        if (data.status === 'insert ic_log' && !data.data.iid) {
          const tr = tableElem.tBodies[0].insertRow(0);
          const date = new Date(data.data.date);
          date.setHours(date.getHours() + 9);
          tr.insertCell(0).textContent = date.toISOString().replace(/-/g, '/').replace(/T/g, ' ').slice(2, -5);
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

      // Real-time updates
      window.tcWs.on('hello', (data) => {
        if (data.status === 'delete_ic') {
          resultDiv.innerHTML = '<div class="alert alert-success">IC ' + (data.ic || '') + ' を削除しました</div>';
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

          ndef.addEventListener('reading', ({ serialNumber }) => {
            const serial = serialNumber.replace(/:/g, '');
            window.tcWs.send({
              type: 'message',
              data: { status: 'delete_ic', ic: serial }
            });
            resultDiv.innerHTML = '<div class="alert alert-warning">IC ' + serial + ' を削除中...</div>';
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
