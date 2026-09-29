import { HttpError } from './validation.mjs';

export async function exchangeWechatCode(code, { appId, appSecret, fetchImpl = fetch }) {
  if (!appId || !appSecret) throw new HttpError(503, 'wechat_not_configured', '微信登录尚未配置');
  if (typeof code !== 'string' || !code.trim() || code.length > 512) {
    throw new HttpError(400, 'invalid_login_code', '请重新发起微信登录');
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' });
  let data;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error();
    data = await response.json();
  } catch {
    // Provider errors can contain the request URL and AppSecret.
    throw new HttpError(503, 'wechat_unavailable', '微信登录暂时不可用，请稍后重试');
  }
  if (data?.errcode === 40029 || data?.errcode === 40163) {
    throw new HttpError(401, 'wechat_code_expired', '登录凭证已失效，请重新登录');
  }
  if ((data?.errcode && data.errcode !== 0) || typeof data?.openid !== 'string' || !data.openid.trim() || typeof data?.session_key !== 'string' || !data.session_key) {
    throw new HttpError(503, 'wechat_login_failed', '微信登录未完成，请稍后重试');
  }
  return data.openid;
}
