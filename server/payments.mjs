import crypto from 'node:crypto';
import { HttpError } from './validation.mjs';

export const CHANNELS = ['wechat', 'alipay'];
export function validateChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new HttpError(400, 'invalid_channel', '请选择微信支付或支付宝');
  return channel;
}
export function makeOrderId() { return 'order_' + Date.now() + '_' + crypto.randomBytes(5).toString('hex'); }
