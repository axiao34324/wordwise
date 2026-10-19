const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const MAX_ENTRIES = 500
let map = new Map()

function file() {
  return path.join(app.getPath('userData'), 'cache.json')
}

function load() {
  try {
    map = new Map(JSON.parse(fs.readFileSync(file(), 'utf8')))
  } catch {
    map = new Map()
  }
}

function get(key) {
  const v = map.get(key)
  if (v) {
    map.delete(key)
    map.set(key, v)
  }
  return v
}

function set(key, result) {
  map.set(key, { v: result, t: Date.now() })
  if (map.size > MAX_ENTRIES) {
    map.delete(map.keys().next().value)
  }
  persist()
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify([...map]))
  } catch (e) {
    console.error('cache persist failed:', e)
  }
}

module.exports = { load, get, set }
