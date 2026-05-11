/**
 * IPTV TXT 接口自动抓取脚本 v15
 * 
 * 根本原因发现：
 * 1. 首页gotoIP的token和详情页TXT接口的token是不同的！
 * 2. 直接用URL导航到详情页会"验证失败"，必须从首页点击跳转
 * 
 * 正确流程：
 * 1. 首页获取gotoIP token
 * 2. 在首页执行gotoIP()函数跳转到详情页
 * 3. 从详情页提取TXT接口的token（s=参数）
 * 4. 用正确的token访问TXT接口获取频道内容
 * 5. 保存到KV
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CF_ACCOUNT_ID = '13992e7b764637d462d3cf98f3a20086';
const CF_NAMESPACE_ID = '5a49325bf26b4106a0f497a6403a063d';
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== IPTV TXT 接口抓取 v15 ===');
  console.log('时间:', new Date().toISOString());

  if (!CF_API_TOKEN) {
    console.error('错误: 缺少 CF_API_TOKEN 环境变量');
    process.exit(1);
  }

  let browser;
  try {
    console.log('[1/4] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 180000,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);

    // 禁止弹出窗口（广告），拦截新窗口
    await page.evaluateOnNewDocument(() => {
      // 覆盖window.open，阻止广告弹出
      window.open = () => null;
    });

    console.log('[2/4] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('加载完成, URL:', page.url());

    console.log('等待 Cloudflare 验证...');
    await waitForCF(page);
    console.log('CF 验证已通过');

    // 提取首页所有Multicast IP的gotoIP token
    console.log('提取首页Multicast IP列表...');
    const ipList = await page.evaluate(() => {
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
        const m = onclick.match(/gotoIP\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/) ||
                  onclick.match(/gotoIP\(([^,]+),\s*([^)]+)\)/);
        if (m) {
          const status = cells.length >= 6 ? cells[5].textContent.trim() : '';
          const channelNum = cells.length >= 2 ? parseInt(cells[1].textContent.trim()) || 0 : 0;
          results.push({ ip, token: m[1], type: m[2], status, channelNum });
        }
      }
      return results;
    });
    console.log(`首页找到 ${ipList.length} 个Multicast IP`);

    // 过滤有效IP
    const validIPs = ipList.filter(ip =>
      ip.status !== '暂时失效' && ip.token && ip.channelNum > 0
    ).sort((a, b) => b.channelNum - a.channelNum);
    console.log(`有效IP: ${validIPs.length} 个`);
    for (const ip of validIPs.slice(0, 5)) {
      console.log(`  ${ip.ip}: ${ip.channelNum}个频道, ${ip.status}`);
    }

    if (validIPs.length === 0) {
      console.log('没有有效IP，退出');
      process.exit(0);
    }

    // 关键步骤：在首页执行gotoIP()跳转到详情页
    console.log('\n[3/4] 通过gotoIP()跳转详情页获取TXT接口token...');
    let bestContent = null;
    let bestCount = 0;
    let bestIP = '';

    for (let i = 0; i < validIPs.length && i < 3; i++) {
      const ip = validIPs[i];
      console.log(`\n尝试 ${i + 1}/3: ${ip.ip} (首页显示${ip.channelNum}个频道)`);

      try {
        // 确保在首页
        if (!page.url().includes('iptv.cqshushu.com/index.php') || page.url().includes('p=')) {
          console.log('  回到首页...');
          await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'networkidle2', timeout: 60000 });
          await waitForCF(page);
        }

        // 在首页执行gotoIP()函数（这会触发页面跳转到详情页）
        console.log(`  执行gotoIP('${ip.token}', '${ip.type}')...`);
        await page.evaluate((token, type) => {
          if (typeof gotoIP === 'function') {
            gotoIP(token, type);
          } else {
            // 如果gotoIP不存在，手动设置location
            window.location.href = `index.php?p=${token}&t=${type}`;
          }
        }, ip.token, ip.type);

        // 等待页面跳转到详情页
        await page.waitForFunction(() => {
          return window.location.href.includes('p=') && window.location.href.includes('t=');
        }, { timeout: 15000 });
        await sleep(3000);

        const debugInfo = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          linkCount: document.querySelectorAll('a').length,
          bodyPreview: document.body?.innerText?.substring(0, 200) || ''
        }));
        console.log(`  详情页: ${debugInfo.title}`);
        console.log(`  URL: ${debugInfo.url}`);
        console.log(`  链接数: ${debugInfo.linkCount}`);
        console.log(`  预览: ${debugInfo.bodyPreview.substring(0, 120)}`);

        if (debugInfo.title.includes('验证失败') || debugInfo.bodyPreview.includes('请求失败')) {
          console.log('  ❌ 详情页验证失败');
          continue;
        }

        // 等待详情页内容加载（可能需要点击"查看频道列表"）
        // 详情页的频道列表和TXT下载可能是AJAX异步加载的
        try {
          // 先等待基本内容
          await page.waitForFunction(() => {
            const body = document.body?.innerText || '';
            return body.includes('查看频道列表') || body.includes('TXT') || body.includes('下载');
          }, { timeout: 15000 });
        } catch (e) {
          console.log('  等待详情页基础内容超时');
        }

        await sleep(3000); // 额外等待AJAX

        // 尝试点击"📺 查看频道列表"按钮（如果存在）
        try {
          const clickedChannelList = await page.evaluate(() => {
            const links = document.querySelectorAll('a');
            for (const a of links) {
              if (a.textContent.includes('查看频道列表')) {
                a.click();
                return true;
              }
            }
            return false;
          });
          if (clickedChannelList) {
            console.log('  点击了"查看频道列表"');
            await sleep(5000); // 等待频道列表加载
          }
        } catch (e) { }

        // 滚动页面触发懒加载
        await page.evaluate(() => window.scrollBy(0, 500));
        await sleep(2000);

        // 输出当前页面所有链接用于调试
        const allLinksDebug = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a')).map(a => ({
            text: a.textContent.trim().substring(0, 40),
            href: (a.getAttribute('href') || '').substring(0, 80),
            onclick: (a.getAttribute('onclick') || '').substring(0, 80)
          }));
        });
        console.log(`  当前页面链接 (${allLinksDebug.length}个):`);
        for (const link of allLinksDebug) {
          if (link.text || link.href || link.onclick) {
            console.log(`    [${link.text}] href=${link.href} onclick=${link.onclick}`);
          }
        }

        // 提取TXT接口URL
        const txtInfo = await page.evaluate(() => {
          const links = document.querySelectorAll('a');
          for (const a of links) {
            const onclick = a.getAttribute('onclick') || '';
            const text = a.textContent.trim();
            if (text.includes('TXT接口') && onclick.includes('copyToClipboard')) {
              const m = onclick.match(/copyToClipboard\(['"]([^'"]+)['"]\)/);
              if (m) return { txtUrl: m[1], found: true };
            }
            const href = a.getAttribute('href') || '';
            if ((text.includes('TXT') || text.includes('txt')) && (href.includes('format=txt') || href.includes('download=txt'))) {
              return { txtUrl: 'https://iptv.cqshushu.com/index.php' + href.replace('download=txt', 'format=txt'), found: true };
            }
          }
          for (const a of links) {
            const href = a.getAttribute('href') || '';
            if (href.includes('s=') && (href.includes('format=txt') || href.includes('download=txt'))) {
              return { txtUrl: 'https://iptv.cqshushu.com/index.php' + href.replace('download=txt', 'format=txt'), found: true };
            }
          }
          return { found: false };
        });

        if (!txtInfo.found) {
          console.log('  ❌ 未找到TXT接口链接');
          continue;
        }

        console.log(`  TXT接口URL: ${txtInfo.txtUrl}`);

        // 访问TXT接口
        await page.goto(txtInfo.txtUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);

        const txtContent = await page.evaluate(() => document.body?.innerText || '');
        const lines = txtContent.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        const channelCount = lines.length;

        console.log(`  预览: ${txtContent.substring(0, 100)}`);
        console.log(`  频道行数: ${channelCount}`);

        if (channelCount > 0 && txtContent.includes('http')) {
          console.log(`  ✅ 成功! ${channelCount} 个频道!`);
          if (channelCount > bestCount) {
            bestContent = txtContent;
            bestCount = channelCount;
            bestIP = ip.ip;
          }
          if (channelCount >= 100) {
            console.log('  频道数足够，停止尝试');
            break;
          }
        } else {
          console.log(`  ❌ 0频道`);
        }

      } catch (err) {
        console.log(`  ❌ 失败: ${err.message}`);
      }
    }

    // 保存到KV
    console.log('\n[4/4] 保存到KV...');
    const ts = new Date().toISOString();
    const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
    const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;

    // 保存 IP 列表到 KV（供管理后台使用）
    const ipListForAdmin = validIPs.map(ip => ({
      ip: ip.ip,
      token: ip.token,
      type: ip.type,
      ch: ip.channelNum,
      region: ip.region,
      status: ip.status
    }));
    const r0 = await fetch(base + 'ip_list', { method: 'PUT', headers: h, body: JSON.stringify(ipListForAdmin) });
    console.log(`  ip_list (${ipListForAdmin.length}个IP): ${(await r0.json()).success ? 'OK' : 'FAIL'}`);

    if (bestContent && bestCount > 0) {
      const r1 = await fetch(base + 'txt_content', { method: 'PUT', headers: h, body: bestContent });
      console.log(`  txt_content (${bestContent.length}字节, ${bestCount}频道): ${(await r1.json()).success ? 'OK' : 'FAIL'}`);

      const meta = [
        ['last_update', ts],
        ['channel_count', String(bestCount)],
        ['current_ip', bestIP],
        ['total_ips', String(validIPs.length)],
        ['last_error', ''],
        ['scrape_version', 'v16']
      ];
      for (const [k, v] of meta) {
        const r = await fetch(base + k, { method: 'PUT', headers: h, body: v });
        console.log(`  ${k}: ${(await r.json()).success ? 'OK' : 'FAIL'}`);
      }
      console.log(`\n=== 成功! ${bestCount} 个频道, 来源IP: ${bestIP} ===`);
    } else {
      console.log('  ⚠️ 未能获取到频道内容');
      const meta = [
        ['last_update', ts],
        ['channel_count', '0'],
        ['last_error', ts + ': 所有IP均返回0频道'],
        ['scrape_version', 'v15']
      ];
      for (const [k, v] of meta) {
        await fetch(base + k, { method: 'PUT', headers: h, body: v });
      }
      console.log('=== 失败: 0频道 ===');
    }

  } catch (error) {
    console.error('抓取失败:', error.message);
    console.error(error.stack);
    try {
      const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
        method: 'PUT', headers: h,
        body: new Date().toISOString() + ': ' + error.message
      });
    } catch (e) { }
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

async function waitForCF(page) {
  for (let i = 0; i < 30; i++) {
    const info = await page.evaluate(() => ({
      t: document.body?.innerText?.substring(0, 100) || '',
      n: document.querySelectorAll('table').length
    }));
    if (info.n >= 2) return;
    if (info.t.includes('请稍候') || info.t.includes('Just a moment') || info.t.includes('Checking')) {
      if (i % 5 === 0) console.log(`  CF验证... (${i + 1}/30)`);
      await sleep(3000);
      try {
        for (let j = 0; j < 3; j++) {
          await page.mouse.move(Math.random() * 1920, Math.random() * 1080);
          await sleep(200);
        }
        await page.evaluate(() => window.scrollBy(0, Math.random() * 200));
      } catch (e) { }
      continue;
    }
    await sleep(2000);
  }
  const info = await page.evaluate(() => ({
    n: document.querySelectorAll('table').length,
    t: document.body?.innerText?.substring(0, 200) || ''
  }));
  if (info.n >= 2) return;
  throw new Error('CF验证超时: ' + info.t.substring(0, 100));
}

main().catch(e => { console.error('异常:', e); process.exit(1); });

