#!/usr/bin/env node
'use strict';

const program = require('../src/cli');

program.parseAsync(process.argv).catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
