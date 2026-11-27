#!/usr/bin/env node
/**
 * ฝั่งเครื่องผลิต (24hrs) ของคิวพากย์ข้ามเครื่อง — scripts/tts-worker.mjs บนเครื่องการ์ดจอแรงเรียกผ่าน SSH
 * ผลทุกคำสั่งพิมพ์เป็น JSON บรรทัดเดียว · ข้อมูลขาเข้า (ไฟล์เสียง/ข้อความ error) ส่งทาง stdin ไม่ต้องห่วงเรื่อง quote
 *
 *   node scripts/tts-queue.mjs poll <worker> [gpu]     แจ้งว่าออนไลน์ + รับงานถัดไป → {job, refWav(base64)} | {job:null}
 *   node scripts/tts-queue.mjs heartbeat <worker> [jobId]
 *   node scripts/tts-queue.mjs progress <id> <done> <total>
 *   node scripts/tts-queue.mjs finish <id> <worker>  < {"files":{"0000.wav":"<base64>"}}
 *   node scripts/tts-queue.mjs fail <id> <worker>    < ข้อความ error
 *   node scripts/tts-queue.mjs status
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { claimNext, heartbeat, writeProgress, finishJob, failJob, workerStatus, jobState, QUEUE_DIR } from '../pipeline/lib/tts_queue.mjs'

const [cmd, ...args] = process.argv.slice(2)
const stdin = () => readFileSync(0)
const out = (data) => process.stdout.write(JSON.stringify(data) + '\n')

try {
  if (cmd === 'poll') {
    const got = claimNext(args[0], { gpu: args[1] ?? null })
    out(got ? { job: got.job, refWav: readFileSync(got.refWav).toString('base64') } : { job: null })
  } else if (cmd === 'heartbeat') {
    heartbeat(args[0], { busy: args[1] ?? null })
    out({ ok: true })
  } else if (cmd === 'progress') {
    writeProgress(args[0], Number(args[1]), Number(args[2]))
    out({ ok: true })
  } else if (cmd === 'finish') {
    const { files = {}, seconds } = JSON.parse(stdin().toString('utf8'))
    finishJob(args[0], Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v, 'base64')])), { worker: args[1], seconds })
    out({ ok: true })
  } else if (cmd === 'fail') {
    failJob(args[0], stdin().toString('utf8').trim() || 'พากย์ไม่สำเร็จ', args[1])
    out({ ok: true })
  } else if (cmd === 'status') {
    const jobs = existsSync(QUEUE_DIR) ? readdirSync(QUEUE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ id: d.name, ...jobState(d.name) })) : []
    out({ worker: workerStatus(), jobs })
  } else {
    throw new Error(`ไม่รู้จักคำสั่ง ${cmd ?? ''} (poll | heartbeat | progress | finish | fail | status)`)
  }
} catch (err) {
  out({ error: err.message })
  process.exit(1)
}
