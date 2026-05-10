/**
 * IPTV TXT 接口自动抓取脚本 v8
 * puppeteer-extra + stealth 绕过 Cloudflare
 * 从首页获取所有IP的token，构造TXT链接
 * 在同一标签页验证TXT内容，如果0频道则回首页尝试下一个
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

    // 收集所有IP的token（从首页表格的onclick属性提取）
    console.log('[4/6] 提取所有IP token...');
    const allTokens = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (tables.length < 2) return [];
      // 第二个表格是Multicast
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
        if (m) {
          const status = cells.length >= 6 ? cells[5].textContent.trim() : '';
          const channelNum = cells.length >= 2 ? parseInt(cells[1].textContent.trim()) || 0 : 0;
          results.push({ ip, token: m[1], type: m[2], status, channelNum });
        }
      }
      return results;
    });
    console.log(`提取到 ${allTokens.length} 个Multicast IP token`);

    // 按状态和频道数排序：新上线优先，频道数多的优先
    allTokens.sort((a, b) => {
      // 排除暂时失效的
      if (a.status === '暂时失效' && b.status !== '暂时失效') return 1;
      if (a.status !== '暂时失效' && b.status === '暂时失效') return -1;
      // 新上线优先
      if (a.status === '新上线' && b.status !== '新上线') return -1;
      if (a.status !== '新上线' && b.status === '新上线') return 1;
      // 频道数多的优先
      return b.channelNum - a.channelNum;
    });

    console.log('排序后前5个:');
    for (let i = 0; i < Math.min(5, allTokens.length); i++) {
      console.log(`  #${i+1} ${allTokens[i].ip}: ${allTokens[i].channelNum}个节目, ${allTokens[i].status}`);
    }

    // 逐个验证TXT链接
    console.log('[5/6] 验证TXT链接...');
    let bestResult = null;
    for (let i = 0; i < Math.min(allTokens.length, 10); i++) {
      const ipInfo = allTokens[i];
      const txtUrl = `http://iptv.cqshushu.com/index.php?s=${ipInfo.token}&t=multicast&channels=1&format=txt`;
      console.log(`  #${i+1} ${ipInfo.ip} (${ipInfo.status}, 表格${ipInfo.channelNum}个): 验证TXT...`);

      // 在同一标签页导航到TXT链接（保持cookie）
      try {
        await page.goto(txtUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch(e) {
        console.log('    加载超时，继续...');
      }
      await sleep(3000);

      const txtContent = await page.evaluate(() => document.body?.innerText || '');
      if (!txtContent || txtContent.length < 10) {
        console.log('    页面为空');
        // 回首页继续下一个
        await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
        await waitForCF(page);
        continue;
      }

      // 检查节目数量
      const countMatch = txtContent.match(/#节目数量[：:]\s*(\d+)/);
      const declaredCount = countMatch ? parseInt(countMatch[1]) : 0;
      const urlCount = (txtContent.match(/http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g) || []).length;
      const channelCount = Math.max(declaredCount, urlCount);
      console.log(`    TXT声明: ${declaredCount}, URL数: ${urlCount}`);

      if (channelCount > 0) {
        bestResult = { txtUrl, ip: ipInfo.ip, channelCount, status: ipInfo.status };
        console.log(`    ✅ 找到有效IP: ${ipInfo.ip}, ${channelCount} 个频道`);
        break;
      } else {
        console.log('    ❌ 0个频道，跳过');
      }

      // 回首页继续下一个
      await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      await waitForCF(page);
    }

    if (!bestResult) {
      // 如果所有IP都没有频道，使用表格中频道数最多的IP
      const fallback = allTokens.find(ip => ip.channelNum > 0 && ip.status !== '暂时失效');
      if (fallback) {
        const txtUrl = `http://iptv.cqshushu.com/index.php?s=${fallback.token}&t=multicast&channels=1&format=txt`;
        bestResult = { txtUrl, ip: fallback.ip, channelCount: 0, status: fallback.status };
        console.log('警告: 所有TXT验证为0频道，使用表格最多的:', fallback.ip, fallback.channelNum);
      } else {
        throw new Error('所有IP均无有效频道');
      }
    }

    console.log('最终TXT链接:', bestResult.txtUrl);
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
