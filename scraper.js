/**
 * IPTV TXT 接口自动抓取脚本 v7
 * puppeteer-extra + stealth 绕过 Cloudflare
 * 直接从首页获取token，构造TXT接口链接
 * 用Puppeteer访问TXT链接验证内容包含频道地址
 * 如果频道数为0则跳过该IP，尝试下一个
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CF_ACCOUNT_ID = '13992e7b764637d462d3cf98f3a20086';
const CF_NAMESPACE_ID = '5a49325bf26b4106a0f497a6403a063d';
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== IPTV TXT 接口抓取开始 ===');
  console.log('时间:', new Date().toISOString());

  let browser;
  try {
    console.log('[1/6] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 180000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);

    console.log('[2/6] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('加载完成, URL:', page.url());

    console.log('[3/6] 等待 Cloudflare 验证...');
    await waitForCF(page);
    console.log('CF 验证已通过');

    // 查找所有IP（优先新上线）
    console.log('[4/6] 查找可用IP...');
    const allIPs = await findAllIPs(page);
    if (allIPs.length === 0) throw new Error('未找到任何IP');
    console.log(`找到 ${allIPs.length} 个IP`);

    // 逐个尝试，找到有频道的IP
    let bestResult = null;
    for (let i = 0; i < Math.min(allIPs.length, 10); i++) {
      const ipInfo = allIPs[i];
      if (!ipInfo.token) {
        console.log(`  #${i+1} ${ipInfo.ip}: 无token，跳过`);
        continue;
      }
      const txtUrl = `http://iptv.cqshushu.com/index.php?s=${ipInfo.token}&t=multicast&channels=1&format=txt`;
      console.log(`  #${i+1} ${ipInfo.ip} (${ipInfo.status}): 验证TXT...`);

      const channelCount = await verifyTxtContent(page, txtUrl);
      console.log(`  #${i+1} ${ipInfo.ip}: ${channelCount} 个频道`);

      if (channelCount > 0) {
        bestResult = { txtUrl, ip: ipInfo.ip, channelCount, status: ipInfo.status };
        console.log(`找到有效IP: ${ipInfo.ip}, ${channelCount} 个频道`);
        break;
      }
    }

    if (!bestResult) {
      // 如果所有IP都没有频道，使用第一个有token的IP（可能暂时不可用）
      const fallback = allIPs.find(ip => ip.token);
      if (fallback) {
        const txtUrl = `http://iptv.cqshushu.com/index.php?s=${fallback.token}&t=multicast&channels=1&format=txt`;
        bestResult = { txtUrl, ip: fallback.ip, channelCount: 0, status: fallback.status };
        console.log('警告: 所有IP频道数为0，使用第一个:', fallback.ip);
      } else {
        throw new Error('所有IP均无有效token和频道');
      }
    }

    console.log('[5/6] 最终TXT链接:', bestResult.txtUrl);
    console.log(`  IP: ${bestResult.ip}, 频道数: ${bestResult.channelCount}`);

    // 保存KV
    console.log('[6/6] 保存KV...');
    await saveKV(bestResult.txtUrl, bestResult.ip, bestResult.channelCount);
    console.log('=== 成功 ===');

  } catch (error) {
    console.error('失败:', error.message);
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
        method: 'PUT', headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
        body: new Date().toISOString() + ': ' + error.message
      });
    } catch(e) {}
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

// 提取所有IP信息
function extractAllIPsCode() {
  return () => {
    const tables = document.querySelectorAll('table');
    if (tables.length < 2) return [];
    const rows = tables[1].querySelectorAll('tbody tr');
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length < 1) continue;
      const a = cells[0].querySelector('a');
      if (!a) continue;
      const ip = a.textContent.trim();
      const onclick = a.getAttribute('onclick') || '';
      const m = onclick.match(/gotoIP\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/) || onclick.match(/gotoIP\(([^,]+),\s*([^)]+)\)/);
      let token = null, type = 'multicast';
      if (m) { token = m[1]; type = m[2]; }
      const status = cells.length >= 6 ? cells[5].textContent.trim() : '';
      results.push({ ip, token, type, status });
    }
    return results;
  };
}

async function findAllIPs(page) {
  // 先收集第1页的IP
  let allIPs = await page.evaluate(extractAllIPsCode());
  console.log(`第1页: ${allIPs.length} 个IP`);

  // 翻页收集更多IP
  for (let p = 2; p <= 3; p++) {
    console.log(`翻第${p}页...`);
    const clicked = await page.evaluate((pn) => {
      for (const l of document.querySelectorAll('a')) { if (l.textContent.trim() === String(pn)) { l.click(); return true; } }
      for (const l of document.querySelectorAll('a')) { if (l.textContent.includes('下一页')) { l.click(); return true; } }
      return false;
    }, p);
    if (!clicked) break;
    await sleep(3000);
    const pageIPs = await page.evaluate(extractAllIPsCode());
    console.log(`第${p}页: ${pageIPs.length} 个IP`);
    allIPs = allIPs.concat(pageIPs);
  }

  // 排序：新上线优先，然后有token的优先
  allIPs.sort((a, b) => {
    if (a.status === '新上线' && b.status !== '新上线') return -1;
    if (a.status !== '新上线' && b.status === '新上线') return 1;
    if (a.token && !b.token) return -1;
    if (!a.token && b.token) return 1;
    return 0;
  });

  return allIPs;
}

// 在同一个page中验证TXT链接内容（保持session cookie）
async function verifyTxtContent(page, txtUrl) {
  try {
    await page.goto(txtUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch(e) {
    console.log('  页面加载超时，尝试继续...');
  }
  await sleep(3000);

  const txtContent = await page.evaluate(() => document.body?.innerText || '');
  if (!txtContent || txtContent.length < 10) return 0;

  // 统计频道地址数量
  const channelCount = (txtContent.match(/http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g) || []).length;

  // 也检查节目数量字段
  const countMatch = txtContent.match(/#节目数量[：:]\s*(\d+)/);
  if (countMatch) {
    const declaredCount = parseInt(countMatch[1]);
    console.log(`  页面声明节目数量: ${declaredCount}`);
    return Math.max(channelCount, declaredCount);
  }

  return channelCount;
}

async function waitForCF(page) {
  for (let i = 0; i < 30; i++) {
    const info = await page.evaluate(() => ({ t: document.body?.innerText?.substring(0,100)||'', n: document.querySelectorAll('table').length }));
    if (info.n >= 2) return;
    if (info.t.includes('请稍候') || info.t.includes('Just a moment') || info.t.includes('Checking')) {
      if (i%5===0) console.log(`  CF验证... (${i+1}/30)`);
      await sleep(3000);
      try { for (let j=0;j<3;j++) { await page.mouse.move(Math.random()*1920,Math.random()*1080); await sleep(200); } await page.evaluate(()=>window.scrollBy(0,Math.random()*200)); } catch(e){}
      continue;
    }
    await sleep(2000);
  }
  const info = await page.evaluate(() => ({ n: document.querySelectorAll('table').length, t: document.body?.innerText?.substring(0,200)||'' }));
  if (info.n >= 2) return;
  throw new Error('CF验证超时: ' + info.t.substring(0,100));
}

async function saveKV(txtUrl, ip, channelCount) {
  const ts = new Date().toISOString();
  const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;
  const entries = [
    ['txt_link', txtUrl],
    ['current_ip', ip],
    ['last_update', ts],
    ['channel_count', String(channelCount)],
    ['last_error', '']
  ];
  for (const [k,v] of entries) {
    const r = await fetch(base+k, { method:'PUT', headers:h, body:v });
    console.log(`  ${k}: ${(await r.json()).success?'OK':'FAIL'}`);
  }
}

main().catch(e => { console.error('异常:',e); process.exit(1); });
