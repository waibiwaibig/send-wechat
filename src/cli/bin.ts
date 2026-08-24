#!/usr/bin/env node

import { runCli } from "./entry.js";

void runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  () => {
    process.exitCode = 5;
  },
);
