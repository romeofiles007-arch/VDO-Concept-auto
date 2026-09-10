// generate BRIDGE_TOKEN ใหม่ — node scripts/new-token.mjs
import { randomBytes } from 'node:crypto'
console.log(randomBytes(16).toString('hex'))
