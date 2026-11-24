const config = require('./config');

App({
  globalData: {},
  onLaunch() {
    if (!wx.cloud) return;
    const options = { traceUser: true };
    if (config && config.cloudEnvId) options.env = config.cloudEnvId;
    try { wx.cloud.init(options); this.globalData.cloudInited = true; } catch (error) {}
  },
});
