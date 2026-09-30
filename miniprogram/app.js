const config = require('./config');
const { createClient } = require('./utils/client');

App({
  onLaunch() {
    this.client = createClient(wx, config);
  }
});
