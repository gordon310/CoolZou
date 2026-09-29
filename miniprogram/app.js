const cloud = {
  enabled: true,
  env: 'prod-d5gx1s4o899f5b776',
  service: 'express-5r3p',
  publicBaseUrl: 'https://express-5r3p-314278-7-1488722877.sh.run.tcloudbase.com'
};

App({
  onLaunch() {
    if (cloud.enabled && wx.cloud) wx.cloud.init({ env: cloud.env, traceUser: true });
  },
  globalData: {
    apiBaseUrl: 'http://127.0.0.1:4317',
    cloud,
    token: '',
    config: null
  }
});
