import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { animateWithKie, KIE_MODEL } from '../pipeline/lib/kie.mjs'
import { clipSettings } from '../pipeline/lib/clips.mjs'

const oldKey = process.env.KIE_API_KEY
process.env.KIE_API_KEY = 'test-key-not-sent-to-real-api'
const dir = mkdtempSync(join(tmpdir(), 'kie-test-'))
const imageFile = join(dir, 'shot.png')
const outFile = join(dir, 'shot.mp4')
const taskFile = join(dir, 'shot.kie.json')
writeFileSync(imageFile, Buffer.from('mock-image'))
let uploads = 0
let creates = 0
let polls = 0
const fakeFetch = async (url, options = {}) => {
  const ok = (data) => ({ ok: true, json: async () => data })
  if (url.includes('file-stream-upload')) {
    uploads++
    assert.equal(options.body.get('file').name, 'shot.png')
    return ok({ code: 200, data: { downloadUrl: 'https://tempfile.redpandaai.co/test/shot.png' } })
  }
  if (url.endsWith('/createTask')) {
    creates++
    const body = JSON.parse(options.body)
    assert.equal(body.model, KIE_MODEL)
    assert.equal(body.input.resolution, '480p')
    assert.equal(body.input.duration, 5)
    assert.equal(body.input.fixed_lens, true)
    assert.equal(body.input.generate_audio, false)
    assert.deepEqual(body.input.input_urls, ['https://tempfile.redpandaai.co/test/shot.png'])
    return ok({ code: 200, data: { taskId: 'task_test_1' } })
  }
  if (url.includes('/recordInfo')) {
    polls++
    return ok({ code: 200, data: { state: polls === 1 ? 'generating' : 'success', resultJson: JSON.stringify({ resultUrls: ['https://kie.example/shot.mp4'] }) } })
  }
  if (url === 'https://kie.example/shot.mp4') return { ok: true, arrayBuffer: async () => Buffer.alloc(25_000, 1) }
  throw new Error(`Unexpected URL ${url}`)
}

try {
  assert.equal(clipSettings({ clips: { provider: 'off' } }).enabled, false)
  assert.equal(clipSettings({ clips: { provider: 'kie', coveragePercent: 20 } }).enabled, true)
  assert.equal(clipSettings({ clips: { provider: 'meta-ai' } }).enabled, false)
  await animateWithKie({ imageFile, outFile, taskFile, prompt: 'ขยับเบาๆ', fetchImpl: fakeFetch, pollMs: 0 })
  assert.equal(readFileSync(outFile).length, 25_000)
  assert.equal(JSON.parse(readFileSync(taskFile)).taskId, 'task_test_1')
  assert.equal(uploads, 1)
  assert.equal(creates, 1)

  // งานที่สร้างไว้แล้วต้องไม่ส่งคำขอที่เสียเครดิตซ้ำ
  await animateWithKie({ imageFile, outFile, taskFile, prompt: 'ขยับเบาๆ', fetchImpl: fakeFetch, pollMs: 0 })
  assert.equal(uploads, 1)
  assert.equal(creates, 1)
  console.log('Kie mock: upload → create → poll → download และ resume ผ่าน')
} finally {
  rmSync(dir, { recursive: true, force: true })
  if (oldKey === undefined) delete process.env.KIE_API_KEY
  else process.env.KIE_API_KEY = oldKey
}
