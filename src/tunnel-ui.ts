// 静态管理界面：秘密仅在本机页面内存中，绝不进入 URL、存储、剪贴板或 MCP 工具。
export const TUNNEL_HTML = `<section id="chatgpt-tunnel"><h2>ChatGPT 安全隧道</h2>
<p>本应用可托管已安装的官方 tunnel-client。先在 <a href="https://platform.openai.com/settings/organization/tunnels" target="_blank" rel="noreferrer">Platform</a> 创建 Tunnel 并关联目标 ChatGPT 工作区，准备具有 Tunnels Read + Use 的运行 key。
<a href="https://github.com/openai/tunnel-client/releases" target="_blank" rel="noreferrer">安装官方客户端</a>，默认从 PATH 查找；也可启动应用时指定 <code>--tunnel-client &lt;绝对路径&gt;</code>。</p>
<form id="tunnel-login"><label for="tunnel-admin">本次应用的隧道管理令牌（终端显示 admin-token 文件位置）</label><div class="row"><input id="tunnel-admin" type="password" autocomplete="off" maxlength="256" required><button>连接管理 / 刷新</button><button id="tunnel-lock" type="button">清除页面凭据</button></div></form>
<p>管理令牌不是 MCP token，也不是 OpenAI key；外部客户端无权管理隧道。凭据只在页面内存，关闭或锁定页面即清除。清除页面凭据不会停止正在运行的隧道。</p>
<form id="tunnel-start"><label for="tunnel-id">Tunnel ID</label><input id="tunnel-id" required pattern="tunnel_[a-f0-9]{32}" maxlength="39" placeholder="tunnel_…" autocomplete="off">
<label for="tunnel-key">OpenAI 运行 API key（仅本次启动；已配置环境变量或 key 文件时可留空）</label><input id="tunnel-key" type="password" maxlength="4096" autocomplete="off">
<p>启动后，关联的外部客户端可访问本应用已开放的工具。这里不能开启 <code>--allow-control</code>。</p>
<div class="row"><button id="tunnel-start-button" disabled>启动隧道</button><button id="tunnel-stop" type="button" disabled>停止隧道</button></div></form>
<pre id="tunnel-state" role="status" aria-live="polite">未连接管理。应用和 DesireCore 均可独立运行。</pre>
<p id="tunnel-guidance">进程运行不等于隧道就绪；就绪也不等于 ChatGPT 工具调用成功。凭据错误或客户端缺失不会退出本应用。</p>
<pre id="tunnel-connection">连接管理后显示 ChatGPT 配置。</pre></section>`

export const TUNNEL_JS = `(() => {
  const el = (id) => document.getElementById(id);
  if (!el('chatgpt-tunnel')) return;
  let admin = '', generation = 0, timer, controller, busy = false;
  const enable = () => { el('tunnel-start-button').disabled = !admin || busy; el('tunnel-stop').disabled = !admin || busy; };
  const lock = () => { generation++; admin = ''; clearTimeout(timer); controller?.abort(); el('tunnel-admin').value = ''; el('tunnel-key').value = ''; el('tunnel-connection').textContent = '凭据已清除'; el('tunnel-state').textContent = '管理已断开；此操作不停止隧道。'; enable(); };
  const render = (data) => {
    el('tunnel-state').textContent = JSON.stringify(data, null, 2);
    if (!el('tunnel-id').value && data.configuredTunnelId) el('tunnel-id').value = data.configuredTunnelId;
    el('tunnel-guidance').textContent = data.ready === true ? '隧道客户端报告就绪。请在 ChatGPT 中连接并实际调用 desirecore_list_instances 完成验收。' : '尚未确认隧道就绪。进程运行不代表连接成功；检查 ID、权限、网络和安装路径。';
    const id = data.tunnelId || data.configuredTunnelId;
    el('tunnel-connection').textContent = id ? JSON.stringify({ name: 'DesireCore Control', connection: 'Tunnel', tunnelId: id, authentication: 'None' }, null, 2) : '填入 Platform 分配的 Tunnel ID，启动后在 ChatGPT 新建 Tunnel 连接；认证选 None，本应用自动注入本机认证。';
  };
  const request = async (action, body) => {
    if (!admin || busy) return;
    busy = true; enable(); clearTimeout(timer);
    const epoch = generation;
    controller = new AbortController();
    try {
      const response = await fetch('/api/tunnel/' + action, { method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (epoch !== generation) return;
      if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
      render(data);
    } catch (error) {
      if (epoch === generation) el('tunnel-state').textContent = error instanceof Error ? error.message : '管理请求失败；中断并不撤销已开始的操作，请刷新状态。';
    } finally {
      busy = false; enable();
      if (admin && epoch === generation) timer = setTimeout(() => { void request('status'); }, 4000);
    }
  };
  el('tunnel-login').addEventListener('submit', (event) => { event.preventDefault(); if (busy) return; admin = el('tunnel-admin').value.trim(); el('tunnel-admin').value = ''; generation++; void request('status'); });
  el('tunnel-start').addEventListener('submit', (event) => {
    event.preventDefault(); if (busy || !admin) return;
    const body = { tunnelId: el('tunnel-id').value.trim() };
    const key = el('tunnel-key').value.trim(); el('tunnel-key').value = '';
    if (key) body.apiKey = key;
    void request('start', body);
  });
  el('tunnel-stop').addEventListener('click', () => { void request('stop'); });
  el('tunnel-lock').addEventListener('click', lock);
  window.addEventListener('pagehide', lock);
})();`
