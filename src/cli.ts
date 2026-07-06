#!/usr/bin/env node
import { Command } from 'commander';
import { VERSION } from './index.js';
import { runAnalyze } from './run.js';
import { FlakehoundError } from './util/errors.js';

const program = new Command();

program
  .name('flakehound')
  .description('Root-cause analysis for flaky tests — clusters failures by underlying cause.')
  .version(VERSION);

program
  .command('analyze')
  .description('Analyze a history of JUnit XML runs')
  .option('-c, --config <path>', 'path to flakehound config file')
  .option('-i, --input <glob>', 'glob of JUnit XML files (overrides config)')
  .option('-b, --baseline <path>', 'previous flakehound.report.json for the CI gate')
  .option('--no-ai', 'disable the AI interpretation layer')
  .option('--json <path>', 'output path for flakehound.report.json')
  .action(
    async (opts: {
      config?: string;
      input?: string;
      baseline?: string;
      ai: boolean;
      json?: string;
    }) => {
      try {
        const { exitCode } = await runAnalyze({
          ...(opts.config !== undefined ? { configPath: opts.config } : {}),
          overrides: {
            ...(opts.input !== undefined ? { input: opts.input } : {}),
            ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
            ...(opts.json !== undefined ? { output: opts.json } : {}),
            ...(opts.ai === false ? { ai: false } : {}),
          },
        });
        process.exitCode = exitCode;
      } catch (error) {
        // Exit 2 = the tool broke (parse error, bad config) — distinct from
        // exit 1 (a new regression was found) so CI can tell them apart.
        if (error instanceof FlakehoundError) {
          console.error(`flakehound: ${error.message}`);
        } else {
          console.error(error);
        }
        process.exitCode = 2;
      }
    },
  );

program.parseAsync(process.argv);
