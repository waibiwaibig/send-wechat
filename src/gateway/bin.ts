#!/usr/bin/env node

import { runGatewayCli } from "./cli.js";

void runGatewayCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 5;
  },
);
