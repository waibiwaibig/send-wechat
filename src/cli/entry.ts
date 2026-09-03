#!/usr/bin/env node

import { Command, CommanderError, Option } from "commander";

import { APP_VERSION } from "../app/version.js";
import { runCommand, humanSuccess } from "./operations.js";
import {
  CliFailure,
  type CliDependencies,
  type GlobalOptions,
  classifyExitCode,
  codeFromError,
  ensureNodeVersion,
  isRecord,
  localizedMessage,
  normalizeFinal,
  writeOutput,
} from "./contracts.js";
import { createContext, type CliContext } from "./context.js";

function buildProgram(
  context: CliContext,
  jsonRequested: boolean,
  onResult: (command: string, result: unknown) => Promise<void>,
): Command {
  const program = new Command();
  program
    .name("send-wechat")
    .description("Send text or files to the one Weixin user bound by QR login.")
    .version(APP_VERSION)
    .helpCommand(false)
    .option("--json", "emit one JSON result")
    .addOption(
      new Option("--lang <locale>", "output language")
        .choices(["zh-CN", "en"])
        .default("zh-CN"),
    )
    .configureOutput({
      writeOut: (text) => {
        void writeOutput(
          jsonRequested ? context.output().stderr : context.output().stdout,
          text,
        );
      },
      writeErr: () => undefined,
    })
    .exitOverride();

  const action =
    (command: string) =>
    async (options: Record<string, unknown> = {}): Promise<void> => {
      if (command === "setup" && jsonRequested && options.pairStdout === true)
        throw new CliFailure("USAGE_ERROR", 2);
      await onResult(command, await runCommand(context, command, options));
    };
  program
    .command("setup")
    .option("--pair-stdin", "read the pairing invitation from stdin")
    .addOption(
      new Option(
        "--pair-stdout",
        "write a raw pairing invitation to stdout",
      ).hideHelp(),
    )
    .option("--qr-file <path>", "write QR as PNG")
    .action(action("setup"));
  program
    .command("send")
    .option("--text <text>", "text to send")
    .option("--stdin", "read text from stdin")
    .option("--file <path>", "file to send")
    .option("--idempotency-key <key>", "local duplicate-suppression key")
    .action(action("send"));
  program.command("status").action(action("status"));
  program.command("doctor").action(action("doctor"));
  program.command("reset").action(action("reset"));

  const service = new Command("service").description(
    "manage the background service",
  );
  for (const operation of [
    "install",
    "start",
    "stop",
    "restart",
    "uninstall",
  ] as const) {
    service.command(operation).action(async () => {
      await context.assertHubServiceOperation();
      if (operation === "install") {
        await context.prepareInstall();
        await context.getServiceManager().install();
      } else {
        await context.getServiceManager()[operation]();
      }
      await onResult(`service ${operation}`, {
        ok: true,
        command: "service",
        result: { operation },
      });
    });
  }
  program.addCommand(service);
  program.command("internal-daemon", { hidden: true }).action(async () => {
    await context.runDaemon();
  });
  return program;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const context = createContext(dependencies);
  const io = context.output();
  const jsonRequested = argv.includes("--json");
  const languageArgument = argv.find(
    (argument) => argument === "--lang" || argument.startsWith("--lang="),
  );
  const languageIndex = argv.indexOf("--lang");
  const requestedLanguage = languageArgument?.startsWith("--lang=")
    ? languageArgument.slice("--lang=".length)
    : languageIndex >= 0
      ? argv[languageIndex + 1]
      : undefined;
  const globalOptions: GlobalOptions = {
    json: jsonRequested,
    lang: requestedLanguage === "en" ? "en" : "zh-CN",
  };
  context.setLanguage(globalOptions.lang ?? "zh-CN");
  const commands = new Set([
    "setup",
    "send",
    "status",
    "doctor",
    "reset",
    "service",
    "internal-daemon",
  ]);
  let commandName =
    argv.find((argument) => commands.has(argument)) ?? "send-wechat";
  let actionExitCode = 0;
  try {
    ensureNodeVersion(dependencies.nodeVersion ?? process.versions.node);
    const program = buildProgram(
      context,
      jsonRequested,
      async (command, result) => {
        commandName = command;
        if (isRecord(result) && result.pairStdout === true) {
          if (jsonRequested) throw new CliFailure("USAGE_ERROR", 2);
          const setupResult = isRecord(result.result) ? result.result : {};
          const invitation = setupResult.invitation;
          if (typeof invitation !== "string")
            throw new CliFailure("PAIRING_INVITATION_INVALID", 2);
          await writeOutput(io.stdout, `${invitation}\n`);
          return;
        }
        const finalResult = normalizeFinal(command, result);
        const failed = finalResult.ok === false;
        if (failed) {
          const error = isRecord(finalResult.error) ? finalResult.error : {};
          const code =
            typeof error.code === "string" ? error.code : "LOCAL_FAILURE";
          actionExitCode = command === "doctor" ? 3 : classifyExitCode(code);
        }
        if (globalOptions.json === true) {
          await writeOutput(io.stdout, `${JSON.stringify(finalResult)}\n`);
        } else if (failed) {
          const error = isRecord(finalResult.error) ? finalResult.error : {};
          const code =
            typeof error.code === "string" ? error.code : "LOCAL_FAILURE";
          await writeOutput(
            io.stderr,
            `${localizedMessage(code, globalOptions.lang ?? "zh-CN")}\n`,
          );
        } else {
          await writeOutput(
            io.stdout,
            humanSuccess(command, result, globalOptions.lang ?? "zh-CN"),
          );
        }
      },
    );
    await program.parseAsync(["node", "send-wechat", ...argv]);
    return actionExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      const informational =
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version";
      if (jsonRequested && informational)
        await writeOutput(
          io.stdout,
          `${JSON.stringify({ schemaVersion: 1, ok: true, command: commandName })}\n`,
        );
      if (!informational) {
        if (jsonRequested) {
          await writeOutput(
            io.stdout,
            `${JSON.stringify({ schemaVersion: 1, ok: false, command: commandName, error: { code: "USAGE_ERROR", retryable: false } })}\n`,
          );
        } else {
          await writeOutput(
            io.stderr,
            `${localizedMessage("USAGE_ERROR", globalOptions.lang ?? "zh-CN")}\n`,
          );
        }
      }
      return informational ? 0 : 2;
    }
    const code = codeFromError(error);
    const exitCode =
      error instanceof CliFailure ? error.exitCode : classifyExitCode(code);
    if (jsonRequested)
      await writeOutput(
        io.stdout,
        `${JSON.stringify({ schemaVersion: 1, ok: false, command: commandName, error: { code, retryable: false } })}\n`,
      );
    else
      await writeOutput(
        io.stderr,
        `${localizedMessage(code, globalOptions.lang === "en" ? "en" : "zh-CN")}\n`,
      );
    return exitCode;
  }
}

export { buildProgram };
export type { CliDependencies, CliIO, QrRenderer } from "./contracts.js";
