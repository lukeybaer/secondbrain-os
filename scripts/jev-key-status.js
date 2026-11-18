'use strict';

const broker = require('./lib/credential-broker.js');

const result = broker.diagnoseCredential('typesafe', 'apiKey');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.state === 'runtime_unwired') process.exitCode = 1;
