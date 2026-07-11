const RULE_ID = 1;
const TARGET_HOST = 'tc-ohishi.mtamaramu.com';
const TARGET_URL = `https://${TARGET_HOST}/`;
const SESSION_COOKIE_NAME = 'tc_session';

const enabledEl = document.getElementById('enabled');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
}

function buildRule(cookieValue) {
  return {
    id: RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Cookie', operation: 'set', value: `${SESSION_COOKIE_NAME}=${cookieValue}` },
      ],
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

async function applyRule(enabled, cookieValue) {
  const shouldApply = enabled && !!cookieValue;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: shouldApply ? [buildRule(cookieValue)] : [],
  });
  return shouldApply;
}

async function load() {
  const { enabled = false } = await chrome.storage.local.get(['enabled']);
  enabledEl.checked = enabled;
}

document.getElementById('capture').addEventListener('click', async () => {
  setStatus('現在のログイン状態を確認中...');
  const cookie = await chrome.cookies.get({ url: TARGET_URL, name: SESSION_COOKIE_NAME });
  if (!cookie) {
    setStatus(
      `${SESSION_COOKIE_NAME} Cookie が見つかりません。先に https://${TARGET_HOST}/ でログインしてから、もう一度押してください。`
    );
    return;
  }
  const enabled = true;
  await chrome.storage.local.set({ enabled, cookieValue: cookie.value });
  enabledEl.checked = enabled;
  await applyRule(enabled, cookie.value);
  setStatus(`保存して注入を有効化しました (${new Date().toLocaleString('ja-JP')})`);
});

enabledEl.addEventListener('change', async () => {
  const { cookieValue = '' } = await chrome.storage.local.get(['cookieValue']);
  const enabled = enabledEl.checked;
  await chrome.storage.local.set({ enabled });
  const applied = await applyRule(enabled, cookieValue);
  setStatus(applied ? '有効化しました。' : '無効化しました。');
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
