const RULE_ID = 1;
const HEADER_NAME = 'CF-Access-Jwt-Assertion';
const TARGET_HOST = 'tc-ohishi.mtamaramu.com';

const enabledEl = document.getElementById('enabled');
const jwtEl = document.getElementById('jwt');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
}

function buildRule(jwt) {
  return {
    id: RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: HEADER_NAME, operation: 'set', value: jwt }],
    },
    condition: {
      urlFilter: `||${TARGET_HOST}`,
      resourceTypes: [
        'main_frame',
        'sub_frame',
        'stylesheet',
        'script',
        'image',
        'font',
        'object',
        'xmlhttprequest',
        'ping',
        'csp_report',
        'media',
        'websocket',
        'other',
      ],
    },
  };
}

async function applyRule(enabled, jwt) {
  const shouldApply = enabled && jwt.length > 0;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: shouldApply ? [buildRule(jwt)] : [],
  });
  return shouldApply;
}

async function load() {
  const { enabled = false, jwt = '' } = await chrome.storage.local.get(['enabled', 'jwt']);
  enabledEl.checked = enabled;
  jwtEl.value = jwt;
}

document.getElementById('save').addEventListener('click', async () => {
  const enabled = enabledEl.checked;
  const jwt = jwtEl.value.trim();
  await chrome.storage.local.set({ enabled, jwt });
  const applied = await applyRule(enabled, jwt);
  setStatus(applied ? '保存して注入を有効化しました。' : '保存しました (現在は無効 / JWT未入力)。');
});

document.getElementById('test').addEventListener('click', async () => {
  setStatus('確認中...');
  try {
    const res = await fetch(`https://${TARGET_HOST}/api/auth/check`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const data = await res.json();
    setStatus(`HTTP ${res.status} / authenticated: ${data.authenticated}`);
  } catch (e) {
    setStatus(`確認に失敗しました: ${e.message}`);
  }
});

load();
