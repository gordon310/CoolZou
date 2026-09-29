import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);

function copyHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hopHeaders.has(name.toLowerCase())));
}

export function createGateway(options = {}) {
  const upstreamOrigin = options.upstreamOrigin || process.env.UPSTREAM_ORIGIN;
  const gatewaySecret = options.gatewaySecret || process.env.GATEWAY_SECRET;
  const logger = options.logger || console;
  if (!upstreamOrigin) throw new Error('UPSTREAM_ORIGIN is required');
  if (!gatewaySecret) throw new Error('GATEWAY_SECRET is required');

  const upstream = new URL(upstreamOrigin);
  if (upstream.protocol !== 'https:' && !options.allowInsecureUpstream) throw new Error('UPSTREAM_ORIGIN must use HTTPS');
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('Unsupported upstream protocol');
  const caBase64 = options.caBase64 ?? process.env.UPSTREAM_CA_B64;
  const ca = caBase64 ? Buffer.from(caBase64, 'base64') : undefined;
  const transport = upstream.protocol === 'https:' ? https : http;
  const requireWechatContext = options.requireWechatContext ?? (process.env.REQUIRE_WECHAT_CONTEXT ? process.env.REQUIRE_WECHAT_CONTEXT === 'true' : process.env.NODE_ENV === 'production');
  let active = 0;

  const server = http.createServer((req, res) => {
    let incoming;
    try { incoming = new URL(req.url || '/', 'http://gateway.local'); }
    catch { res.writeHead(400); return res.end('Invalid request URL'); }
    if (incoming.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end('{"ok":true}');
    }
    const apiPath = incoming.pathname.startsWith('/api/');
    const mediaPath = incoming.pathname.startsWith('/media/assets/');
    const uploadPath = incoming.pathname === '/upload/assets';
    if (!apiPath && !mediaPath && !uploadPath && !incoming.pathname.startsWith('/download/')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      return res.end('{"error":{"code":"not_found","message":"接口不存在"}}');
    }
    if (uploadPath && !String(req.headers.authorization || '').startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end('{"error":{"code":"unauthorized","message":"请先登录"}}');
    }
    if (apiPath && requireWechatContext && !req.headers['x-wx-openid']) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      return res.end('{"error":{"code":"wechat_context_required","message":"请求入口不受信任"}}');
    }

    if (active >= 64 || Number(req.headers['content-length']) > 2_000_000) {
      const busy = active >= 64;
      res.writeHead(busy ? 503 : 413, { 'content-type': 'application/json', connection: 'close', 'retry-after': '3' });
      return res.end(JSON.stringify({ error: { code: busy ? 'gateway_busy' : 'body_too_large', message: busy ? '当前访问较多，请稍后重试' : '上传内容过大' } }));
    }
    active++;
    res.once('close', () => { active--; });

    const headers = copyHeaders(req.headers);
    delete headers.origin;
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    headers.host = upstream.host;
    headers['x-coolzou-gateway'] = gatewaySecret;

    const proxy = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: (uploadPath ? '/api/assets/upload' : mediaPath ? incoming.pathname.replace(/^\/media/, '/api') : incoming.pathname) + incoming.search,
      headers,
      ca,
      rejectUnauthorized: true,
      timeout: options.timeoutMs || 60_000
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode || 502, copyHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
      upstreamResponse.on('error', error => res.destroy(error));
    });

    proxy.on('timeout', () => proxy.destroy(new Error('upstream timeout')));
    proxy.on('error', error => {
      logger.error('Gateway upstream request failed:', error.code || error.message);
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":{"code":"gateway_unavailable","message":"生成服务暂时不可用"}}');
    });
    let bodyBytes = 0;
    req.on('data', chunk => {
      bodyBytes += chunk.length;
      if (bodyBytes <= 2_000_000 || res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end('{"error":{"code":"body_too_large","message":"上传内容过大"}}');
      }
      proxy.destroy();
    });
    req.once('aborted', () => proxy.destroy());
    res.once('close', () => { if (!res.writableFinished) proxy.destroy(); });
    req.pipe(proxy);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.setTimeout(65_000, socket => socket.destroy());
  server.maxConnections = 128;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 80);
  createGateway().listen(port, '0.0.0.0', () => console.log(`CoolZou gateway listening on ${port}`));
}
