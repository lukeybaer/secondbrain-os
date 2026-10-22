#!/usr/bin/env node
'use strict';

const {
  calendarScopes,
  classifyMicrosoftError,
  decorateTokenRecord,
  parseArgs,
  pendingAuthPath,
  pollDeviceToken,
  probeCalendarAccess,
  readPendingAuth,
  redactSecrets,
  requestDeviceCode,
  resolveGraphConfig,
  tokenPath,
  writeJson,
} = require('./lib/outlook-calendar-probe');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const graphConfig = resolveGraphConfig({ args });
  const scopes = calendarScopes({ full: args.full });
  const pendingPath = pendingAuthPath(process.env, args.accountLabel);
  const savePath = tokenPath(process.env, args.accountLabel);

  if (!graphConfig.clientId && !args.poll) {
    console.error('[outlook-calendar-probe] missing Microsoft Graph client id');
    console.error('Set MS_GRAPH_CLIENT_ID or add microsoftGraphClientId to %APPDATA%\\secondbrain\\config.json.');
    console.error('This probe uses the Microsoft device-code OAuth flow against tenant:', graphConfig.tenant);
    process.exitCode = 2;
    return;
  }

  try {
    let token;
    let authMeta = { ...graphConfig, scopes };
    if (args.poll) {
      const pending = readPendingAuth(pendingPath);
      authMeta = {
        clientId: pending.clientId,
        tenant: pending.tenant,
        scopes: pending.scopes || scopes,
      };
      token = await pollDeviceToken({
        clientId: pending.clientId,
        tenant: pending.tenant,
        deviceCode: pending.deviceCode,
        interval: pending.interval,
        expiresIn: pending.expiresIn,
      });
    } else {
      const device = await requestDeviceCode({
        clientId: graphConfig.clientId,
        tenant: graphConfig.tenant,
        scopes,
      });

      const pending = {
        accountLabel: args.accountLabel,
        clientId: graphConfig.clientId,
        tenant: graphConfig.tenant,
        scopes,
        deviceCode: device.device_code,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        interval: device.interval,
        expiresIn: device.expires_in,
        createdAt: new Date().toISOString(),
      };
      writeJson(pendingPath, pending);

      console.log('[outlook-calendar-probe] Microsoft sign-in required');
      console.log(device.message || `Open ${device.verification_uri} and enter code ${device.user_code}`);
      console.log('[outlook-calendar-probe] pending auth saved:', pendingPath);
      console.log('[outlook-calendar-probe] after signing in, run: node scripts/outlook-calendar-probe.js --account-label ' + args.accountLabel + ' --poll' + (args.saveToken ? ' --save-token' : ''));

      if (!args.wait) return;
      token = await pollDeviceToken({
        clientId: graphConfig.clientId,
        tenant: graphConfig.tenant,
        deviceCode: device.device_code,
        interval: device.interval,
        expiresIn: device.expires_in,
      });
    }

    const probe = await probeCalendarAccess({
      accessToken: token.access_token,
      days: args.days,
      includeEvents: args.showEvents,
    });

    if (args.saveToken) {
      writeJson(savePath, decorateTokenRecord({
        accountLabel: args.accountLabel,
        clientId: authMeta.clientId,
        tenant: authMeta.tenant,
        scopes: authMeta.scopes,
        token,
      }));
      console.log('[outlook-calendar-probe] token saved for local Amy calendar access:', savePath);
    } else {
      console.log('[outlook-calendar-probe] token not saved; pass --save-token if this account should back Amy calendar reads.');
    }

    console.log(JSON.stringify(redactSecrets(probe), null, 2));
  } catch (err) {
    const classification = err.classification || classifyMicrosoftError(err.payload || err.message || err);
    console.error('[outlook-calendar-probe] failed:', err.message);
    console.error('[outlook-calendar-probe] classification:', classification);
    if (err.payload) {
      console.error(JSON.stringify(redactSecrets(err.payload), null, 2));
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
