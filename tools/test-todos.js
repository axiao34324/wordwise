// 待办数据层测试（不联网、不开窗口）
// 用法：npx electron tools/test-todos.js
//
// 为什么要用 electron 跑：lib/todos.js 依赖 app.getPath('userData')，
// 所以这里先把 userData 指到一个临时目录，再加载模块。

const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-todos-'))
app.setPath('userData', tmp)

const todos = require('../lib/todos')

let fails = 0
const ok = (t) => console.log('  ✓ ' + t)
const bad = (t) => { fails++; console.log('  ✗ ' + t) }
const eq = (got, want, t) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(t + ' = ' + JSON.stringify(got)) : bad(t + ' 期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got))

app.whenReady().then(() => {
  console.log('\n[1] 第一条：落到收件箱')
  const a = todos.add({ text: '场域是一个由位置关系构成的系统。', source: { app: 'chrome.exe' } })
  eq(a.added, true, '新增')
  eq(a.item.listId, 'inbox', '默认主题')
  eq(a.item.title, '场域是一个由位置关系构成的系统。', '标题取原文')
  eq(todos.countOpen(), 1, '未完成数')

  console.log('\n[2] 同一段文字再收一次：不堆条目，只记命中')
  const b = todos.add({ text: '场域是一个由位置关系构成的系统。\n\n', source: { app: 'chrome.exe', title: '某篇文章' } })
  eq(b.added, false, '不新增')
  eq(b.dup, true, '判为重复')
  eq(b.item.hit, 2, '命中次数')
  eq(todos.countOpen(), 1, '总数没变')
  eq(b.item.source.title, '某篇文章', '顺手补上了来源标题')

  console.log('\n[3] 首尾空白与换行差异不影响判重')
  const c = todos.add({ text: '  场域是一个由位置关系构成的系统。\r\n\t ' })
  eq(c.dup, true, '首尾空白不影响判重')

  console.log('\n[4] 不同内容各自成条')
  const d = todos.add({ text: '符号暴力：用支配者的范畴认识自己。', def: '布迪厄用语。' })
  eq(d.added, true, '新增')
  eq(d.item.def, '布迪厄用语。', '释义一起存下')
  eq(todos.countOpen(), 2, '未完成数')

  console.log('\n[5] 主题：新建并归类')
  const l = todos.addList('布迪厄')
  eq(!!l.id, true, '建出主题')
  todos.update(a.item.id, { listId: l.id })
  eq(todos.find(a.item.id).listId, l.id, '已归类')
  const grouped = todos.list({ filter: 'open' })
  eq(grouped.lists.length, 2, '主题数（收件箱 + 布迪厄）')
  eq(grouped.lists[0].id, 'inbox', '收件箱排第一')

  console.log('\n[6] 完成 / 归档 / 未完成过滤')
  todos.update(d.item.id, { state: 'done' })
  const s1 = todos.stats()
  eq(s1.open, 1, '未完成')
  eq(s1.done, 1, '已完成')
  eq(todos.list({ filter: 'done' }).items.length, 1, '已完成列表')
  eq(todos.list({ filter: 'open' }).items[0].id, a.item.id, '未完成只剩第一条')

  console.log('\n[7] 已归档的不参与判重（可以重新捡起来）')
  todos.update(d.item.id, { state: 'archived' })
  const again = todos.add({ text: '符号暴力：用支配者的范畴认识自己。' })
  eq(again.added, true, '归档后同样的文字可再收一次')
  eq(todos.stats().archived, 1, '归档数')

  console.log('\n[8] 搜索：标题 / 正文 / 备注 / 来源都能命中')
  todos.update(a.item.id, { note: '跟上次那篇讲惯习的一起看' })
  eq(todos.list({ filter: 'all', q: '惯习' }).items.length, 1, '命中备注')
  eq(todos.list({ filter: 'all', q: '某篇文章' }).items.length, 1, '命中来源标题')
  eq(todos.list({ filter: 'all', q: '场域' }).items.length, 1, '命中正文')
  eq(todos.list({ filter: 'all', q: '不存在的词' }).items.length, 0, '无结果')

  console.log('\n[9] 标题可改，改空则回退到原文')
  todos.update(a.item.id, { title: '场域 = 位置关系' })
  eq(todos.find(a.item.id).title, '场域 = 位置关系', '改标题')
  todos.update(a.item.id, { title: '   ' })
  eq(todos.find(a.item.id).title.startsWith('场域是一个'), true, '空标题回退')

  console.log('\n[10] 导出 Markdown')
  const md = todos.toMarkdown()
  eq(md.includes('# WordWise 待办'), true, '有总标题')
  eq(md.includes('## 布迪厄'), true, '有主题小节')
  eq(md.includes('- [ ] 场域'), true, '未完成用 [ ]')
  eq(md.includes('来源：chrome.exe'), true, '带来源')
  eq(md.includes('## 已归档'), true, '归档单独一节')

  console.log('\n[11] 清理归档：只删归档，已完成的保留')
  const keep = todos.add({ text: '这条要留着当"读过的证据"：注意力经济那期播客' })
  todos.update(keep.item.id, { state: 'done' })
  const archivedBefore = todos.stats().archived
  const doneBefore = todos.stats().done
  const removed = todos.purgeArchived()
  eq(removed, archivedBefore, '清掉的条数 = 归档条数')
  eq(todos.stats().archived, 0, '归档清零')
  eq(todos.stats().done, doneBefore, '已完成的一条都没少')
  eq(todos.find(keep.item.id) !== null, true, '已完成条目仍在库里')

  console.log('\n[12] 删除主题：条目退回收件箱，不丢数据')
  const openBefore = todos.countOpen()
  todos.removeList(l.id)
  eq(todos.find(a.item.id).listId, 'inbox', '退回收件箱')
  eq(todos.countOpen(), openBefore, '条目数没变')
  eq(todos.list({ filter: 'all' }).lists.length, 1, '只剩收件箱')

  console.log('\n[13] 删除单条')
  todos.remove(a.item.id)
  eq(todos.find(a.item.id), null, '已删除')

  console.log('\n[14] 重新读盘：写入的内容能持久化')
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'todos.json'), 'utf8'))
  eq(Array.isArray(raw.items), true, '文件结构正确')
  eq(raw.items.length, todos.stats().total, '条数一致')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\n结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败'))
  app.exit(fails === 0 ? 0 : 1)
})
