const $ = (id) => document.getElementById(id)

async function load() {
  const { port = 8765, token = '', enabled = false, status = '—' } = await chrome.storage.local.get(['port', 'token', 'enabled', 'status'])
  $('port').value = port
  $('token').value = token
  $('enabled').checked = enabled
  $('status').textContent = status
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    port: Number($('port').value),
    token: $('token').value.trim(),
    enabled: $('enabled').checked,
  })
  $('status').textContent = 'กำลังเชื่อมต่อ...'
  await chrome.runtime.sendMessage({ type: 'WAKE' })
  setTimeout(load, 1200)
})

// อัปเดตสถานะสดขณะเปิด popup ค้างไว้
chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) $('status').textContent = changes.status.newValue
})

load()
