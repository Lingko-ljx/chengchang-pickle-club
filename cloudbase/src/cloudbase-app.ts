import cloudbase from "@cloudbase/node-sdk";

export const cloudbaseApp = cloudbase.init({
  env: cloudbase.SYMBOL_CURRENT_ENV,
  keepalive: true,
});

export const database = cloudbaseApp.database();
