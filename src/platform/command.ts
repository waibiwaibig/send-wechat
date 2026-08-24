import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandOptions = {
  readonly shell?: false;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export interface CommandRunner {
  run(
    file: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
}

export type CommandRunnerLike = CommandRunner | CommandRunner["run"];

export function runWithCommandRunner(
  runner: CommandRunnerLike,
  file: string,
  args: readonly string[],
  options: CommandOptions = { shell: false },
): Promise<CommandResult> {
  if (typeof runner === "function") return runner(file, args, options);
  return runner.run(file, args, options);
}

export const defaultCommandRunner: CommandRunner = {
  run(file, args, options = { shell: false }) {
    const execOptions: ExecFileOptions = {
      shell: false,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    };

    return new Promise<CommandResult>((resolve, reject) => {
      execFile(file, [...args], execOptions, (error, stdout, stderr) => {
        const output = {
          stdout: String(stdout),
          stderr: String(stderr),
        };

        if (error !== null && error.code === "ENOENT") {
          const commandError = new Error(error.message);
          Object.assign(commandError, { code: error.code, ...output });
          reject(commandError);
          return;
        }

        resolve({
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          ...output,
        });
      });
    });
  },
};
