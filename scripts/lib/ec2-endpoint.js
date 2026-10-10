'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_EC2_SSH_TARGET = 'ec2-user@ExampleCo';

function ec2SshTarget(env = process.env) {
  return (
    env.AMY_DESKTOP_RELAY_SSH_TARGET ||
    env.SB_EC2_TARGET ||
    env.SB_DEPLOY_HOST ||
    env.EC2_HOST ||
    DEFAULT_EC2_SSH_TARGET
  );
}

function ec2SshKey(env = process.env, existsFn = fs.existsSync) {
  return [
    env.AMY_DESKTOP_RELAY_SSH_KEY,
    env.SB_EC2_SSH_KEY,
    env.SB_DEPLOY_KEY,
    env.EC2_SSH_KEY,
    path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem'),
    path.join(os.homedir(), '.ssh', 'sb-key.pem'),
  ].filter(Boolean).find((file) => existsFn(file));
}

module.exports = { DEFAULT_EC2_SSH_TARGET, ec2SshKey, ec2SshTarget };
