import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const clientId = process.env.SUMSUB_CLIENT_ID;
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const has = name => args.includes(name);
const base = path.dirname(fileURLToPath(import.meta.url));
const workbooks = fs.readdirSync(base).filter(name => name.endsWith('.xlsx') && !name.startsWith('~$'));
const input = option('--input', workbooks.length === 1 ? path.join(base, workbooks[0]) : null);
if (!input) throw new Error(`Found ${workbooks.length} Excel workbooks. Specify one with --input /absolute/path/file.xlsx`);
const sheet = option('--sheet', '__FIRST__');
// Scope resume data to this exact workbook version and selected worksheet.
// A different Excel file must not inherit completion records merely because UIDs overlap.
const sourceId = createHash('sha256').update(fs.readFileSync(input)).update('\0' + sheet).digest('hex');
const startRow = Number(option('--start-row', '2'));
const limit = Number(option('--limit', '0'));
const dryRun = has('--dry-run');
const verifyOnly = has('--verify-only');
const resultsPath = path.join(base, 'results.jsonl');
const detailsPath = path.join(base, 'results-detailed.csv');
const profile = path.join(base, 'chrome-profile');
const python = spawnSync('python3', [path.join(base, 'read_uids.py'), input, sheet], { encoding: 'utf8' });
if (python.status !== 0) throw new Error(python.stderr || python.stdout);
const all = JSON.parse(python.stdout).filter(x => x.row >= startRow);
const sourceUids = new Set(all.map(x => x.uid));
const completed = new Set();
const latestResults = new Map();
const completedStatuses = new Set(['requested', 'skipped_status', 'skipped_approved', 'skipped_pending', 'not_found']);
if (fs.existsSync(resultsPath)) {
  for (const line of fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean)) {
    try {
      const result = JSON.parse(line);
      if (result.sourceId !== sourceId || !sourceUids.has(result.uid)) continue;
      latestResults.set(result.uid, result);
    } catch {}
  }
}
for (const [uid, result] of latestResults) {
  if (completedStatuses.has(result.status)) completed.add(uid);
}
function errorCategory(reason) {
  const first = String(reason || '未知原因').split('\n')[0];
  if (/Page crashed/i.test(first)) return '浏览器页面崩溃';
  if (/Target page, context or browser has been closed/i.test(first)) return '浏览器已关闭';
  if (/net::ERR_([A-Z_]+)/i.test(first)) return `网络 ${first.match(/net::ERR_([A-Z_]+)/i)[1]}`;
  if (/page\.goto: Timeout/i.test(first)) return '打开页面超时';
  if (/locator\.waitFor: Timeout/i.test(first)) return '等待页面元素超时';
  return first.replace(/https?:\/\/\S+/g, 'URL').slice(0, 80);
}
function resultCategory(result) {
  if (result.status === 'requested') return '重新提交成功';
  if (result.status === 'not_found') return '未找到申请';
  if (result.status === 'error') return `异常：${errorCategory(result.reason)}`;
  if (result.status === 'skipped_approved') return 'Approved';
  if (result.status === 'skipped_pending') return 'Pending';
  if (result.status === 'skipped_status') return result.initialStatus || '其他状态';
  return null;
}
const cumulative = new Map();
function addCategory(category, delta) {
  if (!category) return;
  cumulative.set(category, (cumulative.get(category) || 0) + delta);
  if (cumulative.get(category) <= 0) cumulative.delete(category);
}
for (const result of latestResults.values()) addCategory(resultCategory(result), 1);
function cumulativeSummary() {
  return [...cumulative].sort((a,b) => a[0].localeCompare(b[0])).map(([name,n]) => `${name} ${n}`).join('，') || '暂无';
}
const pending = all.filter(x => !completed.has(x.uid));
const queue = limit > 0 ? pending.slice(0, limit) : pending;
const previouslyCompleted = completed.size;
console.log(`表格 ${path.basename(input)}（版本 ${sourceId.slice(0, 8)}） ${all.length} 条｜此表已完成 ${previouslyCompleted} 条｜本次待处理 ${queue.length} 条`);
console.log('累计状态：' + cumulativeSummary());
if (dryRun || queue.length === 0) process.exit(0);
if (!clientId) throw new Error('Set SUMSUB_CLIENT_ID before running.');

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
const runLock = path.join(base, '.request-check.running');
if (fs.existsSync(runLock)) {
  let previousPid = 0;
  try { previousPid = JSON.parse(fs.readFileSync(runLock, 'utf8')).pid; } catch {}
  if (processIsAlive(previousPid)) {
    console.error(`已有自动化进程（PID ${previousPid}）正在运行；请继续使用原来的终端窗口，不要重复启动。`);
    process.exit(1);
  }
  fs.unlinkSync(runLock);
}
const lockContent = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
try { fs.writeFileSync(runLock, lockContent, { flag: 'wx' }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('另一个自动化进程正在启动；请继续使用原来的终端窗口。');
  process.exit(1);
}
process.on('exit', () => {
  try { if (fs.readFileSync(runLock, 'utf8') === lockContent) fs.unlinkSync(runLock); } catch {}
});
const chromeLock = path.join(profile, 'SingletonLock');
let chromePid = 0;
try { chromePid = Number(fs.readlinkSync(chromeLock).match(/-(\d+)$/)?.[1]); } catch {}
if (processIsAlive(chromePid)) {
  console.error(`专用 Chrome 窗口（PID ${chromePid}）仍在占用浏览器配置。请先使用原来的运行窗口；如已停止运行，请关闭该 Chrome 窗口后重试。`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: false, viewport: null, slowMo: 100,
  args: ['--start-maximized', '--no-first-run'],
});
const openPages = context.pages();
const page = openPages[0] || await context.newPage();
for (const extra of openPages.slice(1)) await extra.close();
const listUrl = uid => {
  const url = new URL('https://cockpit.sumsub.com/checkus/applicants/individual');
  url.searchParams.set('clientId', clientId);
  url.searchParams.set('limit', '25');
  url.searchParams.set('offset', '0');
  url.searchParams.set('search', uid);
  return url.toString();
};
await page.goto(listUrl(queue[0].uid), { waitUntil: 'domcontentloaded' });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question(`请在打开的 Chrome 窗口登录 Sumsub，确认账户为 ${clientId}，然后回到这里按回车开始：`);
rl.close();
await page.goto(listUrl(queue[0].uid), { waitUntil: 'domcontentloaded' });
try { await page.getByRole('textbox', { name: 'Table search' }).waitFor({ state: 'visible', timeout: 30000 }); }
catch { throw new Error('登录尚未完成，或申请人列表未加载；本次未处理任何 UID'); }
if (!await page.getByText(clientId, { exact: true }).count()) {
  throw new Error(`Sumsub 当前账户不是 ${clientId}；本次未处理任何 UID`);
}
console.log('已登录，开始逐条处理；全程复用当前 Chrome 标签页。');

const startedAt = Date.now();
let stopping = false;
process.on('SIGINT', () => { stopping = true; process.stdout.write('\n已收到停止指令，正在结束当前操作。\n'); });
const counts = { done: 0, requested: 0, skipped_status: 0, not_found: 0, error: 0, verified: 0 };
let currentUid = '';
let currentInitialStatus = '';
function elapsedTime() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(x => String(x).padStart(2, '0')).join(':');
}
function progressLine() {
  const checked = previouslyCompleted + counts.done;
  const percent = all.length ? (checked / all.length * 100).toFixed(1) : '100.0';
  return `[${checked}/${all.length} ${percent}% | 已运行 ${elapsedTime()}] UID ${currentUid}${currentInitialStatus ? ` | 初始 ${currentInitialStatus}` : ''}`;
}
function progress() {
  if (!process.stdout.isTTY) return;
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(progressLine());
}
function log(record) {
  const final = { time: new Date().toISOString(), sourceId, sheet, ...record, url: record.url || (page.isClosed() ? '' : page.url()) };
  fs.appendFileSync(resultsPath, JSON.stringify(final) + '\n');
  const columns = ['time','uid','row','initialStatus','viewFilesDone','viewFilesReason','setActiveDone','setActiveReason','requestClicked','requestReason','finalStatus','status','reason','url'];
  const csv = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  if (!fs.existsSync(detailsPath)) fs.writeFileSync(detailsPath, columns.join(',') + '\n');
  fs.appendFileSync(detailsPath, columns.map(key => csv(final[key])).join(',') + '\n');
  counts.done++;
  if (record.status in counts) counts[record.status]++;
  addCategory(resultCategory(latestResults.get(record.uid) || {}), -1);
  latestResults.set(record.uid, record);
  addCategory(resultCategory(record), 1);
  currentInitialStatus = record.initialStatus || '';
  const labels = { requested: '已提交', skipped_status: `跳过：${record.initialStatus}`, not_found: '未找到申请', error: '异常（见明细 CSV）', verified: '仅核对' };
  if (process.stdout.isTTY) progress();
  else process.stdout.write(progressLine());
  process.stdout.write(` → ${labels[record.status] || record.status} | 累计：${cumulativeSummary()}\n`);
}
async function applicantStatus() {
  const status = page.getByRole('status', { name: 'Applicant status', exact: true });
  await status.waitFor({ state: 'visible', timeout: 10000 });
  return (await status.innerText()).trim().replace(/\s*\([^)]*\).*/, '').trim();
}
async function waitForStatusChange(initialStatus, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await applicantStatus();
    if (status && status.toLowerCase() !== initialStatus.toLowerCase()) return status;
    await page.waitForTimeout(300);
  }
  return null;
}
async function visible(locator, timeout = 1500) {
  try { await locator.first().waitFor({ state: 'visible', timeout }); return true; } catch { return false; }
}
async function runOne(record) {
  const { uid, row } = record;
  currentUid = uid;
  currentInitialStatus = '';
  progress('搜索 UID');
  await page.goto(listUrl(uid), { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (/login|signin|auth/i.test(page.url())) throw new Error('Session expired; log in and rerun');
  try { await page.getByRole('textbox', { name: 'Table search' }).waitFor({ state: 'visible', timeout: 10000 }); }
  catch (error) {
    if (/login|signin|auth/i.test(page.url())) throw new Error('Session expired; log in and rerun');
    throw error;
  }
  const resultLink = page.locator('a[href^="/checkus/applicant/"]').first();
  let searchOutcome;
  try {
    const outcomeHandle = await page.waitForFunction(() => {
      const link = [...document.querySelectorAll('a[href^="/checkus/applicant/"]')]
        .find(element => element.getClientRects().length > 0);
      if (link) return 'found';
      if (document.body?.innerText.includes('No results found')) return 'not_found';
      return null;
    }, null, { polling: 100, timeout: 10000 });
    searchOutcome = await outcomeHandle.jsonValue();
    await outcomeHandle.dispose();
  } catch {
    throw new Error('Search results did not load within 10 seconds');
  }
  if (searchOutcome === 'not_found') {
    // Let a briefly rendered empty state settle before recording a final result.
    await page.waitForTimeout(300);
    if (await visible(resultLink, 200)) searchOutcome = 'found';
  }
  if (searchOutcome === 'not_found') {
    if (!await visible(page.getByText('No results found', { exact: true }), 200)) {
      throw new Error('Search result disappeared before it could be confirmed');
    }
    record.status = 'not_found';
    record.reason = '搜索页面显示 No results found，未找到申请';
    record.viewFilesReason = '未找到申请，未执行';
    record.setActiveReason = '未找到申请，未执行';
    record.requestReason = '未找到申请，未点击';
    log(record);
    return;
  }
  if (!await visible(resultLink, 1000)) throw new Error('Applicant link disappeared before it could be opened');
  const matches = await page.locator('a[href^="/checkus/applicant/"]').evaluateAll(links =>
    links.map(link => ({
      href: link.getAttribute('href'),
      text: (link.closest('tr, [role="row"]') || link.parentElement?.parentElement || link).innerText || '',
    })).filter(item => item.href));
  const hrefs = [...new Set(matches.map(item => item.href))];
  if (hrefs.length !== 1) throw new Error(`Search returned ${hrefs.length} applicants; exact match cannot be confirmed`);
  const href = hrefs[0];
  const uidInResult = new RegExp(`(?:^|\\D)${uid}(?:\\D|$)`).test(matches.map(item => item.text).join('\n'));
  progress('打开详情，核对 UID');
  await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded' });
  if (!page.url().includes('/checkus/applicant/')) throw new Error('Applicant detail did not open');
  if (!uidInResult) {
    const copyExternalId = page.getByRole('button', { name: 'Copy external id' });
    if (!await visible(copyExternalId, 20000)) throw new Error('Full UID not visible in search result; External ID verification button unavailable');
    await copyExternalId.click();
    let actualUid = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      const copied = spawnSync('pbpaste', [], { encoding: 'utf8' });
      if (copied.status !== 0) throw new Error('Could not read copied External ID');
      actualUid = copied.stdout.trim();
      if (actualUid === uid) break;
      await page.waitForTimeout(100);
    }
    if (actualUid !== uid) throw new Error(`External ID mismatch: expected ${uid}, found ${actualUid}`);
  }
  record.initialStatus = await applicantStatus();
  record.finalStatus = record.initialStatus;
  currentInitialStatus = record.initialStatus;
  progress(`初始状态 ${record.initialStatus}`);
  if (verifyOnly) { record.status = 'verified'; record.reason = '仅核对 UID 和初始状态'; log(record); return; }
  if (!/^Documents requested$/i.test(record.initialStatus)) {
    record.status = 'skipped_status';
    record.reason = `初始状态是 ${record.initialStatus}，仅 Documents requested 需要处理`;
    record.viewFilesReason = record.reason;
    record.setActiveReason = record.reason;
    record.requestReason = record.reason;
    log(record);
    return;
  }
  const verification = page.getByRole('tab', { name: /Verification/i });
  if (await visible(verification, 3000)) await verification.click();
  const files = page.getByRole('button', { name: /View files/i }).first();
  if (await visible(files, 2500)) {
    progress('打开 View files');
    await files.click();
    const fileDialog = page.getByRole('dialog', { name: /Files/i });
    if (!await visible(fileDialog, 4000)) throw new Error('View files panel did not open');
    record.viewFilesDone = true;
    record.viewFilesReason = '已打开 Files 面板';
    const activate = fileDialog.getByText('Set as active', { exact: true });
    if (await visible(activate, 3000)) {
      const cards = fileDialog.getByRole('group', { name: 'Document image' });
      let card = null;
      for (let i = 0; i < await cards.count(); i++) {
        if (await cards.nth(i).getByText('Set as active', { exact: true }).count()) {
          card = cards.nth(i);
          break;
        }
      }
      if (!card) throw new Error('Cannot identify the file to activate');
      progress('Set as active，等待激活');
      await activate.first().click();
      const activationError = page.getByRole('alert');
      if (await visible(activationError, 500)) {
        throw new Error((await activationError.first().innerText()).slice(0, 250));
      }
      if (!await visible(card.getByText('Active', { exact: true }), 5000)) {
        throw new Error('Set as active was clicked, but Active status was not confirmed');
      }
      record.setActiveDone = true;
      record.setActiveReason = '文件显示 Active';
    } else {
      const fileCount = await fileDialog.getByText('Inactive', { exact: true }).count();
      if (fileCount) throw new Error('Inactive file exists but Set as active is unavailable');
      record.setActiveReason = '没有 Set as active，文件已是 Active 或无需激活';
    }
    const close = fileDialog.getByRole('button', { name: /Close button/i });
    if (!await visible(close, 1500)) throw new Error('Cannot close View files panel');
    await close.click();
    await fileDialog.waitFor({ state: 'hidden', timeout: 3000 });
  } else {
    record.viewFilesReason = '页面没有 View files 按钮，按要求直接 Request check';
    record.setActiveReason = '没有 View files，无法执行 Set as active';
  }
  record.finalStatus = await applicantStatus();
  if (!/^Documents requested$/i.test(record.finalStatus)) {
    record.status = 'skipped_status';
    record.reason = `点击 Request check 前状态已变为 ${record.finalStatus}`;
    record.requestReason = record.reason;
    log(record);
    return;
  }
  progress('Request check');
  const request = page.getByRole('button', { name: /^Request check$/i });
  if (!await visible(request, 5000)) throw new Error('Request check button unavailable');
  await request.click();
  record.requestClicked = true;
  record.requestReason = '已点击 Request check';
  const dialog = page.getByRole('dialog');
  if (await visible(dialog, 1200)) {
    const confirm = dialog.getByRole('button', { name: /^(Request check|Confirm|Request)$/i });
    if (!await visible(confirm, 1500)) throw new Error('Request check dialog needs manual input');
    await confirm.click();
  }
  const resultingStatus = await waitForStatusChange(record.initialStatus);
  if (resultingStatus) {
    record.finalStatus = resultingStatus;
    record.status = 'requested';
    record.reason = `点击后状态由 ${record.initialStatus} 变为 ${resultingStatus}`;
    log(record);
    return;
  }
  const error = page.getByRole('alert');
  if (await visible(error, 500)) throw new Error((await error.first().innerText()).slice(0, 250));
  throw new Error('已点击 Request check，但状态仍是 Documents requested');
}

for (const item of queue) {
  if (stopping || page.isClosed()) break;
  const record = { ...item, initialStatus: '', viewFilesDone: false, viewFilesReason: '', setActiveDone: false, setActiveReason: '', requestClicked: false, requestReason: '', finalStatus: '', status: '', reason: '' };
  try { await runOne(record); }
  catch (error) {
    const reason = String(error.message || error).slice(0, 500);
    if (stopping || page.isClosed() || /Target page, context or browser has been closed|Session expired/i.test(reason)) {
      console.log(`运行已停止：${reason.split('\n')[0]}`);
      break;
    }
    record.status = 'error';
    record.reason = reason;
    if (!record.viewFilesReason) record.viewFilesReason = record.viewFilesDone ? '已打开' : `未执行：${reason.split('\n')[0]}`;
    if (!record.setActiveReason) record.setActiveReason = record.setActiveDone ? '已激活' : `未完成：${reason.split('\n')[0]}`;
    if (!record.requestReason) record.requestReason = record.requestClicked ? '已点击，等待状态变化时出错' : `未点击：${reason.split('\n')[0]}`;
    if (record.initialStatus) {
      try { record.finalStatus = await applicantStatus(); } catch {}
    }
    if (record.requestClicked && record.finalStatus && record.finalStatus.toLowerCase() !== record.initialStatus.toLowerCase()) {
      record.status = 'requested';
      record.reason = `点击后状态由 ${record.initialStatus} 变为 ${record.finalStatus}`;
    }
    log(record);
    if (/Page crashed/i.test(reason)) {
      console.log('浏览器页面崩溃，已停止本次运行；重新打开可从未完成的 UID 继续。');
      break;
    }
    continue;
  }
  if (stopping) break;
  if (record.status !== 'not_found') await page.waitForTimeout(800);
}
console.log(`本次结束：本次检查 ${counts.done}/${queue.length} 条，已运行 ${elapsedTime()}。逐条明细在 results-detailed.csv。`);
console.log('累计状态：' + cumulativeSummary());
if (!page.isClosed()) await context.close();
