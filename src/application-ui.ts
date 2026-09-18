// 此页面只读；令牌只存在页面内存，不进 URL、HTML、localStorage 或剪贴板。
export const APPLICATION_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DesireCore Control</title><link rel="stylesheet" href="/app.css"></head>
<body><main><header><p class="eyebrow">EXTERNAL AGENT CONTROL · 独立应用</p><h1>DesireCore Control</h1>
<p>让外部智能体控制本机 DesireCore。MCP 是对外协议，不是内部工具安装方式。</p></header>
<section><h2>连接本机应用</h2><p>输入本应用的认证文件内容。不是 OpenAI API Key；不会保存到浏览器存储。</p>
<form id="connect"><label for="token">本机访问令牌</label><div class="row"><input id="token" type="password" autocomplete="off" required maxlength="256"><button>连接 / 刷新</button><button id="disconnect" type="button">断开</button></div></form>
<p id="status" role="status" aria-live="polite">未连接。管理页面可打开不代表已获得控制权限。</p></section>
<section><h2>本机实例</h2><p>只读刷新，不会启动、停止或自动选择任何 DesireCore 实例。</p><div id="instances"></div></section>
<section><h2>连接外部智能体</h2><p>外部客户端使用下列端点；ChatGPT 的隧道转发到此端点。不要将本应用注册到 DesireCore 内部 MCP 列表。</p><pre id="config">连接后显示本机地址与权限状态。令牌不会显示在这里。</pre>
<p>默认只读。需要输入或 JavaScript 控制时，在本机终端重启并显式添加 <code>--allow-control</code>。此页面不能远程开启控制。</p></section>
<!-- TUNNEL -->
<footer>退出本应用不关闭 DesireCore；关闭所有 DesireCore 实例也不退出本应用。</footer></main><script src="/app.js" defer></script></body></html>`
export const APPLICATION_CSS = `:root{font-family:system-ui,sans-serif;color:#202734;background:#f4f6fa}body{margin:0}main{max-width:960px;margin:40px auto;padding:0 24px}header{margin-bottom:32px}h1{font-size:36px;letter-spacing:-1px}h2{font-size:20px;margin-top:0}.eyebrow{font-size:12px;letter-spacing:2px;color:#526078}section{background:white;padding:24px;border:1px solid #dde3eb;border-radius:12px;margin-bottom:20px}p{line-height:1.6}label{display:block;margin-bottom:8px}.row{display:flex;gap:12px;flex-wrap:wrap}input{flex:1;min-width:180px;border:1px solid #a7b3c5;border-radius:6px;padding:10px}button{border:1px solid #a7b3c5;border-radius:6px;padding:10px 16px;cursor:pointer;background:#eef2f8}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f4f8;padding:16px;border-radius:8px}article{padding:16px 0;border-top:1px solid #e4e8ef}article p{margin:4px 0;overflow-wrap:anywhere}footer{color:#526078;font-size:13px;margin:32px 0}`
export const APPLICATION_JS = `(() => {
  const byId = (id) => document.getElementById(id);
  let generation = 0;
  let controller;
  const clear = () => { generation++; controller?.abort(); byId('token').value = ''; byId('instances').replaceChildren(); byId('config').textContent = '未连接'; };
  byId('disconnect').addEventListener('click', () => { clear(); byId('status').textContent = '已断开，页面令牌已清除'; });
  byId('connect').addEventListener('submit', async (event) => {
    event.preventDefault();
    controller?.abort(); controller = new AbortController();
    const epoch = ++generation;
    const token = byId('token').value.trim();
    byId('token').value = '';
    byId('instances').replaceChildren(); byId('config').textContent = '读取中';
    byId('status').textContent = '正在只读检查实例…';
    try {
      const response = await fetch('/api/overview', { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('连接失败：HTTP ' + response.status);
      const overview = await response.json();
      if (epoch !== generation) return;
      byId('config').textContent = JSON.stringify({ application: overview.application.name, endpoint: overview.mcpUrl, allowControl: overview.allowControl, authentication: 'Bearer <本机令牌>', audience: overview.application.audience }, null, 2);
      for (const instance of overview.instances) {
        const card = document.createElement('article');
        const title = document.createElement('strong'); title.textContent = instance.label; card.append(title);
        for (const text of [instance.home, 'CDP: ' + (instance.cdpPort ?? '不可用'), 'instanceId: ' + (instance.instanceId ?? '无'), instance.available ? '可用' : instance.reason]) {
          if (!text) continue;
          const line = document.createElement('p'); line.textContent = text; card.append(line);
        }
        byId('instances').append(card);
      }
      byId('status').textContent = (overview.instances.length ? '已发现 ' + overview.instances.length + ' 个名录条目。' : '没有发现实例；应用正常运行。') + ' 刷新时请重新输入令牌。';
      if (overview.warnings.length) byId('status').textContent += ' ' + overview.warnings.join('；');
    } catch (error) {
      if (epoch !== generation) return;
      byId('status').textContent = error instanceof Error ? error.message : '检查失败';
    }
  });
})();`
