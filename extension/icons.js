// Decorative icons always accompany a visible action label.
const PREFIX = /^(?:▶|■|🎬|📂|🔊|⬇|←|✎|✏️|🗑|✕|✓)\s*/u

export function setIconLabel(element, name, label) {
  element.dataset.icon = name
  element.textContent = label.replace(PREFIX, '').replace(/\s*→$/, '')
}

export function icon(name, className = '') {
  const span = document.createElement('span')
  span.className = `ui-icon icon-${name} ${className}`
  span.setAttribute('aria-hidden', 'true')
  return span
}

export function initIcons(root = document) {
  const groups = {
    idea: '#askTopics', script: '#askScript', mic: '#startVoice, [data-run="tts"]',
    shots: '#startShots, #resumeShots, [data-run="shotlist"]',
    image: '#startFlow, [data-run="images"]', video: '#startRender, [data-run="render"], #openLibrary, #videoModalLibrary, #libraryTitle',
    folder: '#openProjects, #videoModalReveal', listen: '#previewVoice',
    copy: '#copyScript, #copyFlow', download: '#downloadScript, #downloadFlow, #saveFlowImages',
    save: '#saveGeminiKey, #saveTranscript, #saveRefText', upload: '.filebtn, label.ghost',
    back: '#backFromApp, #closeLibrary', external: '#showFlowTab, #openLocal',
    settings: '#startTrain, #setupTts', clock: '[data-run="timecode"]',
    stop: '.stop, [data-stop]', close: '#cancelTopics, #cancelScript, #videoModalClose',
    trash: '#bgmRemove', check: '#successMark', next: '[data-goto]'
  }
  for (const [name, selector] of Object.entries(groups)) {
    root.querySelectorAll(selector).forEach(element => {
      element.dataset.icon = name
      // Keep child inputs and existing event targets intact.
      for (const node of element.childNodes) {
        if (node.nodeType === 3) node.textContent = node.textContent.replace(PREFIX, '').replace(/\s*→$/, '')
      }
    })
  }
  // หัวขั้นในแผงข้างใช้เลขขั้นแทนไอคอน — เดิมไล่ไอคอนตามลำดับ h2 แล้วเลื่อนไปหนึ่งช่องเพราะกล่องทำคลิปอัตโนมัติ
  root.querySelectorAll('.panel > h1').forEach((heading, index) => {
    const names = root.querySelector('.panel')
      ? ['idea', 'script', 'mic', 'clock', 'shots', 'image', 'video']
      : ['idea', 'script', 'mic', 'shots', 'image', 'video', 'settings']
    if (names[index]) heading.dataset.icon = names[index]
  })
}
